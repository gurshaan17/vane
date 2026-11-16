import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/gateway/dist/config.js';

const { fetch, AbortSignal } = globalThis;

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(
  new URL('../apps/gateway/package.json', import.meta.url),
);
const OpenAI = require('openai').default;
const temporary = await mkdtemp(join(tmpdir(), 'vane-smoke-'));
const children = [];

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  return {
    child,
    check() {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Service exited during startup: ${output}`);
    },
  };
}

async function ready(url, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    process.check();
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Startup timed out: ${url}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Service did not stop after SIGTERM'));
    }, 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });
}

try {
  const workerPort = await freePort();
  const worker = start('apps/mock-worker/dist/server.js', {
    PORT: String(workerPort),
  });
  await ready(`http://127.0.0.1:${workerPort}/health`, worker);
  const gatewayPort = await freePort();
  const config = await loadConfig(join(root, 'config/gateway.yaml'), {});
  config.server.port = gatewayPort;
  config.logging.level = 'silent';
  config.workers[0].baseUrl = `http://127.0.0.1:${workerPort}`;
  const configPath = join(temporary, 'gateway.json');
  await writeFile(configPath, JSON.stringify(config));
  const gateway = start('apps/gateway/dist/server.js', {
    GATEWAY_CONFIG: configPath,
  });
  await ready(`http://127.0.0.1:${gatewayPort}/healthz`, gateway);
  const client = new OpenAI({
    apiKey: 'local-smoke-only',
    baseURL: `http://127.0.0.1:${gatewayPort}/v1`,
    maxRetries: 0,
  });
  const { data, response } = await client.chat.completions
    .create(
      {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Compiled SDK smoke' }],
      },
      { headers: { 'x-request-id': 'compiled-sdk-smoke' } },
    )
    .withResponse();
  assert.equal(data.choices[0].message.content, 'Compiled SDK smoke');
  assert.equal(data.model, 'mock-model');
  assert.equal(response.headers.get('x-request-id'), 'compiled-sdk-smoke');
  assert.equal(response.headers.get('x-gateway-worker'), 'mock-1');
  let streamed = '';
  let usage;
  const stream = await client.chat.completions.create({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'Streaming 😀 smoke' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const chunk of stream) {
    streamed += chunk.choices[0]?.delta.content ?? '';
    if (chunk.usage) usage = chunk.usage;
  }
  assert.equal(streamed, 'Streaming 😀 smoke');
  assert.equal(usage.total_tokens, 2);
  assert.deepEqual(
    (await client.models.list()).data.map((model) => model.id),
    ['mock-model'],
  );
  await assert.rejects(
    client.chat.completions.create({
      model: 'missing',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
    { status: 404, code: 'model_not_found' },
  );
  assert.deepEqual(await stop(gateway.child), { code: 0, signal: null });
  console.log(
    JSON.stringify({
      node: process.version,
      compiledChat: 'passed',
      compiledStreaming: 'passed',
      compiledModels: 'passed',
      unknownModel: 'passed',
      gracefulShutdown: 'passed',
    }),
  );
} finally {
  await Promise.all(children.map(stop));
  await rm(temporary, { recursive: true, force: true });
}
