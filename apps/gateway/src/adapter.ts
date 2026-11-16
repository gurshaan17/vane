import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'undici';
import { z } from 'zod';
import { GatewayError } from './errors.js';
import type { ResolvedConfig } from './config.js';

export interface UpstreamRequest {
  /** Canonical ID; translated to the worker's configured model name. */
  model: string;
  body: Record<string, unknown>;
  requestId?: string;
  traceparent?: string;
}
export interface UpstreamResponse {
  statusCode: number;
  body: Record<string, unknown>;
}
export interface UpstreamStream {
  statusCode: number;
  body: import('node:stream').Readable;
}
export interface WorkerAdapter {
  chatStream(
    request: UpstreamRequest,
    signal: AbortSignal,
  ): Promise<UpstreamStream>;
  chat(
    request: UpstreamRequest,
    signal: AbortSignal,
  ): Promise<UpstreamResponse>;
  listModels(signal: AbortSignal): Promise<string[]>;
  health(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number }>;
  close(): Promise<void>;
}

export class UpstreamError extends GatewayError {
  constructor(
    public readonly kind: 'connect' | 'timeout' | 'http' | 'stream',
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(
      kind === 'timeout' ? 504 : 502,
      kind === 'timeout' ? 'upstream_timeout' : 'upstream_error',
      kind === 'timeout'
        ? 'Upstream request timed out'
        : 'Upstream request failed',
      'server_error',
    );
  }
}

function traceparent(inbound?: string) {
  if (inbound && /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/.test(inbound)) {
    const [, trace, parent] = inbound.split('-');
    if (trace !== '0'.repeat(32) && parent !== '0'.repeat(16)) return inbound;
  }
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

const jsonObject = z.record(z.unknown());
const modelList = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/** OpenAI-compatible transport for the mock worker; one keep-alive pool per worker. */
export class MockWorkerAdapter implements WorkerAdapter {
  private readonly pool: Pool;
  private readonly basePath: string;
  private closing?: Promise<void>;

  constructor(
    private readonly worker: ResolvedConfig['workers'][number],
    timeouts: Pick<
      ResolvedConfig['resilience'],
      'connectTimeoutMs' | 'firstByteTimeoutMs'
    >,
  ) {
    const url = new URL(worker.baseUrl);
    this.basePath = url.pathname.replace(/\/+$/, '');
    this.pool = new Pool(url.origin, {
      connections: worker.maxConcurrency,
      pipelining: 1,
      connectTimeout: timeouts.connectTimeoutMs,
      headersTimeout: timeouts.firstByteTimeoutMs,
      // JSON uses the total deadline; the streaming proxy owns SSE body timers.
      bodyTimeout: 0,
    });
  }

  private async request(
    path: string,
    signal: AbortSignal,
    request?: UpstreamRequest,
    streaming = false,
  ) {
    signal.throwIfAborted();
    let receivedHeaders = false;
    try {
      // Construct an allowlist; neither client Authorization nor transport headers enter here.
      const headers: Record<string, string> = {
        accept: streaming ? 'text/event-stream' : 'application/json',
        traceparent: traceparent(request?.traceparent),
        ...(request?.requestId ? { 'x-request-id': request.requestId } : {}),
        ...(this.worker.apiKey
          ? { authorization: `Bearer ${this.worker.apiKey}` }
          : {}),
      };
      let body: string | undefined;
      if (request) {
        const payload = { ...request.body };
        delete payload.gateway;
        payload.model = this.worker.models[request.model];
        body = JSON.stringify(payload);
        headers['content-type'] = 'application/json';
      }
      const response = await this.pool.request({
        path: `${this.basePath}${path}`,
        method: request ? 'POST' : 'GET',
        headers,
        body,
        signal,
        // No redirect following: worker credentials must stay on the configured origin.
      });
      receivedHeaders = true;
      // Discarded HTTP error bodies can emit an asynchronous abort error on destroy.
      response.body.on('error', () => {});
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // Destroy instead of buffering an error body that could contain credentials or never end.
        response.body.destroy();
        throw new UpstreamError(
          'http',
          [429, 502, 503, 504].includes(response.statusCode),
          response.statusCode,
        );
      }
      if (streaming) {
        if (
          !String(response.headers['content-type']).startsWith(
            'text/event-stream',
          )
        ) {
          response.body.destroy();
          throw new UpstreamError('stream', false);
        }
        return { statusCode: response.statusCode, body: response.body };
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) throw new UpstreamError('stream', false);
          chunks.push(chunk);
        }
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        return { statusCode: response.statusCode, body };
      } finally {
        if (!response.body.readableEnded) response.body.destroy();
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof UpstreamError) throw error;
      const code = (error as { code?: string })?.code;
      if (
        [
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
        ].includes(code ?? '')
      )
        throw new UpstreamError('timeout', true);
      throw new UpstreamError(
        receivedHeaders ? 'stream' : 'connect',
        [
          'ECONNREFUSED',
          'ECONNRESET',
          'ENOTFOUND',
          'EAI_AGAIN',
          'UND_ERR_SOCKET',
        ].includes(code ?? ''),
      );
    }
  }

  async chatStream(
    request: UpstreamRequest,
    signal: AbortSignal,
  ): Promise<UpstreamStream> {
    if (!Object.hasOwn(this.worker.models, request.model))
      throw new GatewayError(
        503,
        'no_healthy_worker',
        'The configured worker does not serve this model',
        'server_error',
      );
    return (await this.request(
      '/v1/chat/completions',
      signal,
      request,
      true,
    )) as UpstreamStream;
  }

  async chat(
    request: UpstreamRequest,
    signal: AbortSignal,
  ): Promise<UpstreamResponse> {
    if (!Object.hasOwn(this.worker.models, request.model))
      throw new GatewayError(
        503,
        'no_healthy_worker',
        'The configured worker does not serve this model',
        'server_error',
      );
    if (request.body.stream === true)
      throw new GatewayError(
        400,
        'invalid_request',
        'Streaming is not implemented yet',
      );
    const response = await this.request(
      '/v1/chat/completions',
      signal,
      request,
    );
    const parsed = jsonObject.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('stream', false);
    const body = parsed.data;
    // Report the public canonical ID rather than leaking a worker-specific model name.
    if (typeof body.model === 'string') body.model = request.model;
    return { statusCode: response.statusCode, body };
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await this.request('/v1/models', signal);
    const parsed = modelList.safeParse(response.body);
    if (!parsed.success) throw new UpstreamError('stream', false);
    return [...new Set(parsed.data.data.map((model) => model.id))];
  }

  async health(signal: AbortSignal) {
    const startedAt = performance.now();
    try {
      // Mock /health speaks JSON; malformed responses count as failed probes.
      const response = await this.request('/health', signal);
      const body = jsonObject.safeParse(response.body);
      return {
        ok: body.success && body.data.ok === true,
        latencyMs: performance.now() - startedAt,
      };
    } catch {
      if (signal.aborted) throw signal.reason;
      return { ok: false, latencyMs: performance.now() - startedAt };
    }
  }

  close(): Promise<void> {
    return (this.closing ??= this.pool.close());
  }
}
