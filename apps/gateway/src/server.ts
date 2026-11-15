import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const configPath = process.env.GATEWAY_CONFIG
  ? resolve(process.env.GATEWAY_CONFIG)
  : fileURLToPath(new URL('../../../config/gateway.yaml', import.meta.url));
const config = await loadConfig(configPath);
const app = createApp(config);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void app.close().catch((error: unknown) => {
    app.log.error(error, 'Gateway shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  await app.listen({ port: config.server.port, host: '0.0.0.0' });
} catch (error) {
  await app.close();
  throw error;
}
