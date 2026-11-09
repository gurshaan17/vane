import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { validateConfig, type GatewayConfig } from '@gateway/shared';

export async function readConfigFile(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Cannot read gateway configuration: ${path}`);
  }
  try {
    return parse(source);
  } catch {
    throw new Error(`Invalid YAML in gateway configuration: ${path}`);
  }
}
export function resolveSecrets(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const required = (name: string, path: string, hash = false) => {
    const value = env[name];
    if (!value?.trim())
      throw new Error(
        `Missing required secret at ${path} (environment variable ${name})`,
      );
    if (hash && !/^[a-fA-F0-9]{64}$/.test(value))
      throw new Error(
        `Invalid SHA-256 secret at ${path} (environment variable ${name})`,
      );
    return value;
  };
  return {
    ...config,
    auth: {
      ...config.auth,
      keys: config.auth.keys.map((key, i) => ({
        ...key,
        hash: required(key.hashEnv, `auth.keys.${i}.hashEnv`, true),
      })),
    },
    workers: config.workers.map((worker, i) => ({
      ...worker,
      ...(worker.apiKeyEnv
        ? { apiKey: required(worker.apiKeyEnv, `workers.${i}.apiKeyEnv`) }
        : {}),
    })),
  };
}
export type ResolvedConfig = ReturnType<typeof resolveSecrets>;
export function redactConfig(config: ResolvedConfig) {
  return {
    ...config,
    auth: {
      ...config.auth,
      keys: config.auth.keys.map((key) => ({ ...key, hash: '[REDACTED]' })),
    },
    workers: config.workers.map((worker) => ({
      ...worker,
      ...(worker.apiKey !== undefined ? { apiKey: '[REDACTED]' } : {}),
    })),
  };
}
export async function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  return resolveSecrets(validateConfig(await readConfigFile(path)), env);
}
