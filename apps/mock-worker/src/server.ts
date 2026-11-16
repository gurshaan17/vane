import { readFile } from 'node:fs/promises';
import { createMockApp } from './app.js';

const app = createMockApp({
  profile: process.env.MOCK_PROFILE,
  settings: process.env.MOCK_CONFIG
    ? JSON.parse(await readFile(process.env.MOCK_CONFIG, 'utf8'))
    : undefined,
  enableControl: process.env.MOCK_ENABLE_CONTROL === '1',
  logger: true,
});
await app.listen({
  port: Number(process.env.PORT ?? 8081),
  host: process.env.MOCK_HOST ?? '127.0.0.1',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
