import { afterEach, expect, it, vi } from 'vitest';
import { createMockApp } from './app.js';
import { draw, settingsSchema } from './simulation.js';

const apps: ReturnType<typeof createMockApp>[] = [];
const create = (options: Parameters<typeof createMockApp>[0] = {}) => {
  const app = createMockApp(options);
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const payload = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Hello 😀' }],
};
const chat = (app: ReturnType<typeof create>, extra = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { ...payload, ...extra },
  });
const control = (app: ReturnType<typeof create>, command: unknown) =>
  app.inject({ method: 'POST', url: '/__control', payload: command as object });

it('repeats draws regardless of call order or object key order', () => {
  const settings = settingsSchema.parse({
    models: {
      a: { jitter: 0.5, outputDistribution: 'heavy-tail', outputTokens: 100 },
    },
  });
  const first = draw(settings, 'a', { prompt: 'one', seed: 1 });
  draw(settings, 'a', { prompt: 'other' });
  expect(draw(settings, 'a', { seed: 1, prompt: 'one' })).toEqual(first);
  expect(
    draw(settingsSchema.parse({ ...settings, seed: 'other' }), 'a', {
      seed: 1,
      prompt: 'one',
    }),
  ).not.toEqual(first);
  expect(draw(settings, 'a', {}, 2).outputTokens).toBeLessThanOrEqual(2);
});

it('preserves default echo and matches streaming output and usage', async () => {
  const app = create({
    settings: { models: { 'mock-model': { outputTokens: 3 } } },
  });
  const json = (await chat(app)).json();
  expect(json.choices[0].message.content).toBe('Hello 😀 1 2');
  const stream = await chat(app, {
    stream: true,
    stream_options: { include_usage: true },
  });
  const events = stream.body
    .split('\n\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  expect(
    events
      .flatMap((event) => event.choices)
      .map((choice) => choice.delta.content ?? '')
      .join(''),
  ).toBe(json.choices[0].message.content);
  expect(events.at(-1).usage).toEqual(json.usage);
  expect(stream.body).toContain('data: [DONE]');
});

it('validates controls atomically, resets state and lists configured models', async () => {
  const app = create({ enableControl: true });
  expect((await control(app, { settings: { capacity: 0 } })).statusCode).toBe(
    400,
  );
  expect(
    (
      await control(app, {
        settings: { seed: 'changed', models: { custom: {} } },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject('/v1/models'))
      .json()
      .data.map((item: { id: string }) => item.id),
  ).toEqual(['custom']);
  expect((await chat(app)).statusCode).toBe(404);
  const reset = await control(app, { reset: true });
  expect(reset.json().settings.seed).toBe('vane');
  expect(reset.json().requests).toBe(0);
  expect(
    (await control(app, { profile: 'fast-small' })).json().settings.models[
      'mock-model'
    ].ttftMs,
  ).toBe(20);
});

it('disables controls by default and forbids remote control', async () => {
  expect((await create().inject('/__control')).statusCode).toBe(404);
  const app = create({ enableControl: true });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/__control',
        remoteAddress: '192.0.2.1',
        payload: { reset: true },
      })
    ).statusCode,
  ).toBe(403);
  expect(() => create({ settings: { capacity: -1 } })).toThrow();
});

it('generates deterministic normalized embeddings including base64', async () => {
  const app = create();
  const request = {
    method: 'POST' as const,
    url: '/v1/embeddings',
    payload: { model: 'mock-model', input: ['alpha', 'beta'], dimensions: 4 },
  };
  const first = (await app.inject(request)).json();
  expect((await app.inject(request)).json()).toEqual(first);
  expect(Math.hypot(...first.data[0].embedding)).toBeCloseTo(1);
  const encoded = (
    await app.inject({
      ...request,
      payload: { ...request.payload, encoding_format: 'base64' },
    })
  ).json();
  expect(
    Buffer.from(encoded.data[0].embedding, 'base64').readFloatLE(0),
  ).toBeCloseTo(first.data[0].embedding[0]);
  expect(
    (
      await app.inject({
        ...request,
        payload: { ...request.payload, dimensions: 0 },
      })
    ).statusCode,
  ).toBe(400);
});

it('injects errors and independent health failures without leaking capacity', async () => {
  const app = create({ enableControl: true });
  await control(app, {
    settings: {
      healthFailure: true,
      models: { 'mock-model': { errorRate: 1 } },
    },
  });
  expect((await app.inject('/health')).statusCode).toBe(503);
  expect((await chat(app)).statusCode).toBe(503);
  expect((await app.inject('/__control')).json()).toMatchObject({
    running: 0,
    waiting: 0,
  });
  await control(app, { settings: { models: { 'mock-model': {} } } });
  expect((await chat(app)).statusCode).toBe(200);
});

it('enforces queue capacity and rejects resets while work is active', async () => {
  const app = create({
    enableControl: true,
    settings: {
      capacity: 1,
      loadMode: 'queue',
      maxQueue: 1,
      // Keep work active while asynchronous queue assertions run under suite load.
      models: { 'mock-model': { ttftMs: 1000 } },
    },
  });
  const first = chat(app).then((result) => result);
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().running).toBe(1),
  );
  const second = chat(app).then((result) => result);
  await vi.waitFor(
    async () => expect((await app.inject('/__control')).json().waiting).toBe(1),
    { interval: 5 },
  );
  expect((await chat(app)).statusCode).toBe(429);
  expect((await control(app, { reset: true })).statusCode).toBe(409);
  await Promise.all([first, second]);
  expect((await app.inject('/__control')).json()).toMatchObject({
    running: 0,
    waiting: 0,
    completed: 2,
  });
});

it('applies overload and degradation timing multipliers', async () => {
  const app = create({
    enableControl: true,
    settings: {
      capacity: 1,
      slowdownK: 2,
      models: { 'mock-model': { ttftMs: 30 } },
      degradation: [{ startMs: 0, durationMs: 10000, multiplier: 2 }],
    },
  });
  const start = Date.now();
  const first = chat(app).then((result) => result);
  await vi.waitFor(
    async () => expect((await app.inject('/__control')).json().running).toBe(1),
    { interval: 5 },
  );
  await chat(app);
  expect(Date.now() - start).toBeGreaterThanOrEqual(165);
  await first;
});

it('provides running and waiting metrics and crash threshold injection', async () => {
  const crash = vi.fn();
  const app = create({ settings: { crashAfterRequests: 2 }, crash });
  await chat(app);
  expect((await chat(app)).statusCode).toBe(503);
  expect(crash).toHaveBeenCalledOnce();
  expect((await app.inject('/metrics')).body).toContain(
    'mock_running_requests 0',
  );
});

it('cancels hanging work and queued requests on shutdown', async () => {
  const app = create({
    enableControl: true,
    settings: {
      capacity: 1,
      loadMode: 'queue',
      models: { 'mock-model': { hangRate: 1 } },
    },
  });
  const first = chat(app).then((result) => result);
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().running).toBe(1),
  );
  const second = chat(app).then((result) => result);
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().waiting).toBe(1),
  );
  await app.close();
  await Promise.all([first, second]);
});

it('loads startup presets and rejects unknown profiles', async () => {
  const app = create({ profile: 'slow-large', enableControl: true });
  expect(
    (await app.inject('/__control')).json().settings.models['mock-model'],
  ).toMatchObject({
    ttftMs: 200,
    tokensPerSecond: 25,
    outputDistribution: 'heavy-tail',
  });
  expect(() => create({ profile: 'unknown' })).toThrow('Unknown mock profile');
});

it('aborts real hanging and queued clients and leaves zero counts', async () => {
  const app = create({
    enableControl: true,
    settings: {
      capacity: 1,
      loadMode: 'queue',
      models: { 'mock-model': { hangRate: 1 } },
    },
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const send = (signal: AbortSignal) =>
    fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }).catch(() => undefined);
  const first = send(firstController.signal);
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().running).toBe(1),
  );
  const second = send(secondController.signal);
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().waiting).toBe(1),
  );
  secondController.abort();
  await second;
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json().waiting).toBe(0),
  );
  firstController.abort();
  await first;
  await vi.waitFor(async () =>
    expect((await app.inject('/__control')).json()).toMatchObject({
      running: 0,
      waiting: 0,
      cancelled: 2,
    }),
  );
  expect((await control(app, { reset: true })).statusCode).toBe(200);
});

it('refuses inference connections while controls remain available', async () => {
  const app = create({
    enableControl: true,
    settings: { refuseConnections: true },
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  await expect(
    fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  ).rejects.toThrow();
  expect(
    (await control(app, { settings: { refuseConnections: false } })).statusCode,
  ).toBe(200);
  expect((await chat(app)).statusCode).toBe(200);
});

it('preserves the captured seed for queued embeddings across reconfiguration', async () => {
  const app = create({
    enableControl: true,
    settings: {
      seed: 'original',
      capacity: 1,
      loadMode: 'queue',
      models: { 'mock-model': { ttftMs: 120 } },
    },
  });
  const embeddingRequest = {
    method: 'POST' as const,
    url: '/v1/embeddings',
    payload: { model: 'mock-model', input: 'stable' },
  };
  const baseline = (await app.inject(embeddingRequest)).json().data;
  const blocker = chat(app).then((result) => result);
  await vi.waitFor(
    async () => expect((await app.inject('/__control')).json().running).toBe(1),
    { interval: 5 },
  );
  const pending = app.inject(embeddingRequest).then((result) => result);
  await vi.waitFor(
    async () => expect((await app.inject('/__control')).json().waiting).toBe(1),
    { interval: 5 },
  );
  await control(app, { settings: { seed: 'replacement' } });
  expect((await pending).json().data).toEqual(baseline);
  await blocker;
});
