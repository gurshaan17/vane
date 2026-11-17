import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { ResolvedConfig } from './config.js';
import type { RequestLifecycle } from './lifecycle.js';
import { UpstreamError } from './adapter.js';
import { errorBody, normalizeError, GatewayError } from './errors.js';

/** Bounded side inspection. Forwarded bytes remain untouched, including UTF-8 splits. */
export class SSEInspector {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  done = false;
  usage?: Record<string, unknown>;
  dataSeen = false;

  push(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) {
      const event = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (Buffer.byteLength(event) > 1024 * 1024)
        throw new UpstreamError('stream', false);
      const data = event
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      this.dataSeen = true;
      if (data.trim() === '[DONE]') this.done = true;
      else if (data.includes('"usage"')) {
        try {
          const parsed = JSON.parse(data);
          if (
            parsed.usage &&
            typeof parsed.usage === 'object' &&
            !Array.isArray(parsed.usage)
          )
            this.usage = parsed.usage;
        } catch {
          /* Ordinary SSE events need not contain JSON. */
        }
      }
    }
    if (Buffer.byteLength(this.pending) > 1024 * 1024)
      throw new UpstreamError('stream', false);
  }
}

export async function proxyStream(
  source: Readable,
  reply: FastifyReply,
  lifecycle: RequestLifecycle,
  config: ResolvedConfig,
  headers?: Record<string, string>,
) {
  const inspector = new SSEInspector();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastWrite = Date.now();
  const fail = (error: unknown) => {
    if (!controller.signal.aborted) controller.abort(error);
    source.destroy(
      error instanceof Error ? error : new Error('Stream aborted'),
    );
  };
  const abort = () => fail(lifecycle.signal.reason);
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new UpstreamError('timeout', false)), ms);
    timer.unref();
  };
  const write = async (chunk: Buffer | string) => {
    controller.signal.throwIfAborted();
    lastWrite = Date.now();
    if (!reply.raw.write(chunk)) {
      const stall = setTimeout(
        () => fail(new UpstreamError('timeout', false)),
        config.streaming.clientStallMs,
      );
      try {
        await once(reply.raw, 'drain', { signal: controller.signal });
      } finally {
        clearTimeout(stall);
      }
    }
  };
  lifecycle.signal.addEventListener('abort', abort, { once: true });
  arm(config.resilience.firstByteTimeoutMs);
  try {
    lifecycle.signal.throwIfAborted();
    for await (const chunk of source) {
      controller.signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!bytes.length) continue;
      inspector.push(bytes);
      if (inspector.dataSeen && lifecycle.ttftMs === undefined)
        lifecycle.ttftMs = Date.now() - lifecycle.startedAt;
      lifecycle.usage = inspector.usage;
      if (!reply.raw.headersSent) {
        reply.headers(headers ?? {});
        reply.type('text/event-stream');
        reply.header('cache-control', 'no-cache, no-transform');
        reply.header('x-accel-buffering', 'no');
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        reply.raw.writeHead(200);
        heartbeat = setInterval(() => {
          if (
            Date.now() - lastWrite >= config.streaming.heartbeatMs &&
            !reply.raw.writableNeedDrain
          ) {
            reply.raw.write(': ping\n\n');
            lastWrite = Date.now();
          }
        }, config.streaming.heartbeatMs);
        heartbeat.unref();
      }
      // Pause the producer while the consumer drains; neither queue grows with stream length.
      clearTimeout(timer);
      await write(bytes);
      if (inspector.done) break;
      arm(config.resilience.streamIdleTimeoutMs);
    }
    if (!inspector.done) throw new UpstreamError('stream', false);
    reply.raw.end();
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    const failure = normalizeError(
      cause instanceof GatewayError
        ? cause
        : new UpstreamError('stream', false),
    );
    lifecycle.errorCode = failure.code;
    if (!reply.raw.headersSent) throw failure;
    if (reply.raw.writableNeedDrain) {
      reply.raw.destroy();
    } else if (!reply.raw.destroyed) {
      // Never append a success marker or retry after any client bytes.
      reply.raw.end(
        `event: error\ndata: ${JSON.stringify(errorBody(failure, String(reply.getHeader('x-request-id') ?? '')))}\n\n`,
      );
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    lifecycle.signal.removeEventListener('abort', abort);
    source.destroy();
  }
}
