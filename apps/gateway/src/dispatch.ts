import type { GatewayRequest } from '@gateway/shared';
import type { ResolvedConfig } from './config.js';
import { GatewayError } from './errors.js';
import { UpstreamError } from './adapter.js';
import { WorkerRegistry } from './registry.js';
import type { ChatDispatch } from './app.js';
import type { ChatBody } from './validation.js';

/** Uses the first eligible configured worker; routing strategies arrive in Phase 8. */
export function createWorkerDispatch(config: ResolvedConfig) {
  const registry = new WorkerRegistry(config);
  const names = new Map(
    config.models.flatMap((model) =>
      [model.id, ...model.aliases].map((name) => [name, model.id]),
    ),
  );

  function resolveModel(requested: string) {
    if (requested === 'auto')
      throw new GatewayError(
        400,
        'invalid_request',
        'Automatic model selection is not implemented; choose an explicit model',
      );
    const model = names.get(requested);
    if (!model)
      throw new GatewayError(
        404,
        'model_not_found',
        'Unknown model ID or alias',
      );
    return model;
  }

  const chat: ChatDispatch = async (
    request: GatewayRequest,
    _extensions,
    traceparent,
    onDispatch,
  ) => {
    const model = resolveModel(request.model);
    const entry = registry.eligible(model)[0];
    if (!entry)
      throw new GatewayError(
        503,
        'no_healthy_worker',
        'No healthy worker serves this model',
        'server_error',
      );
    const { config: worker, adapter } = entry;
    const startedAt = Date.now();
    const release = registry.reserve(entry);
    onDispatch?.((result) =>
      release({
        cancelled: result.outcome === 'cancelled',
        failed:
          result.outcome === 'timeout' ||
          result.errorCode === 'upstream_error' ||
          result.errorCode === 'upstream_timeout' ||
          result.statusCode >= 500,
        latencyMs: Date.now() - startedAt,
        ttftMs: result.ttftMs,
      }),
    );
    let response;
    try {
      response = await (
        request.stream
          ? adapter.chatStream.bind(adapter)
          : adapter.chat.bind(adapter)
      )(
        {
          model,
          body: request.body as ChatBody,
          requestId: request.id,
          traceparent,
        },
        request.signal,
      );
    } catch (error) {
      const cancelled =
        request.signal.aborted &&
        (request.signal.reason as { code?: string })?.code ===
          'client_cancelled';
      release({
        cancelled,
        failed:
          !cancelled &&
          (!(error instanceof UpstreamError) ||
            error.status === undefined ||
            error.status >= 500),
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
    if (!onDispatch) release({ latencyMs: Date.now() - startedAt });
    return {
      ...response,
      contentType: request.stream ? 'text/event-stream' : 'application/json',
      headers: {
        'x-gateway-model': model,
        'x-gateway-worker': worker.id,
        'x-gateway-attempts': '1',
        'x-gateway-fallback': 'false',
      },
    };
  };

  async function listModels(signal: AbortSignal) {
    signal.throwIfAborted();
    return {
      object: 'list',
      data: config.models
        .filter((model) => registry.eligible(model.id).length > 0)
        .map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'gateway',
        })),
    };
  }

  return { chat, listModels, registry, close: () => registry.close() };
}
