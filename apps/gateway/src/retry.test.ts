import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { RetryBudget, backoff, retryAfter, waitForRetry } from './retry.js';
import type { FinalizedRequest } from './lifecycle.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
it('bounds backoff and Retry-After values', () => {
  expect(backoff(1, () => 0.5)).toBe(25);
  expect(backoff(20, () => 0.5)).toBe(250);
  expect(backoff(1, () => 0, 100)).toBe(100);
  expect(retryAfter('2')).toBe(2000);
  expect(retryAfter('0.1')).toBe(100);
  expect(
    retryAfter(
      'Wed, 21 Oct 2015 07:28:00 GMT',
      Date.parse('Wed, 21 Oct 2015 07:27:59 GMT'),
    ),
  ).toBe(1000);
  expect(retryAfter('invalid')).toBeUndefined();
  expect(retryAfter('-1')).toBeUndefined();
});
it('shares a rolling retry allowance and expires old traffic', () => {
  let now = 0;
  const budget = new RetryBudget(
    { ratio: 0.1, minRetries: 1, windowMs: 10000 },
    () => now,
  );
  budget.recordRequest();
  expect(budget.take()).toBe(true);
  expect(budget.take()).toBe(false);
  for (let i = 1; i < 20; i++) budget.recordRequest();
  expect(budget.take()).toBe(true);
  expect(budget.take()).toBe(false);
  now = 10001;
  budget.recordRequest();
  expect(budget.take()).toBe(true);
});
it('cancels backoff promptly', async () => {
  const controller = new AbortController();
  const pending = waitForRetry(500, controller.signal);
  controller.abort(new Error('Cancelled'));
  await expect(pending).rejects.toThrow();
});

const request = {
  method: 'POST' as const,
  url: '/v1/chat/completions',
  payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
};
async function fixture(
  mode: number | 'silent' | 'broken' | 'disconnect' | 'json-silent',
  maxAttempts = 2,
  retryAfterHeader = '0',
) {
  const config = await loadConfig('config/gateway.yaml', {});
  config.logging.level = 'silent';
  config.routing.strategy = 'round_robin';
  config.resilience.maxAttempts = maxAttempts;
  config.resilience.firstByteTimeoutMs = 60;
  const template = config.workers[0];
  config.workers = [];
  const calls = [0, 0];
  for (let i = 0; i < 2; i++) {
    const worker = Fastify();
    closers.push(() => worker.close());
    worker.get('/health', async () => ({ ok: true }));
    worker.get('/v1/models', async () => ({ data: [{ id: 'mock-model' }] }));
    worker.post('/v1/chat/completions', async (req, reply) => {
      calls[i]++;
      if (i === 0) {
        if (typeof mode === 'number')
          return reply
            .code(mode)
            .header('retry-after', retryAfterHeader)
            .send({ error: 'injected' });
        if (mode === 'disconnect') {
          reply.hijack();
          reply.raw.destroy();
          return;
        }
        if (mode === 'silent' || mode === 'json-silent') {
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type':
              mode === 'silent' ? 'text/event-stream' : 'application/json',
          });
          reply.raw.flushHeaders();
          return;
        }
        if (mode === 'broken') {
          reply.hijack();
          reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
          reply.raw.end('data: {}\n\n');
          return;
        }
      }
      if ((req.body as { stream?: boolean }).stream)
        return reply
          .type('text/event-stream')
          .send('data: {}\n\ndata: [DONE]\n\n');
      return { choices: [], model: 'mock-model' };
    });
    config.workers.push({
      ...template,
      id: `w${i}`,
      baseUrl: await worker.listen({ port: 0, host: '127.0.0.1' }),
    });
  }
  const results: FinalizedRequest[] = [];
  const app = createApp(config, {
    onFinalize: (result) => results.push(result),
  });
  closers.push(() => app.close());
  return { app, calls, results };
}
it.each([429, 502, 503, 504, 'disconnect', 'json-silent'] as const)(
  'retries eligible JSON failure %s on a different worker',
  async (mode) => {
    const { app, calls, results } = await fixture(mode);
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([1, 1]);
    expect(response.headers['x-gateway-attempts']).toBe('2');
    expect(results[0].decision).toMatchObject({ attempts: 2, workerId: 'w1' });
    expect(
      [...app.workerRegistry.entries.values()].map(
        (entry) => entry.state.inFlight,
      ),
    ).toEqual([0, 0]);
    expect(app.workerRegistry.entries.get('w0')!.state.recentErrorRate).toBe(
      mode === 429 ? 0 : 1,
    );
  },
);
it.each([400, 401, 403, 404, 422, 500])(
  'does not retry HTTP %s',
  async (status) => {
    const { app, calls } = await fixture(status);
    expect((await app.inject(request)).statusCode).toBe(502);
    expect(calls).toEqual([1, 0]);
    expect(app.workerRegistry.entries.get('w0')!.state.recentErrorRate).toBe(
      status >= 500 ? 1 : 0,
    );
  },
);
it('retries silent SSE before any client bytes and preserves the first chunk', async () => {
  const { app, calls } = await fixture('silent');
  const response = await app.inject({
    ...request,
    payload: { ...request.payload, stream: true },
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain('[DONE]');
  expect(calls).toEqual([1, 1]);
  expect(response.headers['x-gateway-attempts']).toBe('2');
});
it('never retries after the stream starts', async () => {
  const { app, calls } = await fixture('broken');
  const response = await app.inject({
    ...request,
    payload: { ...request.payload, stream: true },
  });
  expect(response.body).toContain('event: error');
  expect(calls).toEqual([1, 0]);
});
it('honors maxAttempts and a request deadline shorter than first-byte timeout', async () => {
  const { app, calls } = await fixture(503, 1);
  expect((await app.inject(request)).statusCode).toBe(502);
  expect(calls).toEqual([1, 0]);
  const other = await fixture('silent');
  expect(
    (
      await other.app.inject({
        ...request,
        headers: { 'x-gateway-timeout-ms': '20' },
        payload: { ...request.payload, stream: true },
      })
    ).statusCode,
  ).toBe(504);
  expect(other.calls).toEqual([1, 0]);
  await vi.waitFor(() =>
    expect(
      [...other.app.workerRegistry.entries.values()].every(
        (entry) => entry.state.inFlight === 0,
      ),
    ).toBe(true),
  );
});

it('does not retry earlier than a Retry-After exceeding the 500ms wait bound', async () => {
  const { app, calls } = await fixture(429, 2, '2');
  expect((await app.inject(request)).statusCode).toBe(502);
  expect(calls).toEqual([1, 0]);
});
