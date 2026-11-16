import Fastify, { type FastifyError } from 'fastify';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  canonical,
  draw,
  profiles,
  randomFor,
  settingsSchema,
  type Settings,
} from './simulation.js';

const chatSchema = z
  .object({
    model: z.string().default('mock-model'),
    messages: z
      .array(
        z
          .object({ role: z.string(), content: z.unknown().optional() })
          .passthrough(),
      )
      .min(1),
    stream: z.boolean().default(false),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .passthrough()
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
  })
  .passthrough();
const embeddingsSchema = z
  .object({
    model: z.string().default('mock-model'),
    input: z.union([z.string(), z.array(z.string()).min(1)]),
    dimensions: z.number().int().min(1).max(4096).default(16),
    encoding_format: z.enum(['float', 'base64']).default('float'),
  })
  .passthrough();
const controlSchema = z
  .object({
    reset: z.boolean().default(false),
    profile: z.enum(['fast-small', 'slow-large', 'flaky']).optional(),
    settings: settingsSchema.partial().optional(),
  })
  .strict();

export interface MockOptions {
  settings?: unknown;
  profile?: string;
  enableControl?: boolean;
  logger?: boolean;
  crash?: () => void;
}
export function createMockApp(options: MockOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  if (options.profile && !Object.hasOwn(profiles, options.profile))
    throw new Error(`Unknown mock profile: ${options.profile}`);
  const preset = options.profile
    ? profiles[options.profile as keyof typeof profiles]
    : undefined;
  const initial = settingsSchema.parse({
    ...(preset ? { models: { 'mock-model': preset } } : {}),
    ...settingsSchema.partial().parse(options.settings ?? {}),
  });
  let settings: Settings = structuredClone(initial);
  let epoch = Date.now();
  let running = 0;
  let closing = false;
  let requests = 0;
  let completed = 0;
  let cancelled = 0;
  const active = new Set<AbortController>();
  const waiting: Array<{
    grant: () => void;
  }> = [];
  const snapshot = () => ({
    settings,
    running,
    waiting: waiting.length,
    requests,
    completed,
    cancelled,
    elapsedMs: Date.now() - epoch,
  });
  const error = (statusCode: number, code: string, message: string) =>
    Object.assign(new Error(message), { statusCode, code });
  app.setErrorHandler<FastifyError>((failure, _request, reply) => {
    const status =
      failure instanceof z.ZodError ? 400 : (failure.statusCode ?? 500);
    reply.code(status).send({
      error: {
        message: status < 500 ? failure.message : 'Mock worker failure',
        type: status < 500 ? 'invalid_request_error' : 'server_error',
        code:
          failure instanceof z.ZodError
            ? 'invalid_request'
            : (failure.code ?? 'mock_error'),
      },
    });
  });
  app.get('/health', async (_request, reply) =>
    reply
      .code(settings.healthFailure ? 503 : 200)
      .send({ ok: !settings.healthFailure }),
  );
  app.get('/v1/models', async () => ({
    object: 'list',
    data: Object.keys(settings.models).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'mock',
    })),
  }));
  app.get('/metrics', async (_request, reply) =>
    reply
      .type('text/plain; version=0.0.4')
      .send(
        `mock_running_requests ${running}\nmock_waiting_requests ${waiting.length}\nmock_requests_total ${requests}\nmock_completed_requests_total ${completed}\nmock_cancelled_requests_total ${cancelled}\n`,
      ),
  );
  if (options.enableControl) {
    app.addHook('onRequest', async (request, reply) => {
      if (
        request.url.split('?')[0] === '/__control' &&
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)
      )
        return reply
          .code(403)
          .send({ error: { message: 'Control requires loopback access' } });
    });
    app.get('/__control', async () => snapshot());
    app.post('/__control', async (request) => {
      const command = controlSchema.parse(request.body);
      const baseline = command.reset ? structuredClone(initial) : settings;
      const replacement = settingsSchema.parse({
        ...baseline,
        ...(command.profile
          ? { models: { 'mock-model': profiles[command.profile] } }
          : {}),
        ...command.settings,
      });
      if (command.reset && active.size)
        throw error(
          409,
          'mock_busy',
          'Reset requires no active or waiting requests',
        );
      settings = replacement;
      if (command.reset) {
        epoch = Date.now();
        requests = completed = cancelled = 0;
      }
      // A runtime capacity increase admits queued work immediately.
      while (!closing && waiting.length && running < settings.capacity)
        waiting.shift()!.grant();
      return snapshot();
    });
  }
  app.addHook('preClose', async () => {
    closing = true;
    for (const controller of active)
      controller.abort(new Error('Worker shutting down'));
  });

  async function execute<T>(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    model: string,
    identity: unknown,
    limit: number | undefined,
    generate: (
      sample: ReturnType<typeof draw>,
      signal: AbortSignal,
      slowdown: number,
      seed: string,
    ) => Promise<T>,
  ) {
    if (!Object.hasOwn(settings.models, model))
      throw error(404, 'model_not_found', 'Unknown mock model');
    const current = settings;
    requests++;
    if (
      current.crashAfterRequests !== null &&
      requests >= current.crashAfterRequests
    ) {
      (options.crash ?? (() => process.exit(1)))();
      throw error(503, 'mock_crash', 'Injected crash');
    }
    if (current.refuseConnections) {
      reply.hijack();
      request.raw.socket.destroy();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const signal = controller.signal;
    let released = false;
    let admitted = false;
    let failed = false;
    let removeWaiting: (() => void) | undefined;
    const disconnect = () => {
      if (!reply.raw.writableFinished)
        controller.abort(new Error('Client disconnected'));
    };
    const release = () => {
      if (released) return;
      released = true;
      removeWaiting?.();
      signal.removeEventListener('abort', release);
      request.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
      reply.raw.off('finish', release);
      active.delete(controller);
      if (admitted) running--;
      if (signal.aborted) cancelled++;
      else if (!failed) completed++;
      while (!closing && waiting.length && running < settings.capacity)
        waiting.shift()!.grant();
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    reply.raw.once('finish', release);
    signal.addEventListener('abort', release, { once: true });
    try {
      if (current.loadMode === 'queue' && running >= current.capacity) {
        if (waiting.length >= current.maxQueue)
          throw error(429, 'mock_queue_full', 'Mock queue is full');
        await new Promise<void>((resolve, reject) => {
          const entry = {
            grant: () => {
              signal.removeEventListener('abort', abort);
              running++;
              admitted = true;
              resolve();
            },
          };
          const abort = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal.reason);
          };
          removeWaiting = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
          };
          waiting.push(entry);
          signal.addEventListener('abort', abort, { once: true });
        });
      } else {
        running++;
        admitted = true;
      }
      signal.throwIfAborted();
      const sample = draw(current, model, identity, limit);
      const load =
        current.loadMode === 'slowdown'
          ? 1 +
            (current.slowdownK * Math.max(0, running - current.capacity)) /
              current.capacity
          : 1;
      const elapsed = Date.now() - epoch;
      const degradation = current.degradation
        .filter(
          (window) =>
            elapsed >= window.startMs &&
            elapsed < window.startMs + window.durationMs,
        )
        .reduce((factor, window) => factor * window.multiplier, 1);
      if (sample.error)
        throw error(503, 'mock_injected_error', 'Injected mock failure');
      if (sample.hang)
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      return await generate(sample, signal, load * degradation, current.seed);
    } catch (failure) {
      failed = true;
      release();
      if (!signal.aborted) throw failure;
    }
  }

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = chatSchema.parse(request.body);
    const {
      gateway: _gateway,
      stream: _stream,
      stream_options: _options,
      ...identity
    } = body;
    void _gateway;
    void _stream;
    void _options;
    return execute(
      request,
      reply,
      body.model,
      identity,
      body.max_completion_tokens ?? body.max_tokens,
      async (sample, signal, slowdown, seed) => {
        const text =
          typeof body.messages.at(-1)?.content === 'string'
            ? (body.messages.at(-1)!.content as string)
            : canonical(body.messages.at(-1)?.content);
        const tokens = Array.from(
          { length: sample.outputTokens },
          (_, index) => (index === 0 ? text : ` ${index}`),
        );
        const usage = {
          prompt_tokens: Math.max(
            1,
            Math.ceil(canonical(body.messages).length / 4),
          ),
          completion_tokens: tokens.length,
          total_tokens: 0,
        };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        const base = {
          id: `chatcmpl-${randomFor(seed, identity)().toString(16).slice(2)}`,
          created: Math.floor(Date.now() / 1000),
          model: body.model,
        };
        const sleep = (ms: number) =>
          delay(Math.min(2147483647, ms), undefined, { signal });
        if (!body.stream) {
          await sleep(
            (sample.ttftMs + sample.tokenMs * Math.max(0, tokens.length - 1)) *
              slowdown,
          );
          return {
            ...base,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: tokens.join('') },
                finish_reason: 'stop',
              },
            ],
            usage,
          };
        }
        async function* chunks() {
          const event = (choices: unknown[], extra = {}) =>
            `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`;
          await sleep(sample.ttftMs * slowdown);
          yield event([
            { index: 0, delta: { role: 'assistant' }, finish_reason: null },
          ]);
          for (let index = 0; index < tokens.length; index++) {
            if (index) await sleep(sample.tokenMs * slowdown);
            signal.throwIfAborted();
            yield event([
              {
                index: 0,
                delta: { content: tokens[index] },
                finish_reason: null,
              },
            ]);
          }
          yield event([{ index: 0, delta: {}, finish_reason: 'stop' }]);
          if (body.stream_options?.include_usage) yield event([], { usage });
          yield 'data: [DONE]\n\n';
        }
        return reply.type('text/event-stream').send(Readable.from(chunks()));
      },
    );
  });
  app.post('/v1/embeddings', async (request, reply) => {
    const body = embeddingsSchema.parse(request.body);
    return execute(
      request,
      reply,
      body.model,
      body,
      undefined,
      async (sample, signal, slowdown, seed) => {
        await delay(sample.ttftMs * slowdown, undefined, { signal });
        const inputs =
          typeof body.input === 'string' ? [body.input] : body.input;
        const data = inputs.map((input, index) => {
          const random = randomFor(seed, { model: body.model, input });
          const vector = Array.from(
            { length: body.dimensions },
            () => random() * 2 - 1,
          );
          const norm = Math.hypot(...vector) || 1;
          const normalized = vector.map((value) => value / norm);
          const bytes = Buffer.alloc(normalized.length * 4);
          normalized.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
          return {
            object: 'embedding',
            index,
            embedding:
              body.encoding_format === 'float'
                ? normalized
                : bytes.toString('base64'),
          };
        });
        const count = inputs.reduce(
          (sum, input) => sum + Math.max(1, Math.ceil(input.length / 4)),
          0,
        );
        return {
          object: 'list',
          model: body.model,
          data,
          usage: { prompt_tokens: count, total_tokens: count },
        };
      },
    );
  });
  return app;
}
