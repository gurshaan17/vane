import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { WorkerRegistry } from './registry.js';
import type { WorkerAdapter } from './adapter.js';
import { createApp } from './app.js';
import Fastify from 'fastify';
import { Readable } from 'node:stream';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.useRealTimers();
});
async function fixture() {
  const config = await loadConfig('config/gateway.yaml', {});
  const adapter: WorkerAdapter = {
    health: vi.fn(async () => ({ ok: true, latencyMs: 2 })),
    listModels: vi.fn(async () => ['mock-model']),
    chat: vi.fn(),
    chatStream: vi.fn(),
    close: vi.fn(async () => {}),
    metrics: vi.fn(async () => ({ queueDepth: 3 })),
  };
  const registry = new WorkerRegistry(
    config,
    () => adapter,
    () => 0.5,
  );
  closers.push(() => registry.close());
  return { config, adapter, registry, entry: registry.entries.get('mock-1')! };
}

it('starts unavailable, probes models and optional metrics, and excludes missing models/draining workers', async () => {
  const { registry, entry } = await fixture();
  expect(registry.ready).toBe(false);
  await registry.start();
  expect(registry.ready).toBe(true);
  expect(entry.state).toMatchObject({
    health: 'degraded',
    queueDepth: 3,
    inFlight: 0,
  });
  expect(registry.eligible('unknown')).toEqual([]);
  entry.state.loadedModels.clear();
  expect(registry.ready).toBe(false);
  await registry.probe(entry.config.id);
  registry.drain(entry.config.id);
  expect(registry.eligible()).toEqual([]);
});

it('follows failure and recovery thresholds without admitting unprobed or unhealthy workers', async () => {
  const { config, registry, adapter, entry } = await fixture();
  await registry.start();
  await registry.probe(entry.config.id);
  expect(entry.state.health).toBe('healthy');
  vi.mocked(adapter.health).mockResolvedValue({ ok: false, latencyMs: 2 });
  for (let i = 1; i < config.health.unhealthyAfterFailures; i++) {
    await registry.probe(entry.config.id);
    expect(entry.state.health).toBe('degraded');
  }
  await registry.probe(entry.config.id);
  expect(registry.ready).toBe(false);
  vi.mocked(adapter.health).mockResolvedValue({ ok: true, latencyMs: 2 });
  for (let i = 1; i < config.health.recoverAfterSuccesses; i++) {
    await registry.probe(entry.config.id);
    expect(entry.state.health).toBe('unhealthy');
  }
  await registry.probe(entry.config.id);
  expect(entry.state.health).toBe('degraded');
  await registry.probe(entry.config.id);
  expect(entry.state.health).toBe('healthy');
});

it('tracks exactly-once outcomes, EWMA, cancellations and the bounded sliding error window', async () => {
  const { registry, entry } = await fixture();
  await registry.start();
  await registry.probe(entry.config.id);
  const release = registry.reserve(entry);
  expect(entry.state.inFlight).toBe(1);
  release({ latencyMs: 100, ttftMs: 10 });
  release({ latencyMs: 1000, failed: true });
  registry.reserve(entry)({ latencyMs: 200, ttftMs: 20, failed: true });
  registry.reserve(entry)({ latencyMs: 1000, cancelled: true });
  expect(entry.state).toMatchObject({
    inFlight: 0,
    sampleCount: 2,
    ewmaLatencyMs: 120,
    ewmaTtftMs: 12,
    recentErrorRate: 0.5,
    health: 'degraded',
  });
  for (let i = 0; i < 50; i++) registry.reserve(entry)({ latencyMs: 1 });
  expect(entry.state.recentErrorRate).toBe(0);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61000);
  registry.eligible();
  expect(entry.state.recentErrorRate).toBe(0);
});

it('degrades slow probes, tolerates unavailable metrics, and removes unloaded models', async () => {
  const { config, registry, entry, adapter } = await fixture();
  vi.mocked(adapter.health).mockResolvedValue({
    ok: true,
    latencyMs: config.health.degradedLatencyMs + 1,
  });
  vi.mocked(adapter.metrics!).mockRejectedValue(
    new Error('No metrics endpoint'),
  );
  await registry.start();
  await registry.probe(entry.config.id);
  expect(entry.state.health).toBe('degraded');
  expect(entry.state.queueDepth).toBeUndefined();
  vi.mocked(adapter.listModels).mockResolvedValue([]);
  await registry.probe(entry.config.id);
  expect(registry.ready).toBe(false);
});

it('prevents overlapping probes, bounds hangs, and stops timers and pending I/O on close', async () => {
  const { registry, adapter, config } = await fixture();
  vi.useFakeTimers();
  vi.mocked(adapter.health).mockImplementation(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const first = registry.probe('mock-1');
  expect(registry.probe('mock-1')).toBe(first);
  expect(adapter.health).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(config.health.probeTimeoutMs);
  await first;
  expect(registry.ready).toBe(false);
  const pending = registry.probe('mock-1');
  const close = registry.close();
  expect(registry.close()).toBe(close);
  await close;
  await pending;
  await vi.advanceTimersByTimeAsync(20000);
  expect(adapter.health).toHaveBeenCalledTimes(2);
  expect(adapter.close).toHaveBeenCalledOnce();
});

it('uses bounded jitter between completed probes', async () => {
  const { registry, adapter, config } = await fixture();
  vi.useFakeTimers();
  await registry.start();
  await vi.advanceTimersByTimeAsync(config.health.probeIntervalMs - 1);
  expect(adapter.health).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(adapter.health).toHaveBeenCalledTimes(2);
});

it('readiness follows actual health/models and shutdown while counters finalize JSON and stream failures', async () => {
  let healthFailure = false;
  const worker = Fastify();
  worker.get('/health', async () => ({ ok: !healthFailure }));
  worker.get('/v1/models', async () => ({ data: [{ id: 'mock-model' }] }));
  worker.post('/v1/chat/completions', async (request, reply) => {
    if ((request.body as { stream?: boolean }).stream)
      return reply
        .type('text/event-stream')
        .send(Readable.from(['data: {}\n\ndata: [DONE]\n\n']));
    return { choices: [] };
  });
  const address = await worker.listen({ port: 0, host: '127.0.0.1' });
  const config = await loadConfig('config/gateway.yaml', {});
  config.logging.level = 'silent';
  config.workers[0].baseUrl = address;
  const app = createApp(config);
  closers.push(async () => {
    await app.close();
    await worker.close();
  });
  expect(app.workerRegistry.ready).toBe(false);
  expect((await app.inject('/readyz')).statusCode).toBe(200);
  const request = {
    method: 'POST' as const,
    url: '/v1/chat/completions',
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
    },
  };
  expect((await app.inject(request)).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        ...request,
        payload: { ...request.payload, stream: true },
      })
    ).body,
  ).toContain('[DONE]');
  const entry = app.workerRegistry.entries.get('mock-1')!;
  expect(entry.state.inFlight).toBe(0);
  expect(entry.state.sampleCount).toBe(2);
  expect(entry.state.ewmaTtftMs).toBeGreaterThanOrEqual(0);
  healthFailure = true;
  for (let i = 0; i < config.health.unhealthyAfterFailures; i++)
    await app.workerRegistry.probe('mock-1');
  expect((await app.inject('/readyz')).statusCode).toBe(503);
  expect((await app.inject(request)).statusCode).toBe(503);
  app.workerRegistry.stop();
  expect(entry.state.health).toBe('draining');
  expect(app.workerRegistry.ready).toBe(false);
});

it('keeps workers independent and requires a configured, loaded model for readiness', async () => {
  const config = await loadConfig('config/gateway.yaml', {});
  config.workers.push({ ...config.workers[0], id: 'second' });
  const registry = new WorkerRegistry(config, (worker) => ({
    health: async () => ({ ok: worker.id === 'second', latencyMs: 1 }),
    listModels: async () => ['mock-model'],
    chat: vi.fn(),
    chatStream: vi.fn(),
    close: async () => {},
  }));
  closers.push(() => registry.close());
  await registry.start();
  expect(
    registry.eligible('mock-model').map((entry) => entry.config.id),
  ).toEqual(['second']);
  registry.drain('second');
  expect(registry.ready).toBe(false);
});

it('expires error samples after sixty seconds even below the fifty-sample bound', async () => {
  const { registry, entry } = await fixture();
  await registry.start();
  registry.reserve(entry)({ latencyMs: 100, failed: true });
  expect(entry.state.recentErrorRate).toBe(1);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60001);
  registry.eligible();
  expect(entry.state.recentErrorRate).toBe(0);
});
