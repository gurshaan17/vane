import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const Config = z.object({
  server: z.object({
    port: z.number().int().positive(),
    workerUrl: z.string().url(),
    model: z.string(),
  }),
});
const configPath = process.env.GATEWAY_CONFIG
  ? resolve(process.env.GATEWAY_CONFIG)
  : fileURLToPath(new URL('../../../config/gateway.yaml', import.meta.url));
const config = Config.parse(parse(await readFile(configPath, 'utf8')));
const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async () => ({ ready: true }));
app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: config.server.model, object: 'model' }],
}));
app.post('/v1/chat/completions', async (request, reply) => {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once('close', onClose);
  reply.raw.once('finish', () => reply.raw.off('close', onClose));
  const upstream = await fetch(
    `${config.server.workerUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
