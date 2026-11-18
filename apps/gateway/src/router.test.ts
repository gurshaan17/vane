import { afterEach, expect, it } from 'vitest';
import type { GatewayRequest, RouteContext } from '@gateway/shared';
import { loadConfig } from './config.js';
import { WorkerRegistry } from './registry.js';
import { WorkerRouter, baselineStrategy } from './router.js';

const registries: WorkerRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
});
async function fixture(random = () => 0, count = 3) {
  const config = await loadConfig('config/gateway.yaml', {});
  const worker = config.workers[0];
  config.workers = Array.from({ length: count }, (_, i) => ({
    ...worker,
    id: `w${i}`,
    models: { a: 'loaded', b: 'loaded' },
    maxConcurrency: 10,
  }));
  const registry = new WorkerRegistry(config, () => ({
    health: async () => ({ ok: true, latencyMs: 1 }),
    listModels: async () => ['loaded'],
    chat: async () => ({ statusCode: 200, body: {} }),
    chatStream: async () => {
      throw new Error('Unused');
    },
    close: async () => {},
  }));
  registries.push(registry);
  await registry.start();
  const request: GatewayRequest = {
    id: 'test',
    keyId: 'anonymous',
    endpoint: 'chat',
    body: {},
    model: 'a',
    stream: false,
    priority: 'balanced',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10000,
  };
  const ctx: RouteContext = {
    request,
    model: 'a',
    triedWorkerIds: new Set(),
    attempt: 1,
  };
  return {
    registry,
    router: new WorkerRouter(registry, random),
    ctx,
    entries: [...registry.entries.values()],
  };
}

it('rotates per model without cursor interference', async () => {
  const { router, ctx } = await fixture();
  const pick = (model: string) => {
    const result = router.select({ ...ctx, model }, 'round_robin');
    result.release({ cancelled: true, latencyMs: 0 });
    return result.entry.config.id;
  };
  expect([
    pick('a'),
    pick('a'),
    pick('b'),
    pick('a'),
    pick('b'),
    pick('a'),
  ]).toEqual(['w0', 'w1', 'w0', 'w2', 'w1', 'w0']);
});

it('chooses least load and breaks ties using injected randomness', async () => {
  const { router, entries, ctx } = await fixture(() => 0.99);
  entries[0].state.inFlight = 5;
  entries[1].state.inFlight = 1;
  entries[2].state.inFlight = 1;
  const result = router.select(ctx, 'least_in_flight');
  expect(result.entry.config.id).toBe('w2');
  expect(result.entry.state.inFlight).toBe(2);
  result.release({ cancelled: true, latencyMs: 0 });
  expect(result.entry.state.inFlight).toBe(1);
});

it('samples distinct workers with two candidates even when RNG always returns zero', async () => {
  const { router, entries, ctx } = await fixture(() => 0, 2);
  entries[0].state.inFlight = 3;
  const result = router.select(ctx, 'power_of_two');
  expect(result.entry.config.id).toBe('w1');
  result.release({ cancelled: true, latencyMs: 0 });
});

it('excludes all forbidden candidates for every baseline strategy', async () => {
  for (const strategy of [
    'round_robin',
    'least_in_flight',
    'power_of_two',
  ] as const) {
    const { router, entries, ctx } = await fixture(() => 0, 9);
    entries[0].state.health = 'unhealthy';
    entries[1].state.health = 'draining';
    entries[2].state.loadedModels.clear();
    entries[3].state.breaker = 'open';
    entries[4].state.breaker = 'half_open';
    ctx.triedWorkerIds.add('w5');
    entries[6].state.inFlight = 10;
    delete entries[7].config.models.a;
    const result = router.select(ctx, strategy);
    expect(result.entry.config.id).toBe('w8');
    result.release({ cancelled: true, latencyMs: 0 });
  }
});

it('reserves synchronously and distinguishes saturation from absent workers', async () => {
  const { router, entries, ctx } = await fixture(() => 0, 2);
  for (const entry of entries) entry.config.maxConcurrency = 1;
  const first = router.select(ctx, 'least_in_flight');
  const second = router.select(ctx, 'least_in_flight');
  expect(first.entry).not.toBe(second.entry);
  expect(() => router.select(ctx, 'least_in_flight')).toThrow(
    expect.objectContaining({ code: 'gateway_overloaded' }),
  );
  first.release({ cancelled: true, latencyMs: 0 });
  first.release({ cancelled: true, latencyMs: 0 });
  const third = router.select(ctx, 'least_in_flight');
  expect(third.entry).toBe(first.entry);
  second.release({ cancelled: true, latencyMs: 0 });
  third.release({ cancelled: true, latencyMs: 0 });
  entries.forEach((entry) => {
    entry.state.health = 'unhealthy';
  });
  expect(() => router.select(ctx, 'least_in_flight')).toThrow(
    expect.objectContaining({ code: 'no_healthy_worker' }),
  );
});

it('calls breaker trial admission only for the selected candidate and respects rejection', async () => {
  const { registry, entries, ctx } = await fixture();
  entries[0].state.breaker = 'half_open';
  const tried: string[] = [];
  const router = new WorkerRouter(registry, () => 0, {
    canAdmit: () => true,
    admit: (entry) => {
      tried.push(entry.config.id);
      return entry.config.id !== 'w0';
    },
  });
  const result = router.select(ctx, 'least_in_flight');
  expect(tried).toEqual(['w0', 'w1']);
  expect(entries[0].state.inFlight).toBe(0);
  expect(result.entry.config.id).toBe('w1');
  result.release({ cancelled: true, latencyMs: 0 });
});

it('never selects excluded workers across reproducible generated states', async () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const { router, entries, ctx } = await fixture(random, 10);
  for (let i = 0; i < 200; i++) {
    ctx.triedWorkerIds.clear();
    for (const entry of entries) {
      entry.state.health = random() < 0.25 ? 'unhealthy' : 'degraded';
      entry.state.breaker = random() < 0.25 ? 'open' : 'closed';
      entry.state.inFlight = Math.floor(random() * 12);
      if (random() < 0.25) ctx.triedWorkerIds.add(entry.config.id);
    }
    for (const strategy of [
      'round_robin',
      'least_in_flight',
      'power_of_two',
    ] as const) {
      const valid = router
        .candidates(ctx)
        .filter((entry) => entry.state.inFlight < entry.config.maxConcurrency);
      if (!valid.length) {
        expect(() => router.select(ctx, strategy)).toThrow();
        continue;
      }
      const result = router.select(ctx, strategy);
      expect(valid).toContain(result.entry);
      expect(result.entry.state.inFlight).toBeLessThanOrEqual(
        result.entry.config.maxConcurrency,
      );
      result.release({ cancelled: true, latencyMs: 0 });
    }
  }
});

it('handles single candidates, cancellation and unsupported strategies', async () => {
  const { router, ctx } = await fixture(() => 0, 1);
  const result = router.select(ctx, 'power_of_two');
  result.release({ cancelled: true, latencyMs: 0 });
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  expect(() =>
    router.select(
      { ...ctx, request: { ...ctx.request, signal: controller.signal } },
      'round_robin',
    ),
  ).toThrow('Cancelled');
  expect(() => baselineStrategy('adaptive')).toThrow(
    'Adaptive routing is not implemented',
  );
});
