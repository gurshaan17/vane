import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type RouteHandlerMethod } from 'fastify';
import OpenAI from 'openai';
import { validateConfig } from '@gateway/shared';
import { MockWorkerAdapter, UpstreamError } from './adapter.js';
import { createApp } from './app.js';
import { resolveSecrets } from './config.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const controller = () => new AbortController();
const payload = {
  model: 'public-model',
  messages: [{ role: 'user', content: 'Hello' }],
};
const settings = (baseUrl: string) =>
  resolveSecrets(
    validateConfig({
      logging: { level: 'silent' },
      models: [
        {
          id: 'public-model',
          aliases: ['friendly'],
          capabilities: ['chat'],
          contextWindow: 8192,
          qualitySource: 'placeholder',
          quality: {},
          baseline: { ttftMs: 0, tokensPerSec: 100 },
        },
        {
          id: 'other-model',
          capabilities: ['chat'],
          contextWindow: 8192,
          qualitySource: 'placeholder',
          quality: {},
          baseline: { ttftMs: 0, tokensPerSec: 100 },
        },
      ],
      workers: [
        {
          id: 'mock-1',
          backend: 'mock',
          baseUrl,
          apiKeyEnv: 'WORKER_KEY',
          models: { 'public-model': 'private-model' },
          maxConcurrency: 2,
        },
      ],
    }),
    { WORKER_KEY: 'worker-secret' },
  );

async function fixture() {
  const worker = Fastify({ logger: false });
  closers.push(() => worker.close());
  const requests: Array<{
    url: string;
    headers: Record<string, unknown>;
    body: unknown;
  }> = [];
  worker.addHook('onRequest', async (req) => {
    requests.push({ url: req.url, headers: req.headers, body: undefined });
  });
  worker.addHook('preHandler', async (req) => {
    requests.at(-1)!.body = req.body;
  });
  worker.post('/v1/chat/completions', async (req, reply) => {
    reply.headers({
      'x-request-id': 'worker-request',
      'x-gateway-worker': 'untrusted-worker',
      'set-cookie': 'secret=cookie',
      authorization: 'upstream-secret',
      'keep-alive': 'timeout=99',
    });
    return {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'private-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from worker' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      echoed: req.body,
    };
  });
  worker.get('/v1/models', async () => ({
    object: 'list',
    data: [
      { id: 'private-model', object: 'model' },
      { id: 'unregistered-worker-model', object: 'model' },
    ],
  }));
  worker.get('/health', async () => ({ ok: true }));
  const baseUrl = await worker.listen({ port: 0, host: '127.0.0.1' });
  const config = settings(baseUrl);
  const adapter = new MockWorkerAdapter(config.workers[0], config.resilience);
  closers.push(() => adapter.close());
  return { worker, config, adapter, requests };
}

async function serving(handler: RouteHandlerMethod) {
  // Separate minimal workers make faults independent of the SDK fixture.
  const worker = Fastify();
  closers.push(() => worker.close());
  worker.post('/v1/chat/completions', handler);
  const url = await worker.listen({ port: 0, host: '127.0.0.1' });
  const config = settings(url);
  const adapter = new MockWorkerAdapter(config.workers[0], config.resilience);
  closers.push(() => adapter.close());
  return { worker, adapter, config };
}

const chat = (adapter: MockWorkerAdapter, signal = controller().signal) =>
  adapter.chat({ model: 'public-model', body: payload }, signal);

describe('one-worker JSON adapter and SDK compatibility', () => {
  it('completes official SDK chat and model listing with canonical IDs and safe headers', async () => {
    const { config, requests } = await fixture();
    const app = createApp(config);
    closers.push(() => app.close());
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new OpenAI({
      apiKey: 'client-secret',
      baseURL: `${baseUrl}/v1`,
      maxRetries: 0,
    });
    const trace = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
    const request = {
      model: 'friendly',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      temperature: 0,
      max_completion_tokens: 10,
      seed: 123,
      response_format: { type: 'json_object' as const },
      gateway: { cache: 'bypass' },
      future_output_option: { enabled: true },
    };
    const { data: result, response } = await client.chat.completions
      .create(request, {
        headers: {
          'x-request-id': 'sdk-request',
          traceparent: trace,
          'x-client-private': 'do-not-forward',
          'x-gateway-priority': 'high_quality',
        },
      })
      .withResponse();
    expect(result.model).toBe('public-model');
    expect(result.choices[0].message.content).toBe('Hello from worker');
    expect(result.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
    expect(response.headers.get('x-request-id')).toBe('sdk-request');
    expect(response.headers.get('x-gateway-model')).toBe('public-model');
    expect(response.headers.get('x-gateway-worker')).toBe('mock-1');
    expect(response.headers.get('x-gateway-attempts')).toBe('1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('authorization')).toBeNull();
    expect(response.headers.get('keep-alive')).not.toBe('timeout=99');
    const upstream = requests.find(
      (request) => request.url === '/v1/chat/completions',
    )!;
    expect(upstream.body).toMatchObject({
      model: 'private-model',
      temperature: 0,
      max_completion_tokens: 10,
      seed: 123,
      response_format: { type: 'json_object' },
      future_output_option: { enabled: true },
    });
    expect(upstream.body).not.toHaveProperty('gateway');
    expect(upstream.headers.authorization).toBe('Bearer worker-secret');
    expect(upstream.headers.traceparent).toBe(trace);
    expect(upstream.headers['x-request-id']).toBe('sdk-request');
    expect(upstream.headers['x-client-private']).toBeUndefined();
    expect(upstream.headers['x-gateway-priority']).toBeUndefined();
    expect(upstream.headers['x-stainless-lang']).toBeUndefined();
    const models = await client.models.list();
    expect(models.data).toEqual([
      { id: 'public-model', object: 'model', created: 0, owned_by: 'gateway' },
    ]);
    const listRequest = requests.find(
      (request) => request.url === '/v1/models',
    )!;
    expect(listRequest.headers.authorization).toBe('Bearer worker-secret');
  });

  it('rejects unknown models, auto, and unavailable explicit models before upstream I/O', async () => {
    const { config, requests } = await fixture();
    const app = createApp(config);
    closers.push(() => app.close());
    for (const [model, status, code] of [
      ['missing', 404, 'model_not_found'],
      ['constructor', 404, 'model_not_found'],
      ['auto', 400, 'invalid_request'],
      ['other-model', 503, 'no_healthy_worker'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...payload, model },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toMatchObject({
        code,
        request_id: response.headers['x-request-id'],
      });
    }
    expect(
      requests.filter((request) => request.url === '/v1/chat/completions'),
    ).toHaveLength(0);
  });

  it('exposes unknown-model errors through the official SDK', async () => {
    const { config } = await fixture();
    const app = createApp(config);
    closers.push(() => app.close());
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new OpenAI({
      apiKey: 'local',
      baseURL: `${url}/v1`,
      maxRetries: 0,
    });
    await expect(
      client.chat.completions.create({
        model: 'missing',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toMatchObject({ status: 404, code: 'model_not_found' });
  });

  it('does not forward client credentials when no worker key is configured', async () => {
    const { config, requests } = await fixture();
    delete config.workers[0].apiKey;
    const app = createApp(config);
    closers.push(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer client-secret',
        traceparent: 'invalid',
        cookie: 'private=yes',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].headers.cookie).toBeUndefined();
    expect(requests[0].headers.traceparent).toMatch(
      /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
    );
  });

  it('supports a base URL path prefix and keeps request payloads immutable', async () => {
    const worker = Fastify();
    closers.push(() => worker.close());
    let received: unknown;
    worker.post('/worker/v1/chat/completions', async (req) => {
      received = req.body;
      return { model: 'private-model', choices: [] };
    });
    const base = await worker.listen({ port: 0, host: '127.0.0.1' });
    const config = settings(`${base}/worker/`);
    const adapter = new MockWorkerAdapter(config.workers[0], config.resilience);
    closers.push(() => adapter.close());
    const body = {
      ...payload,
      gateway: { cache: 'bypass' },
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      tool_choice: 'auto',
      n: 2,
      stop: ['STOP'],
    };
    const before = structuredClone(body);
    await adapter.chat({ model: 'public-model', body }, controller().signal);
    expect(body).toEqual(before);
    expect(received).toEqual({
      ...payload,
      model: 'private-model',
      tools: body.tools,
      tool_choice: 'auto',
      n: 2,
      stop: ['STOP'],
    });
  });

  it('probes health and lists the actual worker model names', async () => {
    const { adapter, requests } = await fixture();
    expect(await adapter.health(controller().signal)).toMatchObject({
      ok: true,
      latencyMs: expect.any(Number),
    });
    expect(await adapter.listModels(controller().signal)).toEqual([
      'private-model',
      'unregistered-worker-model',
    ]);
    expect(requests.map((req) => req.url)).toEqual(['/health', '/v1/models']);
    expect(
      requests.every((req) => typeof req.headers.traceparent === 'string'),
    ).toBe(true);
  });
});

describe('normalized upstream errors', () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
    [429, true],
    [500, false],
    [502, true],
    [503, true],
    [504, true],
  ])('classifies HTTP %s with retryable=%s', async (status, retryable) => {
    const { adapter } = await serving(async (_req, reply) =>
      reply.code(status).send({ private: 'worker-secret' }),
    );
    const result = await chat(adapter).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(UpstreamError);
    expect(result).toMatchObject({
      kind: 'http',
      status,
      retryable,
      code: 'upstream_error',
      statusCode: 502,
    });
    expect(JSON.stringify(result)).not.toContain('worker-secret');
  });

  it.each(['not JSON', 'null', '[]', '42'])(
    'rejects malformed chat response %s',
    async (body) => {
      const { adapter } = await serving(async (_req, reply) =>
        reply.type('application/json').send(body),
      );
      await expect(chat(adapter)).rejects.toMatchObject({
        kind: 'stream',
        retryable: false,
      });
    },
  );

  it('classifies connection failures independently of HTTP failures', async () => {
    const config = settings('http://127.0.0.1:1');
    const adapter = new MockWorkerAdapter(config.workers[0], config.resilience);
    closers.push(() => adapter.close());
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'connect',
      retryable: true,
    });
    expect(await adapter.health(controller().signal)).toMatchObject({
      ok: false,
    });
  });

  it('classifies the configured response-header timeout', async () => {
    const { worker, config } = await serving(async (_req, reply) => reply);
    const adapter = new MockWorkerAdapter(config.workers[0], {
      ...config.resilience,
      firstByteTimeoutMs: 25,
    });
    closers.push(() => adapter.close());
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      statusCode: 504,
    });
    expect(worker.server.listening).toBe(true);
  });

  it('does not follow redirects with worker credentials', async () => {
    const destination = Fastify();
    closers.push(() => destination.close());
    let calls = 0;
    destination.post('/redirected', async () => {
      calls++;
      return {};
    });
    const url = await destination.listen({ port: 0, host: '127.0.0.1' });
    const { adapter } = await serving(async (_req, reply) =>
      reply.code(307).header('location', `${url}/redirected`).send(),
    );
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'http',
      status: 307,
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it('rejects invalid model lists and marks failed health probes unhealthy', async () => {
    const worker = Fastify();
    closers.push(() => worker.close());
    worker.get('/v1/models', async () => ({ data: [{ wrong: 'id' }] }));
    worker.get('/health', async (_req, reply) =>
      reply.code(503).send({ ok: false }),
    );
    const url = await worker.listen({ port: 0, host: '127.0.0.1' });
    const config = settings(url);
    const adapter = new MockWorkerAdapter(config.workers[0], config.resilience);
    closers.push(() => adapter.close());
    await expect(adapter.listModels(controller().signal)).rejects.toMatchObject(
      { kind: 'stream', retryable: false },
    );
    expect(await adapter.health(controller().signal)).toMatchObject({
      ok: false,
    });
    const app = createApp(config);
    closers.push(() => app.close());
    const response = await app.inject('/v1/models');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect((await app.inject('/readyz')).statusCode).toBe(503);
  });
});

describe('pool ownership and cancellation', () => {
  it('reuses keep-alive sockets and bounds parallel worker requests', async () => {
    const ports = new Set<number | undefined>();
    let active = 0;
    let peak = 0;
    const { adapter } = await serving(async (req) => {
      ports.add(req.raw.socket.remotePort);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { choices: [] };
    });
    for (let i = 0; i < 3; i++) await chat(adapter);
    expect(ports.size).toBeLessThan(3);
    await Promise.all(Array.from({ length: 6 }, () => chat(adapter)));
    expect(peak).toBe(2);
    expect(ports.size).toBe(2);
  });

  it.each(['chat', 'listModels', 'health'] as const)(
    'preserves an already-aborted %s signal without dispatch',
    async (method) => {
      const { adapter, requests } = await fixture();
      const abort = controller();
      const reason = new Error('client cancelled');
      abort.abort(reason);
      const result =
        method === 'chat'
          ? chat(adapter, abort.signal)
          : adapter[method](abort.signal);
      await expect(result).rejects.toBe(reason);
      expect(
        requests.filter((request) => request.url === '/v1/chat/completions'),
      ).toHaveLength(0);
    },
  );

  it('cancels a JSON body read and leaves the pool reusable', async () => {
    let partial = true;
    let entered!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disconnected = false;
    const { adapter } = await serving(async (_req, reply) => {
      if (!partial) return { choices: [] };
      reply.raw.once('close', () => {
        disconnected = true;
      });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"choices":');
      entered();
    });
    const abort = controller();
    const reason = new Error('body read cancelled');
    const response = chat(adapter, abort.signal);
    const assertion = expect(response).rejects.toBe(reason);
    await received;
    abort.abort(reason);
    await assertion;
    await vi.waitFor(() => expect(disconnected).toBe(true));
    partial = false;
    expect((await chat(adapter)).body).toEqual({ choices: [] });
  });

  it('closes idle pool sockets when the gateway closes', async () => {
    const { worker, config } = await fixture();
    const sockets = new Set<unknown>();
    worker.server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const app = createApp(config);
    closers.push(() => app.close());
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it('waits for active work before closing and makes repeated close calls safe', async () => {
    let entered!: () => void;
    let release!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter } = await serving(async () => {
      entered();
      await gate;
      return { choices: [] };
    });
    const pending = chat(adapter);
    await received;
    const closing = adapter.close();
    expect(adapter.close()).toBe(closing);
    release();
    expect((await pending).statusCode).toBe(200);
    await closing;
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'connect',
      retryable: false,
    });
  });
});

describe('response resource bounds', () => {
  it('normalizes a connection interruption after headers as a stream failure', async () => {
    const { adapter } = await serving(async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"choices":', () => reply.raw.destroy());
    });
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'stream',
      retryable: true,
    });
  });

  it('rejects responses above the 16 MiB JSON limit without retaining the connection', async () => {
    let oversized = true;
    const { adapter } = await serving(async (_request, reply) => {
      if (!oversized) return { choices: [] };
      return reply
        .type('application/json')
        .send(Buffer.alloc(16 * 1024 * 1024 + 1, ' '));
    });
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'stream',
      retryable: false,
    });
    oversized = false;
    expect((await chat(adapter)).body).toEqual({ choices: [] });
  });

  it('discards an HTTP error body that never completes and releases the socket', async () => {
    let disconnected = false;
    const { adapter } = await serving(async (_request, reply) => {
      reply.hijack();
      reply.raw.once('close', () => {
        disconnected = true;
      });
      reply.raw.writeHead(503, { 'content-type': 'application/json' });
      reply.raw.write('{"error":');
    });
    await expect(chat(adapter)).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      retryable: true,
    });
    await vi.waitFor(() => expect(disconnected).toBe(true));
  });
});
