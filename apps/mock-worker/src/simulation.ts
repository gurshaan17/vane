import { createHash } from 'node:crypto';
import { z } from 'zod';

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const probability = z.number().min(0).max(1);
export const profileSchema = z
  .object({
    ttftMs: nonnegative.default(0),
    tokensPerSecond: positive.default(1000),
    jitter: nonnegative.max(3).default(0),
    outputTokens: positive.int().max(16384).default(1),
    outputDistribution: z
      .enum(['fixed', 'lognormal', 'heavy-tail'])
      .default('fixed'),
    errorRate: probability.default(0),
    hangRate: probability.default(0),
  })
  .strict();
export const profiles = {
  'fast-small': {
    ttftMs: 20,
    tokensPerSecond: 150,
    jitter: 0.15,
    outputTokens: 32,
    outputDistribution: 'lognormal',
  },
  'slow-large': {
    ttftMs: 200,
    tokensPerSecond: 25,
    jitter: 0.25,
    outputTokens: 128,
    outputDistribution: 'heavy-tail',
  },
  flaky: {
    ttftMs: 50,
    tokensPerSecond: 60,
    jitter: 0.4,
    outputTokens: 32,
    errorRate: 0.15,
    hangRate: 0.05,
  },
} as const;
export const settingsSchema = z
  .object({
    seed: z.string().max(256).default('vane'),
    models: z
      .record(z.string().min(1), profileSchema)
      .refine(
        (models) => Object.keys(models).length > 0,
        'At least one model is required',
      )
      .default({ 'mock-model': {} }),
    capacity: positive.int().max(10000).default(8),
    loadMode: z.enum(['slowdown', 'queue']).default('slowdown'),
    slowdownK: nonnegative.max(100).default(1),
    maxQueue: nonnegative.int().max(100000).default(1000),
    healthFailure: z.boolean().default(false),
    refuseConnections: z.boolean().default(false),
    crashAfterRequests: positive.int().nullable().default(null),
    degradation: z
      .array(
        z
          .object({
            startMs: nonnegative,
            durationMs: positive,
            multiplier: positive.max(1000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** Stable canonical input excludes transport IDs, gateway hints and request arrival order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function randomFor(seed: string, identity: unknown) {
  let state = createHash('sha256')
    .update(seed)
    .update('\0')
    .update(canonical(identity))
    .digest()
    .readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
export function draw(
  settings: Settings,
  model: string,
  identity: unknown,
  limit?: number,
) {
  const profile = settings.models[model];
  const random = randomFor(settings.seed, identity);
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) *
    Math.cos(2 * Math.PI * random());
  const jitter = () =>
    Math.exp(profile.jitter * normal() - profile.jitter ** 2 / 2);
  const length =
    profile.outputDistribution === 'fixed'
      ? 1
      : profile.outputDistribution === 'heavy-tail'
        ? Math.min(128, (1 - random()) ** (-1 / 1.5))
        : Math.exp(normal() * 0.75);
  return {
    ttftMs: Math.min(3600000, profile.ttftMs * jitter()),
    tokenMs: Math.min(60000, (1000 / profile.tokensPerSecond) * jitter()),
    outputTokens: Math.max(
      1,
      Math.min(
        16384,
        limit ?? 16384,
        Math.round(profile.outputTokens * length),
      ),
    ),
    error: random() < profile.errorRate,
    hang: random() < profile.hangRate,
  };
}
