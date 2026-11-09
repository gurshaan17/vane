import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const configPath = process.env.GATEWAY_CONFIG
  ? resolve(process.env.GATEWAY_CONFIG)
  : fileURLToPath(new URL('../../../config/gateway.yaml', import.meta.url));
const config = await loadConfig(configPath);
// Phase 2 preserves the single-worker proxy; routing arrives in later phases.
const worker = config.workers[0];
const app = Fastify({
  logger: { level: config.logging.level },
  bodyLimit: config.server.bodyLimitBytes,
});
app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async () => ({ ready: true }));
app.get('/v1/models', async () => ({
  object: 'list',
  data: config.models.map((model) => ({ id: model.id, object: 'model' })),
}));
app.post('/v1/chat/completions', async (request, reply) => {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once('close', onClose);
  reply.raw.once('finish', () => reply.raw.off('close', onClose));
  const upstream = await fetch(
    `${worker.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(worker.apiKey ? { authorization: `Bearer ${worker.apiKey}` } : {}),
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    },
  );
  reply
    .code(upstream.status)
    .headers(Object.fromEntries(upstream.headers))
    .send(upstream.body ? Readable.fromWeb(upstream.body) : null);
});
await app.listen({ port: config.server.port, host: '0.0.0.0' });
