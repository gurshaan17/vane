import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const Config = z.object({ server: z.object({ port: z.number().int().positive(), workerUrl: z.string().url(), model: z.string() }) });
const config = Config.parse(parse(await readFile(new URL('../../../config/gateway.yaml', import.meta.url), 'utf8')));
const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async () => ({ ready: true }));
app.get('/v1/models', async () => ({ object: 'list', data: [{ id: config.server.model, object: 'model' }] }));
app.post('/v1/chat/completions', async (request, reply) => {
  const upstream = await fetch(`${config.server.workerUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body), signal: request.signal });
  reply.code(upstream.status).headers(Object.fromEntries(upstream.headers)).send(upstream.body);
});
await app.listen({ port: config.server.port, host: '0.0.0.0' });
