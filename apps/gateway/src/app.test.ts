import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { validateConfig, type GatewayRequest } from '@gateway/shared';
import { createApp, type ChatDispatch } from './app.js';
import { resolveSecrets } from './config.js';
import { GatewayError } from './errors.js';
import type { FinalizedRequest } from './lifecycle.js';

const payload = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Hello' }],
};
const config = () =>
  resolveSecrets(
    validateConfig({
      logging: { level: 'silent' },
      models: [
        {
          id: 'mock-model',
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
          baseUrl: 'http://127.0.0.1:1',
          models: { 'mock-model': 'mock-model' },
          maxConcurrency: 16,
        },
      ],
    }),
    {},
  );
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(
  mutate?: (value: ReturnType<typeof config>) => void,
  dispatchChat?: ChatDispatch,
) {
  const settings = config();
  mutate?.(settings);
  const finalized: FinalizedRequest[] = [];
  const dispatch = vi.fn<ChatDispatch>(
    dispatchChat ?? (async () => ({ statusCode: 200, body: { choices: [] } })),
  );
  const app = createApp(settings, {
    dispatchChat: dispatch,
    onFinalize: (result) => finalized.push(result),
  });
  apps.push(app);
  return { app, dispatch, finalized };
}
function stalled(request: GatewayRequest): ReturnType<ChatDispatch> {
  return new Promise((_resolve, reject) => {
    request.signal.throwIfAborted();
    request.signal.addEventListener(
      'abort',
      () => reject(request.signal.reason),
      { once: true },
    );
  });
}
function checkError(
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json(): {
      error: {
        code: string;
        type: string;
        message: string;
        request_id: string;
      };
    };
  },
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json().error).toEqual({
    code,
    type: expect.any(String),
    message: expect.any(String),
    request_id: response.headers['x-request-id'],
  });
}

describe('HTTP validation and normalization', () => {
  it('constructs without listening and preserves OpenAI SDK fields and message variants', async () => {
    const { app, dispatch, finalized } = setup();
    expect(app.server.listening).toBe(false);
    const body = {
      ...payload,
      temperature: 0.3,
      future_option: { enabled: true },
      messages: [
        { role: 'developer', content: 'Be precise', name: 'dev' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/image' },
            },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'call-1' },
      ],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(dispatch.mock.calls[0][0].body).toEqual(body);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      endpoint: 'chat',
      model: 'mock-model',
      stream: false,
      priority: 'balanced',
    });
    expect(finalized).toHaveLength(1);
    expect(finalized[0].outcome).toBe('completed');
  });

  it.each([
    null,
    [],
    {},
    { ...payload, model: '' },
    { ...payload, model: 1 },
    { ...payload, messages: [] },
    { ...payload, messages: [{}] },
    { ...payload, messages: [{ role: 'bogus', content: 'x' }] },
    { ...payload, messages: [{ role: 'user', content: 1 }] },
    { ...payload, messages: [{ role: 'user' }] },
    { ...payload, stream: 'true' },
    { ...payload, gateway: [] },
  ])('rejects malformed envelope %j before dispatch', async (body) => {
    const { app, dispatch, finalized } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    checkError(response, 400, 'invalid_request');
    expect(dispatch).not.toHaveBeenCalled();
    expect(finalized).toMatchObject([
      { outcome: 'rejected', errorCode: 'invalid_request' },
    ]);
  });

  it.each(['{', ''])('normalizes JSON parser failures for %j', async (body) => {
    const { app, dispatch, finalized } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    checkError(response, 400, 'invalid_request');
    expect(dispatch).not.toHaveBeenCalled();
    expect(finalized).toHaveLength(1);
  });

  it('rejects unsupported content types with a stable envelope', async () => {
    const { app } = setup();
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/octet-stream' },
        payload: 'hi',
      }),
      400,
      'invalid_request',
    );
  });

  it('enforces body size before validation', async () => {
    const { app, dispatch, finalized } = setup((c) => {
      c.server.bodyLimitBytes = 64;
    });
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      }),
      413,
      'request_too_large',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(finalized).toHaveLength(1);
  });

  it('enforces the message count and accepts its exact boundary', async () => {
    const { app, dispatch } = setup((c) => {
      c.server.maxMessages = 1;
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload,
        })
      ).statusCode,
    ).toBe(200);
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...payload,
          messages: [...payload.messages, ...payload.messages],
        },
      }),
      413,
      'request_too_large',
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['bytes', 'count'])('enforces header %s limits', async (limit) => {
    const { app, dispatch, finalized } = setup((c) => {
      if (limit === 'bytes') c.server.maxHeaderBytes = 100;
      else c.server.maxHeaders = 2;
    });
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'x-padding': 'x'.repeat(100) },
        payload,
      }),
      431,
      'invalid_request',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(finalized).toHaveLength(1);
  });

  it('gives headers precedence over corresponding body extensions', async () => {
    const { app, dispatch } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...payload,
        gateway: {
          priority: 'invalid-but-overridden',
          task: 'chat',
          timeoutMs: 5000,
          routing: 'round_robin',
        },
      },
      headers: {
        'x-gateway-priority': 'high_quality',
        'x-gateway-task': 'code',
        'x-gateway-timeout-ms': '1000',
        'x-gateway-cache': 'bypass',
        'x-gateway-routing': 'power_of_two',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(dispatch.mock.calls[0][1]).toEqual({
      priority: 'high_quality',
      task: 'code',
      timeoutMs: 1000,
      cache: 'bypass',
      routing: 'power_of_two',
    });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      priority: 'high_quality',
      taskHint: 'code',
    });
  });

  it('uses body extensions and configured priority defaults', async () => {
    const { app, dispatch } = setup((c) => {
      c.selector.defaultPriority = 'low_latency';
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...payload, gateway: { task: 'reasoning', cache: 'bypass' } },
    });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      priority: 'low_latency',
      taskHint: 'reasoning',
    });
    expect(dispatch.mock.calls[0][1]).toEqual({
      task: 'reasoning',
      cache: 'bypass',
    });
  });

  it.each([
    '0',
    '-1',
    '1.5',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
    '1, 2',
    ' 100 ',
  ])('rejects invalid timeout header %s', async (value) => {
    const { app, dispatch } = setup();
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
        headers: { 'x-gateway-timeout-ms': value },
      }),
      400,
      'invalid_request',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { priority: 'fast' },
    { task: 'unknown' },
    { cache: 'hit' },
    { timeoutMs: '100' },
    { timeoutMs: 0 },
    { routing: 'random' },
    { unsupported: true },
  ])('rejects invalid body extensions %j', async (gateway) => {
    const { app, dispatch } = setup();
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...payload, gateway },
      }),
      400,
      'invalid_request',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['priority', 'task', 'cache', 'routing'])(
    'rejects invalid %s headers even with a valid body',
    async (name) => {
      const { app, dispatch } = setup();
      checkError(
        await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload,
          headers: { [`x-gateway-${name}`]: 'invalid' },
        }),
        400,
        'invalid_request',
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});

describe('request identity, errors and finalization', () => {
  it.each(['/healthz', '/readyz', '/v1/models', '/missing'])(
    'returns a safe inbound ID on %s',
    async (url) => {
      const { app, finalized } = setup();
      const response = await app.inject({
        url,
        headers: { 'x-request-id': 'r-123.test_ok' },
      });
      expect(response.headers['x-request-id']).toBe('r-123.test_ok');
      if (url === '/missing') checkError(response, 404, 'not_found');
      expect(finalized).toHaveLength(1);
      expect(finalized[0].requestId).toBe('r-123.test_ok');
    },
  );
  it.each([undefined, '', 'unsafe id', 'a'.repeat(129), '<script>'])(
    'replaces unsafe ID %j with UUID v7',
    async (id) => {
      const { app } = setup();
      const response = await app.inject({
        url: '/healthz',
        headers: id === undefined ? {} : { 'x-request-id': id },
      });
      expect(response.headers['x-request-id']).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
      );
    },
  );
  it('normalizes dispatch errors without exposing internal details', async () => {
    const { app, finalized } = setup(undefined, async () => {
      throw new Error('secret-worker-token');
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload,
    });
    checkError(response, 500, 'internal_error');
    expect(response.body).not.toContain('secret-worker-token');
    expect(finalized).toMatchObject([
      { outcome: 'rejected', statusCode: 500, errorCode: 'internal_error' },
    ]);
  });
  it('preserves intentional gateway errors', async () => {
    const { app, finalized } = setup(undefined, async () => {
      throw new GatewayError(
        502,
        'upstream_error',
        'Worker failed',
        'server_error',
      );
    });
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      }),
      502,
      'upstream_error',
    );
    expect(finalized).toHaveLength(1);
  });
  it('aborts stalled dispatch at a shortened deadline and finalizes once', async () => {
    const { app, dispatch, finalized } = setup(undefined, stalled);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...payload, gateway: { timeoutMs: 30 } },
    });
    checkError(response, 504, 'upstream_timeout');
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(finalized).toMatchObject([
      { outcome: 'timeout', statusCode: 504, errorCode: 'upstream_timeout' },
    ]);
  });
  it('never extends the configured deadline', async () => {
    const { app, finalized } = setup((c) => {
      c.server.defaultTimeoutMs = 30;
    }, stalled);
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
        headers: { 'x-gateway-timeout-ms': '50000' },
      }),
      504,
      'upstream_timeout',
    );
    expect(finalized).toHaveLength(1);
  });
  it('clears the deadline after success', async () => {
    const { app, dispatch, finalized } = setup((c) => {
      c.server.defaultTimeoutMs = 30;
    });
    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(false);
    expect(finalized).toHaveLength(1);
  });
});

describe('real HTTP boundaries', () => {
  it('aborts upstream work on client disconnect and finalizes once', async () => {
    const { app, dispatch, finalized } = setup(undefined, stalled);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = httpRequest(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify(payload));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    client.destroy();
    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(finalized).toMatchObject([
      { outcome: 'cancelled', statusCode: 499 },
    ]);
  });
  it('finalizes an aborted request body before dispatch', async () => {
    const { app, dispatch, finalized } = setup();
    let entered!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.addHook('onRequest', async () => {
      entered();
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = httpRequest(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1000' },
    });
    client.on('error', () => {});
    client.write('{');
    await received;
    client.destroy();
    await vi.waitFor(() => expect(finalized).toHaveLength(1));
    expect(finalized[0].outcome).toBe('cancelled');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(['configured', 'header'])(
    'applies the %s deadline while the body is still arriving',
    async (source) => {
      const { app, dispatch, finalized } = setup((c) => {
        c.server.defaultTimeoutMs = source === 'configured' ? 30 : 1000;
      });
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await new Promise<{ status?: number; body: string }>(
        (resolve, reject) => {
          const client = httpRequest(
            `${address}/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': '1000',
                ...(source === 'header'
                  ? { 'x-gateway-timeout-ms': '30' }
                  : {}),
              },
            },
            (res) => {
              let body = '';
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () => {
                client.destroy();
                resolve({ status: res.statusCode, body });
              });
            },
          );
          client.on('error', reject);
          client.write('{');
        },
      );
      expect(response.status).toBe(504);
      expect(JSON.parse(response.body).error.code).toBe('upstream_timeout');
      expect(dispatch).not.toHaveBeenCalled();
      expect(finalized).toHaveLength(1);
      expect(finalized[0].durationMs).toBeLessThan(500);
    },
  );
  it('returns the standard error envelope on HTTP parser header overflow', async () => {
    const { app, dispatch } = setup((c) => {
      c.server.maxHeaderBytes = 256;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP address');
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1');
      let received = '';
      socket.on('connect', () =>
        socket.write(
          `GET /healthz HTTP/1.1\r\nHost: localhost\r\nX-Large: ${'x'.repeat(1000)}\r\n\r\n`,
        ),
      );
      socket.on('data', (chunk) => {
        received += chunk;
      });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    expect(response).toContain('HTTP/1.1 431');
    const body = JSON.parse(response.split('\r\n\r\n')[1]);
    expect(body.error.code).toBe('invalid_request');
    expect(response).toContain(`x-request-id: ${body.error.request_id}`);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('cancels a response stream after headers when its deadline expires', async () => {
    const stream = new Readable({ read() {} });
    const { app, finalized } = setup(
      (c) => {
        c.server.defaultTimeoutMs = 100;
      },
      async () => {
        stream.push('data: partial\n\n');
        return {
          statusCode: 200,
          contentType: 'text/event-stream',
          body: stream,
        };
      },
    );
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(
        `${address}/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('close', resolve);
        },
      );
      client.on('error', reject);
      client.end(JSON.stringify({ ...payload, stream: true }));
    });
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    expect(finalized).toMatchObject([{ outcome: 'timeout' }]);
  });
  it('proxies real JSON and keeps the gateway request ID authoritative', async () => {
    const worker = Fastify();
    apps.push(worker as ReturnType<typeof createApp>);
    worker.post('/v1/chat/completions', async (request, reply) => {
      reply.header('x-request-id', 'worker-id');
      return { object: 'chat.completion', echoed: request.body };
    });
    const settings = config();
    settings.workers[0].baseUrl = await worker.listen({
      port: 0,
      host: '127.0.0.1',
    });
    const app = createApp(settings);
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload,
      headers: { 'x-request-id': 'gateway-id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: 'chat.completion',
      echoed: payload,
    });
    expect(response.headers['x-request-id']).toBe('gateway-id');
  });
});

describe('proxy cancellation and failures', () => {
  it('propagates deadline cancellation through fetch to the worker connection', async () => {
    const worker = Fastify();
    apps.push(worker as ReturnType<typeof createApp>);
    let disconnected = false;
    worker.post('/v1/chat/completions', async (_request, reply) => {
      reply.raw.once('close', () => {
        disconnected = true;
      });
      return reply;
    });
    const settings = config();
    settings.server.defaultTimeoutMs = 200;
    settings.workers[0].baseUrl = await worker.listen({
      port: 0,
      host: '127.0.0.1',
    });
    const finalized: FinalizedRequest[] = [];
    const app = createApp(settings, {
      onFinalize: (result) => finalized.push(result),
    });
    apps.push(app);
    checkError(
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      }),
      504,
      'upstream_timeout',
    );
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(finalized).toMatchObject([
      { outcome: 'timeout', errorCode: 'upstream_timeout' },
    ]);
  });

  it.each(['http', 'json', 'connection'])(
    'normalizes upstream %s failures',
    async (failure) => {
      const settings = config();
      if (failure !== 'connection') {
        const worker = Fastify();
        apps.push(worker as ReturnType<typeof createApp>);
        worker.post('/v1/chat/completions', async (_request, reply) => {
          return reply
            .code(failure === 'http' ? 503 : 200)
            .type('text/plain')
            .send('private upstream error');
        });
        settings.workers[0].baseUrl = await worker.listen({
          port: 0,
          host: '127.0.0.1',
        });
      }
      const app = createApp(settings);
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      });
      checkError(response, 502, 'upstream_error');
      expect(response.body).not.toContain('private upstream error');
    },
  );
});
