import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { GatewayRequest, RequestExtensions } from '@gateway/shared';
import type { ResolvedConfig } from './config.js';
import { errorBody, GatewayError, normalizeError } from './errors.js';
import {
  RequestLifecycle,
  requestId,
  type FinalizedRequest,
} from './lifecycle.js';
import { normalizeExtensions, validateChatBody } from './validation.js';

declare module 'fastify' {
  interface FastifyRequest {
    lifecycle: RequestLifecycle | null;
  }
}

export type ChatDispatch = (
  request: GatewayRequest,
  extensions: RequestExtensions,
) => Promise<{ statusCode: number; body: unknown; contentType?: string }>;

export interface AppOptions {
  dispatchChat?: ChatDispatch;
  onFinalize?: (result: FinalizedRequest) => void;
}

// The single-worker proxy is retained until the adapter and routing phases.
function proxyChat(config: ResolvedConfig): ChatDispatch {
  const worker = config.workers[0];
  return async (request) => {
    try {
      const upstream = await fetch(
        `${worker.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(worker.apiKey
              ? { authorization: `Bearer ${worker.apiKey}` }
              : {}),
          },
          body: JSON.stringify(request.body),
          signal: request.signal,
        },
      );
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new GatewayError(
          502,
          'upstream_error',
          'Upstream request failed',
          'server_error',
        );
      }
      return {
        statusCode: upstream.status,
        contentType: request.stream
          ? (upstream.headers.get('content-type') ?? 'application/json')
          : 'application/json',
        body:
          request.stream && upstream.body
            ? Readable.fromWeb(upstream.body)
            : await upstream.json(),
      };
    } catch {
      if (request.signal.aborted) throw request.signal.reason;
      throw new GatewayError(
        502,
        'upstream_error',
        'Upstream request failed',
        'server_error',
      );
    }
  };
}

export function createApp(config: ResolvedConfig, options: AppOptions = {}) {
  const app = Fastify({
    logger: { level: config.logging.level },
    bodyLimit: config.server.bodyLimitBytes,
    http: { maxHeaderSize: config.server.maxHeaderBytes },
    requestIdHeader: false,
    genReqId: (request) => requestId(request.headers['x-request-id']),
    clientErrorHandler(error, socket) {
      const id = requestId(undefined);
      const overflow = error.code === 'HPE_HEADER_OVERFLOW';
      const failure = new GatewayError(
        overflow ? 431 : 400,
        'invalid_request',
        overflow
          ? 'Request headers exceed the configured limit'
          : 'Malformed HTTP request',
      );
      const body = JSON.stringify(errorBody(failure, id));
      if (socket.writable)
        socket.end(
          `HTTP/1.1 ${failure.statusCode} ${overflow ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json\r\nx-request-id: ${id}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
    },
  });
  // Do not silently discard excess headers before our count validation sees them.
  app.server.maxHeadersCount = 0;
  app.decorateRequest('lifecycle', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    request.lifecycle = new RequestLifecycle(
      request,
      reply,
      config.server.defaultTimeoutMs,
      options.onFinalize,
    );
    const rawHeaders = request.raw.rawHeaders;
    const bytes = rawHeaders.reduce(
      (sum, value) => sum + Buffer.byteLength(value) + 2,
      2,
    );
    if (
      rawHeaders.length / 2 > config.server.maxHeaders ||
      bytes > config.server.maxHeaderBytes
    )
      throw new GatewayError(
        431,
        'invalid_request',
        'Request headers exceed the configured limit',
      );
    // Header deadlines also cover clients that stall while uploading their body.
    request.lifecycle.shortenDeadline(
      normalizeExtensions({}, request.headers).timeoutMs,
    );
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = request.lifecycle?.signal.aborted
      ? normalizeError(request.lifecycle.signal.reason)
      : normalizeError(error);
    if (request.lifecycle) request.lifecycle.errorCode = failure.code;
    if (failure.statusCode >= 500)
      request.log.error({ code: failure.code }, 'request failed');
    if (!reply.raw.headersSent)
      reply
        .code(failure.statusCode)
        .header('x-request-id', request.id)
        .send(errorBody(failure, request.id));
    else reply.raw.destroy();
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.send(new GatewayError(404, 'not_found', 'Route not found'));
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ready: true }));
  app.get('/v1/models', async () => ({
    object: 'list',
    data: config.models.map((model) => ({ id: model.id, object: 'model' })),
  }));
  const dispatch = options.dispatchChat ?? proxyChat(config);
  app.post('/v1/chat/completions', async (request, reply) => {
    const body = validateChatBody(request.body, config.server.maxMessages);
    const extensions = normalizeExtensions(body, request.headers);
    const lifecycle = request.lifecycle!;
    lifecycle.shortenDeadline(extensions.timeoutMs);
    lifecycle.signal.throwIfAborted();
    const gatewayRequest: GatewayRequest = {
      id: request.id,
      keyId: 'anonymous', // Authentication supplies key identity in Phase 14.
      endpoint: 'chat',
      body,
      model: body.model,
      stream: body.stream ?? false,
      priority: extensions.priority ?? config.selector.defaultPriority,
      taskHint: extensions.task,
      signal: lifecycle.signal,
      deadlineAt: lifecycle.deadlineAt,
    };
    const result = await dispatch(gatewayRequest, extensions);
    lifecycle.signal.throwIfAborted();
    if (result.contentType) reply.type(result.contentType);
    return reply.code(result.statusCode).send(result.body);
  });
  return app;
}
