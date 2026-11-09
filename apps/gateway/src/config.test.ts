import { describe, expect, it } from 'vitest';
import { validateConfig, requestExtensionsSchema } from '@gateway/shared';
import {
  loadConfig,
  readConfigFile,
  redactConfig,
  resolveSecrets,
} from './config.js';

const localPath = new URL('../../../config/gateway.yaml', import.meta.url)
  .pathname;
const deploymentPath = new URL(
  '../../../config/deployment.example.yaml',
  import.meta.url,
).pathname;
const local = () => readConfigFile(localPath).then(validateConfig);

describe('configuration', () => {
  it('loads the local example without secrets and applies defaults', async () => {
    const config = await loadConfig(localPath, {});
    expect(config.workers[0].models).toEqual({ 'mock-model': 'mock-model' });
    expect(config.server.defaultTimeoutMs).toBe(120000);
    expect(config.selector.weights.balanced.quality).toBe(0.4);
  });
  it('loads deployment with environment secrets and redacts all resolved values', async () => {
    const env = {
      KEY_TEAM_A_SHA256: 'a'.repeat(64),
      KEY_BENCH_SHA256: 'b'.repeat(64),
      VLLM_API_KEY: 'private-worker-key',
    };
    const config = await loadConfig(deploymentPath, env);
    expect(config.workers[0].apiKey).toBe(env.VLLM_API_KEY);
    const serialized = JSON.stringify(redactConfig(config));
    Object.values(env).forEach((value) =>
      expect(serialized).not.toContain(value),
    );
    expect(serialized).toContain('[REDACTED]');
    expect(config.auth.keys[0].hash).toBe(env.KEY_TEAM_A_SHA256);
  });
  it('fails on missing or malformed secrets without including secret values', async () => {
    await expect(loadConfig(deploymentPath, {})).rejects.toThrow(
      'auth.keys.0.hashEnv',
    );
    await expect(
      loadConfig(deploymentPath, { KEY_TEAM_A_SHA256: 'secret-value' }),
    ).rejects.toThrow('Invalid SHA-256 secret');
    const config = await local();
    config.workers[0].apiKeyEnv = 'WORKER_TOKEN';
    expect(() => resolveSecrets(config, {})).toThrow('workers.0.apiKeyEnv');
  });
  it.each([
    [
      'models.1.id',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.models.push(structuredClone(c.models[0]));
      },
    ],
    [
      'models.0.aliases.0',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.models[0].aliases = ['mock-model'];
      },
    ],
    [
      'workers.1.id',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.workers.push(structuredClone(c.workers[0]));
      },
    ],
    [
      'workers.0.models.missing',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.workers[0].models = { missing: 'upstream' };
      },
    ],
    [
      'workers.0.maxConcurrency',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.workers[0].maxConcurrency = 0;
      },
    ],
    [
      'workers.0.weight',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.workers[0].weight = -1;
      },
    ],
    [
      'server.defaultTimeoutMs',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.server.defaultTimeoutMs = 0;
      },
    ],
    [
      'selector.weights.balanced',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.selector.weights.balanced.cost = 0.9;
      },
    ],
    [
      'workers.0.baseUrl',
      (c: Awaited<ReturnType<typeof local>>) => {
        c.workers[0].baseUrl = 'https://user:password@worker.test';
      },
    ],
  ])('rejects invalid field at %s', async (path, mutate) => {
    const config = await local();
    mutate(config);
    expect(() => validateConfig(config)).toThrow(path);
  });
  it('rejects alias collisions with subsequent canonical IDs', async () => {
    const config = await local();
    config.models[0].aliases = ['second'];
    config.models.push({ ...config.models[0], id: 'second', aliases: [] });
    expect(() => validateConfig(config)).toThrow('models.1.id');
  });
  it('rejects literal secrets, unknown fields and invalid auth references', async () => {
    const config = await local();
    expect(() => validateConfig({ ...config, secret: 'hidden-value' })).toThrow(
      'Unrecognized key',
    );
    const deployment = validateConfig(await readConfigFile(deploymentPath));
    deployment.auth.keys[1].id = deployment.auth.keys[0].id;
    expect(() => validateConfig(deployment)).toThrow('auth.keys.1.id');
    deployment.auth.keys[1].id = 'bench';
    deployment.auth.keys[0].allowedModels = ['missing'];
    expect(() => validateConfig(deployment)).toThrow(
      'auth.keys.0.allowedModels.0',
    );
  });
  it('does not leak invalid YAML content in errors', async () => {
    await expect(readConfigFile('/missing/config.yaml')).rejects.toThrow(
      'Cannot read gateway configuration',
    );
  });
});

describe('request extensions', () => {
  it('accepts optional extensions and all supported routing choices', () => {
    expect(requestExtensionsSchema.parse({})).toEqual({});
    expect(
      requestExtensionsSchema.parse({
        priority: 'high_quality',
        task: 'code',
        cache: 'bypass',
        timeoutMs: 100,
        routing: 'power_of_two',
      }).task,
    ).toBe('code');
  });
  it.each([
    { priority: 'fast' },
    { task: 'unknown' },
    { cache: 'hit' },
    { timeoutMs: 0 },
    { timeoutMs: '100' },
    { routing: 'random' },
    { extra: true },
  ])('rejects invalid extension %j', (value) => {
    expect(requestExtensionsSchema.safeParse(value).success).toBe(false);
  });
});
