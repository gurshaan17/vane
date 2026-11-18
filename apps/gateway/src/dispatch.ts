import type { GatewayRequest } from '@gateway/shared';
import type { ResolvedConfig } from './config.js';
import { GatewayError } from './errors.js';
import { UpstreamError } from './adapter.js';
import { WorkerRegistry } from './registry.js';
import { WorkerRouter, baselineStrategy } from './router.js';
import { RetryBudget, backoff, waitForRetry } from './retry.js';
import type { ChatDispatch } from './app.js';
import type { ChatBody } from './validation.js';

/** Baseline routing reserves capacity before upstream dispatch. */
export function createWorkerDispatch(config: ResolvedConfig) {
  const defaultStrategy = baselineStrategy(config.routing.strategy);
  const registry = new WorkerRegistry(config);
  const router = new WorkerRouter(registry);
  const budget = new RetryBudget(config.resilience.retryBudget);
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
    extensions,
    traceparent,
    onDispatch,
  ) => {
    const model = resolveModel(request.model);
    const strategy = baselineStrategy(extensions.routing ?? defaultStrategy);
    budget.recordRequest();
    const triedWorkerIds = new Set<string>();
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.resilience.maxAttempts; attempt++) {
      request.signal.throwIfAborted();
      if (Date.now() >= request.deadlineAt)
        throw new UpstreamError('timeout', false);
      let selection;
      try {
        selection = router.select(
          { request, model, triedWorkerIds, attempt },
          strategy,
        );
      } catch (error) {
        throw lastError ?? error;
      }
      const { entry, release } = selection;
      if (attempt > 1 && !budget.take()) {
        release({ cancelled: true, latencyMs: 0 });
        throw lastError;
      }
      triedWorkerIds.add(entry.config.id);
      const { config: worker, adapter } = entry;
      const startedAt = Date.now();
      onDispatch?.(
        (result) =>
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
        {
          strategy,
          workerId: worker.id,
          modelSelected: model,
          attempts: attempt,
        },
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
        if (request.signal.aborted) throw request.signal.reason;
        if (
          !(error instanceof UpstreamError) ||
          !error.retryable ||
          (error.retryAfterMs ?? 0) > 500 ||
          attempt >= config.resilience.maxAttempts ||
          !budget.allowed()
        )
          throw error;
        lastError = error;
        const available = router
          .candidates({ request, model, triedWorkerIds, attempt: attempt + 1 })
          .some(
            (candidate) =>
              candidate.state.inFlight < candidate.config.maxConcurrency,
          );
        if (!available) throw error;
        const delay = backoff(attempt, Math.random, error.retryAfterMs);
        if (Date.now() + delay >= request.deadlineAt) throw error;
        await waitForRetry(delay, request.signal);
        continue;
      }
      if (!onDispatch) release({ latencyMs: Date.now() - startedAt });
      return {
        ...response,
        contentType: request.stream ? 'text/event-stream' : 'application/json',
        headers: {
          'x-gateway-model': model,
          'x-gateway-worker': worker.id,
          'x-gateway-routing': strategy,
          'x-gateway-attempts': String(attempt),
          'x-gateway-fallback': 'false',
        },
      };
    }
    throw lastError;
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
