import { z } from 'zod';
import {
  capabilitySchema,
  prioritySchema,
  routingNameSchema,
  taskSchema,
} from './contracts.js';

const positive = z.number().finite().positive();
const integer = positive.int();
const nonnegative = z.number().finite().nonnegative();
const fraction = z.number().min(0).max(1);
const id = z.string().trim().min(1);
const httpUrl = z
  .string()
  .url()
  .refine(
    (value) =>
      ['http:', 'https:'].includes(new URL(value).protocol) &&
      !new URL(value).username &&
      !new URL(value).password,
    'Expected HTTP or HTTPS URL without embedded credentials',
  );
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected environment variable name');
export const modelSpecSchema = z
  .object({
    id: id.refine((value) => value !== 'auto', 'auto is reserved'),
    aliases: z
      .array(id.refine((value) => value !== 'auto', 'auto is reserved'))
      .default([]),
    capabilities: z.array(capabilitySchema).nonempty(),
    contextWindow: integer,
    qualitySource: z.enum(['placeholder', 'evaluation']),
    quality: z.record(taskSchema, fraction),
    baseline: z
      .object({ ttftMs: nonnegative, tokensPerSec: positive })
      .strict(),
    costPer1kTokens: nonnegative.optional(),
  })
  .strict();
export const workerConfigSchema = z
  .object({
    id,
    baseUrl: httpUrl,
    backend: z.enum(['vllm', 'ollama', 'mock']),
    models: z
      .record(id, id)
      .refine(
        (value) => Object.keys(value).length > 0,
        'At least one model is required',
      ),
    maxConcurrency: integer,
    weight: positive.optional(),
    apiKeyEnv: envName.optional(),
  })
  .strict();
const keySchema = z
  .object({
    id,
    name: id,
    hashEnv: envName,
    roles: z.array(z.enum(['client', 'bench', 'admin'])).nonempty(),
    allowedModels: z.array(id).nonempty(),
    defaultPriority: prioritySchema.default('balanced'),
    limits: z
      .object({ rpm: integer, tpm: integer, maxConcurrent: integer })
      .strict(),
  })
  .strict();
const weights = z
  .object({ quality: fraction, latency: fraction, cost: fraction })
  .strict()
  .refine(
    (value) => Math.abs(value.quality + value.latency + value.cost - 1) < 1e-9,
    'Selector weights must sum to 1',
  );
export const gatewayConfigSchema = z
  .object({
    server: z
      .object({
        port: integer.max(65535).default(8080),
        adminPort: integer.max(65535).default(8081),
        bodyLimitBytes: integer.default(1048576),
        defaultTimeoutMs: integer.default(120000),
        shutdownGraceMs: integer.default(30000),
      })
      .strict()
      .default({}),
    auth: z
      .object({ keys: z.array(keySchema).default([]) })
      .strict()
      .default({}),
    limits: z
      .object({
        maxGlobalInFlight: integer.default(500),
        maxEventLoopLagMs: positive.default(100),
      })
      .strict()
      .default({}),
    rateLimit: z
      .object({
        store: z.enum(['memory', 'redis']).default('memory'),
        failMode: z.enum(['open', 'closed']).default('open'),
      })
      .strict()
      .default({}),
    cache: z
      .object({
        enabled: z.boolean().default(true),
        store: z.enum(['memory', 'redis']).default('memory'),
        ttlSeconds: integer.default(600),
        maxEntries: integer.default(5000),
        maxEntryBytes: integer.default(262144),
        requireDeterministic: z.boolean().default(true),
        replayStreaming: z.boolean().default(true),
      })
      .strict()
      .default({}),
    selector: z
      .object({
        defaultPriority: prioritySchema.default('balanced'),
        minQuality: fraction.default(0.5),
        weights: z
          .object({
            low_latency: weights.default({
              quality: 0.15,
              latency: 0.75,
              cost: 0.1,
            }),
            balanced: weights.default({
              quality: 0.4,
              latency: 0.4,
              cost: 0.2,
            }),
            high_quality: weights.default({
              quality: 0.75,
              latency: 0.15,
              cost: 0.1,
            }),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    models: z.array(modelSpecSchema).nonempty(),
    workers: z.array(workerConfigSchema).nonempty(),
    health: z
      .object({
        probeIntervalMs: integer.default(5000),
        unhealthyAfterFailures: integer.default(3),
        recoverAfterSuccesses: integer.default(2),
        degradedErrorRate: fraction.default(0.2),
      })
      .strict()
      .default({}),
    routing: z
      .object({
        strategy: routingNameSchema.default('adaptive'),
        maxQueue: nonnegative.int().default(200),
        queueTimeoutMs: integer.default(2000),
        adaptive: z
          .object({
            wLoad: fraction.default(0.5),
            wLat: fraction.default(0.3),
            wErr: fraction.default(0.2),
            errScale: positive.default(5),
            degradedPenalty: nonnegative.default(0.5),
            minSamples: integer.default(20),
            rampUpMs: integer.default(10000),
            sample: z.enum(['all', 'p2c']).default('all'),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    resilience: z
      .object({
        maxAttempts: integer.default(2),
        connectTimeoutMs: integer.default(2000),
        firstByteTimeoutMs: integer.default(30000),
        streamIdleTimeoutMs: integer.default(15000),
        retryBudget: z
          .object({
            ratio: fraction.default(0.1),
            windowMs: integer.default(10000),
          })
          .strict()
          .default({}),
        breaker: z
          .object({
            consecutiveFailures: integer.default(5),
            errorRate: fraction.default(0.5),
            minRequests: integer.default(20),
            windowMs: integer.default(30000),
            openMs: integer.default(10000),
            maxOpenMs: integer.default(60000),
            halfOpenMax: integer.default(2),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    streaming: z
      .object({
        clientStallMs: integer.default(30000),
        heartbeatMs: integer.default(15000),
      })
      .strict()
      .default({}),
    observability: z
      .object({
        decisionBuffer: integer.default(1000),
        otlpEndpoint: httpUrl.optional(),
      })
      .strict()
      .default({}),
    logging: z
      .object({
        level: z
          .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
          .default('info'),
        logBodies: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const names = new Set<string>();
    config.models.forEach((model, i) => {
      [model.id, ...model.aliases].forEach((name, j) => {
        const path =
          j === 0 ? ['models', i, 'id'] : ['models', i, 'aliases', j - 1];
        if (names.has(name)) issue(path, 'Duplicate model ID or alias');
        names.add(name);
      });
    });
    const canonical = new Set(config.models.map((model) => model.id));
    for (const section of ['workers', 'auth'] as const) {
      const entries = section === 'workers' ? config.workers : config.auth.keys;
      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        if (seen.has(entry.id))
          issue(
            section === 'workers'
              ? ['workers', i, 'id']
              : ['auth', 'keys', i, 'id'],
            'Duplicate ID',
          );
        seen.add(entry.id);
      });
    }
    config.workers.forEach((worker, i) =>
      Object.keys(worker.models).forEach((model) => {
        if (!canonical.has(model))
          issue(['workers', i, 'models', model], 'Unknown canonical model ID');
      }),
    );
    config.auth.keys.forEach((key, i) =>
      key.allowedModels.forEach((model, j) => {
        if (model !== '*' && !names.has(model))
          issue(
            ['auth', 'keys', i, 'allowedModels', j],
            'Unknown model or alias',
          );
      }),
    );
    if (config.server.port === config.server.adminPort)
      issue(['server', 'adminPort'], 'Must differ from public port');
    if (config.resilience.breaker.maxOpenMs < config.resilience.breaker.openMs)
      issue(['resilience', 'breaker', 'maxOpenMs'], 'Must be at least openMs');
  });
export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function validateConfig(input: unknown): GatewayConfig {
  const result = gatewayConfigSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      'Invalid gateway configuration: ' +
        result.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; '),
    );
  return result.data;
}
