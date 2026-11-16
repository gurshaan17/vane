import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SSEInspector } from './streaming.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

it('inspects arbitrary byte and UTF-8 splits and captures terminal usage', () => {
  const inspector = new SSEInspector();
  const data = Buffer.from(
    'data: {"choices":[{"delta":{"content":"😀"}}]}\r\n\r\ndata: {"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n',
  );
  for (const byte of data) inspector.push(Buffer.from([byte]));
  expect(inspector.done).toBe(true);
  expect(inspector.usage).toEqual({ total_tokens: 2 });
});

it('bounds incomplete SSE events', () => {
  expect(() =>
    new SSEInspector().push(Buffer.alloc(1024 * 1024 + 1)),
  ).toThrow();
});

async function fixture(
  source: () => Readable,
  overrides: { first?: number; idle?: number } = {},
) {
  const worker = Fastify();
  worker.post('/v1/chat/completions', (_req, reply) =>
    reply.type('text/event-stream').send(source()),
  );
  const address = await worker.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => worker.close());
  const config = await loadConfig('config/gateway.yaml', {});
  config.workers[0].baseUrl = address;
  config.logging.level = 'silent';
  config.resilience.firstByteTimeoutMs = overrides.first ?? 1000;
  config.resilience.streamIdleTimeoutMs = overrides.idle ?? 1000;
  const results: unknown[] = [];
  const app = createApp(config, {
    onFinalize: (result) => results.push(result),
  });
  closers.push(() => app.close());
  return { app, results };
}
const request = {
  method: 'POST' as const,
  url: '/v1/chat/completions',
  payload: {
    model: 'mock-model',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  },
};

it('forwards bytes and finalizes usage exactly once', async () => {
  const bytes = 'data: {"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n';
  const { app, results } = await fixture(() => Readable.from([bytes]));
  const reply = await app.inject(request);
  expect(reply.statusCode).toBe(200);
  expect(reply.headers['x-accel-buffering']).toBe('no');
  expect(reply.body).toBe(bytes);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    outcome: 'completed',
    usage: { total_tokens: 2 },
  });
});

it('emits one error event when EOF lacks DONE', async () => {
  const { app, results } = await fixture(() => Readable.from(['data: {}\n\n']));
  const reply = await app.inject(request);
  expect(reply.statusCode).toBe(200);
  expect(reply.body.match(/event: error/g)).toHaveLength(1);
  expect(reply.body).not.toContain('[DONE]');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ outcome: 'rejected' });
});

it('times out a silent body before sending SSE headers', async () => {
  const { app } = await fixture(() => new Readable({ read() {} }), {
    first: 30,
  });
  const reply = await app.inject(request);
  expect(reply.statusCode).toBe(504);
  expect(reply.json().error.code).toBe('upstream_timeout');
});

it('times out and destroys an idle stream after headers', async () => {
  let destroyed = false;
  const { app } = await fixture(
    () => {
      const stream = new Readable({ read() {} });
      stream.on('close', () => {
        destroyed = true;
      });
      stream.push('data: {}\n\n');
      return stream;
    },
    { idle: 30 },
  );
  const reply = await app.inject(request);
  expect(reply.body).toContain('event: error');
  expect(reply.body).toContain('upstream_timeout');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(destroyed).toBe(true);
});

it('aborts a stalled consumer and stops the producer', async () => {
  const { proxyStream } = await import('./streaming.js');
  const { EventEmitter } = await import('node:events');
  const config = await loadConfig('config/gateway.yaml', {});
  config.streaming.clientStallMs = 20;
  let produced = 0;
  const source = Readable.from(
    (function* () {
      while (true) {
        produced++;
        yield Buffer.from('data: {}\n\n');
      }
    })(),
  );
  const raw = Object.assign(new EventEmitter(), {
    headersSent: true,
    destroyed: false,
    writableNeedDrain: true,
    write: () => false,
    destroy: () => {
      raw.destroyed = true;
    },
  });
  const controller = new AbortController();
  const lifecycle = { signal: controller.signal, startedAt: Date.now() };
  await proxyStream(
    source,
    { raw, getHeader: () => 'test' } as never,
    lifecycle as never,
    config,
  );
  expect(source.destroyed).toBe(true);
  expect(produced).toBeLessThan(10);
  expect(raw.listenerCount('drain')).toBe(0);
});

it('releases upstream work on client cancellation', async () => {
  const { app } = await fixture(() => {
    const stream = new Readable({ read() {} });
    stream.push('data: {}\n\n');
    return stream;
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.payload),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await expect(reader.read()).rejects.toThrow();
});
