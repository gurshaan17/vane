import { z } from 'zod';

export const prioritySchema = z.enum([
  'low_latency',
  'balanced',
  'high_quality',
]);
export const taskSchema = z.enum([
  'chat',
  'code',
  'reasoning',
  'summarization',
  'extraction',
  'embedding',
  'vision',
  'unknown',
]);
export const capabilitySchema = z.enum([
  'chat',
  'completion',
  'embedding',
  'vision',
  'tools',
  'json_mode',
  'streaming',
]);
export const routingNameSchema = z.enum([
  'round_robin',
  'least_in_flight',
  'power_of_two',
  'adaptive',
]);
export type Priority = z.infer<typeof prioritySchema>;
export type Task = z.infer<typeof taskSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export const requestExtensionsSchema = z
  .object({
    priority: prioritySchema.optional(),
    task: taskSchema.exclude(['unknown']).optional(),
    cache: z.literal('bypass').optional(),
    timeoutMs: z.number().int().positive().optional(),
    routing: routingNameSchema.optional(),
  })
  .strict();
export type RequestExtensions = z.infer<typeof requestExtensionsSchema>;
export type Health = 'healthy' | 'degraded' | 'unhealthy' | 'draining';
export type BreakerState = 'closed' | 'open' | 'half_open';
export interface WorkerState {
  id: string;
  health: Health;
  breaker: BreakerState;
  inFlight: number;
  queueDepth?: number;
  ewmaLatencyMs: number;
  ewmaTtftMs: number;
  recentErrorRate: number;
  sampleCount: number;
  loadedModels: Set<string>;
  lastProbeAt: number;
}
export interface GatewayRequest {
  id: string;
  keyId: string;
  endpoint: 'chat' | 'completion' | 'embedding';
  body: unknown;
  stream: boolean;
  model: string;
  priority: Priority;
  taskHint?: Task;
  signal: AbortSignal;
  deadlineAt: number;
}
export interface RouteContext {
  request: GatewayRequest;
  model: string;
  triedWorkerIds: Set<string>;
  attempt: number;
}
export interface RoutingStrategy {
  readonly name: z.infer<typeof routingNameSchema>;
  pick(candidates: WorkerState[], ctx: RouteContext): WorkerState | undefined;
  onComplete?(
    worker: WorkerState,
    outcome: { ok: boolean; latencyMs: number; ttftMs?: number },
  ): void;
}
export interface DecisionRecord {
  requestId: string;
  at: number;
  keyId: string;
  task: Task;
  taskSource: 'hint' | 'rule' | 'classifier' | 'default';
  priority: Priority;
  modelRequested: string;
  modelSelected: string;
  modelRanking?: Array<{ model: string; score: number }>;
  strategy: string;
  workerId?: string;
  attempts: number;
  cache: 'hit' | 'miss' | 'bypass';
  coalesced: boolean;
  status: number;
  errorCode?: string;
  latencyMs: number;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}
