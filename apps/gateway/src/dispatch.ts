import type { GatewayRequest } from '@gateway/shared';
import type { ResolvedConfig } from './config.js';
import { GatewayError } from './errors.js';
import { MockWorkerAdapter } from './adapter.js';
import type { ChatDispatch } from './app.js';
import type { ChatBody } from './validation.js';

/** One worker only. Worker selection and automatic model selection belong to later phases. */
export function createWorkerDispatch(config: ResolvedConfig) {
  const worker = config.workers[0];
  if (worker.backend !== 'mock')
    throw new Error('Phase 4 supports the mock backend only');
  const adapter = new MockWorkerAdapter(worker, config.resilience);
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
    if (!Object.hasOwn(worker.models, model))
      throw new GatewayError(
        503,
        'no_healthy_worker',
        'The configured worker does not serve this model',
        'server_error',
      );
    return model;
  }

  const chat: ChatDispatch = async (
    request: GatewayRequest,
    _extensions,
    traceparent,
  ) => {
    const model = resolveModel(request.model);
    const response = await (
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
    const loaded = new Set(await adapter.listModels(signal));
    return {
      object: 'list',
      data: config.models
        .filter(
          (model) =>
            Object.hasOwn(worker.models, model.id) &&
            loaded.has(worker.models[model.id]),
        )
        .map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'gateway',
        })),
    };
  }

  return { chat, listModels, close: () => adapter.close() };
}
