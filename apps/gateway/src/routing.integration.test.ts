import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import type { FinalizedRequest } from './lifecycle.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
it('routes real requests, records decisions and enforces atomic capacity across concurrent HTTP work', async () => {
  const config = await loadConfig('config/gateway.yaml', {});
  config.logging.level = 'silent';
  config.routing.strategy = 'round_robin';
  config.models[0].aliases.push('alias');
  const template = config.workers[0];
  config.workers = [];
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    for (let i = 0; i < 2; i++) {
      const worker = Fastify();
      closers.push(() => worker.close());
      worker.get('/health', async () => ({ ok: true }));
      worker.get('/v1/models', async () => ({ data: [{ id: 'mock-model' }] }));
      worker.post('/v1/chat/completions', async () => {
        if (hold) await gate;
        return { choices: [], model: 'mock-model' };
      });
      const baseUrl = await worker.listen({ port: 0, host: '127.0.0.1' });
      config.workers.push({
        ...template,
        id: `worker-${i}`,
        baseUrl,
        maxConcurrency: 1,
      });
    }
    const results: FinalizedRequest[] = [];
    const app = createApp(config, {
      onFinalize: (result) => results.push(result),
    });
    closers.push(() => app.close());
    await app.ready();
    const request = {
      method: 'POST' as const,
      url: '/v1/chat/completions',
      payload: { model: 'alias', messages: [{ role: 'user', content: 'Hi' }] },
    };
    const workers: unknown[] = [];
    for (let i = 0; i < 4; i++)
      workers.push((await app.inject(request)).headers['x-gateway-worker']);
    expect(workers).toEqual(['worker-0', 'worker-1', 'worker-0', 'worker-1']);
    expect(results[0].decision).toMatchObject({
      strategy: 'round_robin',
      workerId: 'worker-0',
      modelRequested: 'alias',
      modelSelected: 'mock-model',
      attempts: 1,
      status: 200,
    });
    for (const strategy of ['least_in_flight', 'power_of_two']) {
      const response = await app.inject({
        ...request,
        headers: { 'x-gateway-routing': strategy },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-gateway-routing']).toBe(strategy);
      expect(results.at(-1)!.decision?.strategy).toBe(strategy);
    }
    expect(
      (
        await app.inject({
          ...request,
          headers: { 'x-gateway-routing': 'adaptive' },
        })
      ).statusCode,
    ).toBe(400);
    hold = true;
    const first = app.inject(request).then((response) => response);
    const second = app.inject(request).then((response) => response);
    await vi.waitFor(() =>
      expect(
        [...app.workerRegistry.entries.values()].map(
          (entry) => entry.state.inFlight,
        ),
      ).toEqual([1, 1]),
    );
    const overloaded = await app.inject(request);
    expect(overloaded.statusCode).toBe(503);
    expect(overloaded.json().error.code).toBe('gateway_overloaded');
    release();
    expect(
      (await Promise.all([first, second])).map(
        (response) => response.statusCode,
      ),
    ).toEqual([200, 200]);
    expect(
      [...app.workerRegistry.entries.values()].map(
        (entry) => entry.state.inFlight,
      ),
    ).toEqual([0, 0]);
    app.workerRegistry.drain('worker-0');
    expect((await app.inject(request)).headers['x-gateway-worker']).toBe(
      'worker-1',
    );
  } finally {
    release();
  }
});
