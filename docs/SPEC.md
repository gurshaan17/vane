# Distributed AI Inference Gateway: Technical Specification

**Status:** Draft v0.1 | **Language:** TypeScript (Node.js) for every package | **Topology:** single gateway instance

## 1. Overview

The Inference Gateway is a single entry point between applications and several AI model servers (vLLM, Ollama and similar). Applications send OpenAI-compatible requests to the gateway. The gateway decides which model should serve each request, which worker should run it, forwards the request, streams the answer back and records what happened. It does not train or host models. It manages requests to models that already exist.

The central research question is whether adaptive worker routing (scoring workers by live load, observed latency and recent errors) beats simpler strategies (round-robin, least-in-flight, power-of-two-choices), and under what conditions. The system must therefore keep routing strategies swappable and make every run measurable and repeatable.

### 1.1 Goals

- One consistent OpenAI-compatible API in front of heterogeneous model servers.
- Task-aware model selection: choose a model from what the request needs, not only from a fixed model name.
- Client-controlled priority: low_latency, balanced or high_quality.
- Load-aware worker routing with four interchangeable strategies.
- Failure handling: health checks, timeouts, bounded retries, circuit breakers, failover and safe streaming behavior.
- Protection: API-key auth, per-key rate limits, optional exact-match cache, request coalescing.
- Observability: Prometheus metrics, OpenTelemetry traces, structured logs and a live dashboard.
- Repeatable benchmarks that compare routing strategies under controlled faults.

### 1.2 Non-goals

- Training, fine-tuning or serving models (vLLM and Ollama do that).
- Running more than one gateway instance in v1 (the design must not prevent it later).
- GPU scheduling, billing, user management, or tenant isolation beyond API keys.
- Semantic caching and automatic prompt rewriting (stretch only).

### 1.3 Design principles

1. Filter, then rank. Remove incompatible or unavailable candidates first, then score the rest.
2. Two separate decisions. Model selection (what should answer) and worker routing (which instance answers) are different modules with different inputs and tests.
3. Measure, do not assume. Quality and latency claims come from evaluation sets and load tests.
4. Never substitute silently. If no compatible, healthy option exists, return a clear error. Any model fallback is visible in response headers.
5. A stream is one-way. After the first byte reaches the client, the gateway never switches workers.
6. Every decision is recorded. Each request produces one decision record that explains what was chosen and why.
7. Interfaces over implementations. Cache, rate-limit store, registry and routing strategy are interfaces, so Redis or multi-instance support can be added later without rewriting the pipeline.

## 2. Reconciling the two source designs

The written brief and the architecture diagram differ in a few places. These decisions fix that so the whole team builds one system.

| Topic | Diagram says | Brief says | Decision |
| --- | --- | --- | --- |
| Gateway state | Stateless gateway with Redis | Single gateway instance | v1 is one process. All state (registry, breakers, counters, cache) lives in memory behind interfaces. Redis is an optional adapter. Stateless here means no state that cannot be rebuilt on restart. |
| Batcher | Groups small requests in a 5–20 ms window | Not mentioned | Real token batching happens inside vLLM (continuous batching). The gateway only does request coalescing (identical in-flight requests share one upstream call) and, as a stretch, embedding micro-batching. The component is named Coalescer. |
| Model selection | Router is model-aware only | Task-aware selection by client priority | Add a Task Analyzer and a Model Selector ahead of the Router. The Router only chooses a worker. |
| Worker endpoints | /generate and /api/generate | OpenAI-compatible gateway API | Workers are reached through adapters. Prefer each backend's OpenAI-compatible endpoint and translate only when needed. |
| Cache | Exact match, optional semantic | Safe cache, optional | Exact match only in v1, deterministic requests only by default. |
| Admin plane | Optional, stretch goal | Not mentioned | Read-only admin endpoints and config hot-reload in v1. Mutation endpoints are stretch. |

## 3. Technology stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 LTS | Single-threaded event loop, see section 10 |
| Language | TypeScript with strict: true | ESM modules, no any in core modules |
| HTTP server | Fastify | Low overhead, schema hooks, easy raw-stream access for SSE |
| Upstream HTTP | undici (one Pool per worker) | Connection pooling, streaming bodies, abort signals |
| Validation | zod | Request, config and admin schemas, types inferred from schemas |
| Config | YAML validated by zod, env overrides | Secrets only from environment variables |
| Logging | pino | Structured JSON |
| Metrics | prom-client | Prometheus text at /metrics |
| Tracing | OpenTelemetry Node SDK, OTLP export | Jaeger or Tempo as backend |
| Shared state (optional) | ioredis | Behind interfaces, off by default |
| Local cache | lru-cache | Default cache store |
| CPU-heavy work | piscina (worker_threads pool) | Classifier, tokenization |
| Dashboard | React, Vite, uPlot or Recharts | Reads gateway admin stats and benchmark JSON |
| Tests | vitest, fast-check, the official openai npm client | Unit, property and compatibility tests |
| Load testing | k6 (open-loop arrival rate) plus a TypeScript orchestrator | See section 7.17 |
| Monorepo | pnpm workspaces | TypeScript only |
| Local environment | Docker Compose | Gateway, mock workers, Redis, Prometheus, Grafana, Jaeger |

Versions above are targets. Pin exact versions in the lockfile at project start.

## 4. Architecture

### 4.1 Components

| Component | Responsibility | Holds state |
| --- | --- | --- |
| API Layer | HTTP endpoints, validation, request ID, abort wiring, SSE output | Per-request context only |
| Auth | API key lookup, roles and permissions | Key table from config |
| Rate Limiter | Request, token and concurrency limits per key, global load shedding | Counters (memory or Redis) |
| Cache | Exact-match response reuse | LRU or Redis |
| Task Analyzer | Infer task and required capabilities | None (optional classifier model) |
| Model Registry and Selector | Filter and rank models by client priority | Model table from config, live stats |
| Coalescer | Share one upstream call between identical in-flight requests | In-flight map |
| Worker Registry | Live view of workers: health, load, loaded models | In-memory map |
| Health Monitor | Active probes and passive failure signals | Probe timers |
| Router | Choose a worker for the chosen model | Strategy state (cursors, EWMA) |
| Resilience Layer | Timeouts, retries, circuit breakers, failover | Breaker state |
| Upstream Adapters | Talk to vLLM, Ollama and mock workers | HTTP pools |
| Streaming Proxy | Forward SSE, measure time to first token, handle backpressure | Per-stream |
| Observability | Metrics, traces, logs, decision records | Counters, ring buffer |
| Admin Plane | Inspect workers and config, hot-reload | None |
| Dashboard | Live and benchmark views | None |
| Mock Worker | Simulated model server with fault injection | Per-process |
| Benchmark Harness | Scenarios, runs, reports | Result files |

### 4.2 Request pipeline

1. Receive and validate (API Layer). Assign a request ID, build the internal GatewayRequest, attach an AbortController wired to client disconnect.
2. Authenticate (Auth).
3. Admit (Rate Limiter). Check the global in-flight cap and per-key request, token and concurrency limits.
4. Normalize and look up the cache (Cache). A hit returns immediately.
5. Analyze the task (Task Analyzer).
6. Select a model (Model Selector). Produces an ordered list of eligible models.
7. Coalesce (Coalescer). If an identical request is already in flight, become a follower of it.
8. Route (Router). Pick a worker with the configured strategy, waiting briefly in a bounded queue if all are saturated.
9. Forward (Resilience Layer and Adapter). Apply timeouts, retries and failover.
10. Stream or return (Streaming Proxy).
11. Finalize. Update EWMA stats and the breaker, reconcile rate-limit tokens, store the cache entry, emit metrics and the decision record, and release in-flight counters. Finalization always runs in a finally block.

The cache lookup happens before model selection and is keyed on the request as sent (including model: auto and the priority), so a hit costs almost nothing.

### 4.3 Repository layout

```text
inference-gateway/
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
  docker-compose.yml
  config/
    gateway.example.yaml
    models.example.yaml
  apps/
    gateway/            # the gateway service
      src/
        server.ts
        api/            # routes, schemas, SSE writer
        auth/
        ratelimit/
        cache/
        analyzer/
        models/         # registry and selector
        coalescer/
        workers/        # registry, health monitor, adapters
        routing/        # round-robin, least-in-flight, power-of-two, adaptive
        resilience/     # timeouts, retry, circuit breaker
        observability/
        admin/
        config/
    mock-worker/        # simulated OpenAI-compatible model server
    dashboard/          # React app
    bench/              # scenarios, runner, report generator
  packages/
    shared/             # zod schemas and TS types used by all apps
    tsconfig/
    eslint-config/
  docs/
    SPEC.md
```

## 5. Core data model

These types live in packages/shared (or in the gateway's own modules where noted) and are the contract between modules.

```typescript
type Priority = 'low_latency' | 'balanced' | 'high_quality';
type Task = 'chat' | 'code' | 'reasoning' | 'summarization' | 'extraction' | 'embedding' | 'vision' | 'unknown';
type Capability = 'chat' | 'completion' | 'embedding' | 'vision' | 'tools' | 'json_mode' | 'streaming';

interface ModelSpec {
  id: string;                                   // canonical id, e.g. 'llama-3-8b-instruct'
  aliases: string[];
  capabilities: Capability[];
  contextWindow: number;                        // tokens
  quality: Partial<Record<Task, number>>;       // 0..1, from task-specific eval sets
  baseline: { ttftMs: number; tokensPerSec: number };  // measured under reference load
  costPer1kTokens?: number;                     // relative units are fine
}

interface WorkerConfig {
  id: string;
  baseUrl: string;
  backend: 'vllm' | 'ollama' | 'mock';
  models: Record<string, string>;               // canonical model id -> name the worker uses
  maxConcurrency: number;
  weight?: number;
}

type Health = 'healthy' | 'degraded' | 'unhealthy' | 'draining';
type BreakerState = 'closed' | 'open' | 'half_open';

interface WorkerState {
  id: string;
  health: Health;
  breaker: BreakerState;
  inFlight: number;
  queueDepth?: number;                          // scraped from worker metrics when available
  ewmaLatencyMs: number;
  ewmaTtftMs: number;
  recentErrorRate: number;                      // 0..1, sliding window
  sampleCount: number;
  loadedModels: Set<string>;
  lastProbeAt: number;
}

interface GatewayRequest {
  id: string;
  keyId: string;
  endpoint: 'chat' | 'completion' | 'embedding';
  body: unknown;                                // validated OpenAI-style payload
  stream: boolean;
  model: string;                                // concrete id or alias, or 'auto'
  priority: Priority;
  taskHint?: Task;
  signal: AbortSignal;                          // aborted when the client disconnects
  deadlineAt: number;                           // epoch ms
}

interface RouteContext {
  request: GatewayRequest;
  model: string;                                // the model chosen by the selector
  triedWorkerIds: Set<string>;
  attempt: number;
}

interface RoutingStrategy {
  readonly name: 'round_robin' | 'least_in_flight' | 'power_of_two' | 'adaptive';
  // candidates are already filtered: healthy, breaker not open, model loaded, not saturated
  pick(candidates: WorkerState[], ctx: RouteContext): WorkerState | undefined;
  onComplete?(worker: WorkerState, outcome: { ok: boolean; latencyMs: number; ttftMs?: number }): void;
}

interface DecisionRecord {
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
```

## 6. External API

### 6.1 Endpoints

| Method and path | Purpose | Auth |
| --- | --- | --- |
| POST /v1/chat/completions | OpenAI-compatible chat, supports stream: true | API key |
| POST /v1/completions | Legacy text completion (optional) | API key |
| POST /v1/embeddings | Embeddings, if an embedding model is registered | API key |
| GET /v1/models | Models the key may use, plus the virtual id auto | API key |
| GET /healthz | Liveness: the process is up | None |
| GET /readyz | Readiness: at least one healthy worker and not draining | None |
| GET /metrics | Prometheus metrics | Internal network or admin key |
| /admin/... | Inspection and control, see section 7.14 | Admin key |

### 6.2 Gateway extensions

Standard OpenAI SDKs must work unchanged, so extensions are optional headers. A body field named gateway accepts the same names, and the header wins if both are present.

| Header | Values | Meaning |
| --- | --- | --- |
| x-gateway-priority | low_latency, balanced, high_quality | Ranking preference. Default comes from the key, then from config (balanced). |
| x-gateway-task | chat, code, reasoning, summarization, extraction, embedding, vision | Explicit task hint. |
| x-gateway-cache | bypass | Skip cache read and write. |
| x-gateway-timeout-ms | integer | Shorten, never extend, the request deadline. |
| x-gateway-routing | strategy name | Override the routing strategy. Honored only for keys with the bench role. |

Setting model to a concrete id or alias uses exactly that model. Setting it to auto asks the gateway to select one.

### 6.3 Response headers

x-request-id, x-gateway-model (model actually used), x-gateway-worker (worker id, can be hidden by config), x-gateway-cache (hit, miss or bypass), x-gateway-attempts, x-gateway-fallback (true when auto fell back to a lower-ranked model), x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, and retry-after on 429 and 503.

### 6.4 Errors

Errors use the OpenAI shape: an error object with message, type, code and request_id.

| HTTP | code | When |
| --- | --- | --- |
| 400 | invalid_request | Schema failure or unsupported parameter |
| 401 | invalid_api_key | Missing or unknown key |
| 403 | model_not_permitted | The key may not use this model |
| 404 | model_not_found | Unknown model id |
| 413 | request_too_large | Body or estimated tokens above the limit |
| 422 | no_compatible_model | No model satisfies the required capabilities or context length, or the named model lacks a required capability |
| 429 | rate_limit_exceeded | Limit hit, with retry-after |
| 502 | upstream_error | The worker failed and retries are exhausted |
| 503 | no_healthy_worker | A compatible model exists but no healthy worker does, with retry-after |
| 503 | gateway_overloaded | Global admission cap or queue is full |
| 504 | upstream_timeout | Deadline or first-token timeout exhausted all attempts |

If a failure happens after streaming has started, the HTTP status can no longer change. The gateway sends one SSE event containing an error object and closes the stream.

### 6.5 Streaming format

Streaming uses Server-Sent Events: each chunk is `data: <json>` followed by a blank line, and the stream ends with `data: [DONE]`. The gateway injects stream_options.include_usage upstream so that token usage is available for metrics and rate-limit reconciliation.

## 7. Component specifications

### 7.1 API Layer

- Built on Fastify with a configurable bodyLimit (default 1 MiB).
- Every route has a zod schema. Unknown fields in the OpenAI payload are passed through, because OpenAI clients add fields freely. A field is rejected with 400 only if it is listed in the config as unsupported for the chosen backend.
- Request ID: accept an inbound x-request-id if it matches a safe pattern, otherwise generate a UUID v7. Return it on every response and put it in every log line and trace.
- Abort wiring: when the client connection closes before the response finishes, abort the request's AbortController. Every downstream operation (queue wait, upstream call, retry backoff) receives this signal and must stop promptly.
- Deadline: deadlineAt = now + min(config.defaultTimeoutMs, x-gateway-timeout-ms).
- Response writing: non-streaming responses are plain JSON. Streaming responses are written by the Streaming Proxy (section 7.11).

### 7.2 Auth

- Keys are configured as records: id, name, hash, roles (client, bench, admin), allowedModels (list or *), defaultPriority and limits.
- Only the SHA-256 hash of a key is stored. The incoming Authorization: Bearer <key> header is hashed and looked up in a map.
- The gateway never forwards the client's Authorization header to workers. If a worker needs credentials, they come from the worker's own config entry (read from environment variables).
- Admin endpoints require the admin role and should listen on a separate port or interface in any shared environment.

### 7.3 Rate Limiter

- Per key: a token bucket for requests per minute, a token bucket for tokens per minute, and a maximum concurrent-request counter.
- Token cost is reserved after a cache miss: estimated prompt tokens plus max_tokens (or a configured default when absent). The estimate is characters divided by 4 by default; an exact tokenizer in the worker pool is optional. After the response completes, reconcile with the real usage and refund the unused part. A cache hit consumes one request and no tokens.
- Check order: concurrency, then requests, then tokens. Any later rejection releases what was already taken.
- A failed check returns 429 with retry-after computed from the bucket refill time, plus x-ratelimit-* headers.
- Global load shedding: limits.maxGlobalInFlight caps total in-flight requests. Beyond it the gateway returns 503 gateway_overloaded immediately instead of queueing without bound.
- Store interface: RateLimitStore.take(key, cost). The default is in-memory. The Redis implementation uses a Lua script so the take is atomic. If Redis is unreachable, behavior follows rateLimit.failMode (open by default) and the event is counted in a metric.

### 7.4 Cache

Exact-match only in v1.

- Eligibility: only requests that are deterministic (temperature is 0, or seed is set) are cached by default (cache.requireDeterministic: true). Requests that use tools, or that send x-gateway-cache: bypass, are never cached.
- Key: SHA-256 of a canonical JSON form (sorted keys) of: endpoint, model as requested (including auto), messages or prompt, output-affecting parameters (temperature, top_p, max_tokens, stop, seed, response_format), priority, and a namespace (the API key id by default, so entries are never shared across keys unless configured).
- Value: the full response body, usage, model used and finish reason. Only complete successful responses are stored. Errors and truncated streams are never stored.
- Streaming: a cached response can be replayed to a streaming client as a synthesized SSE stream (cache.replayStreaming). A streaming miss is accumulated while it is forwarded and stored once it finishes cleanly, up to cache.maxEntryBytes.
- Limits: default TTL 10 minutes, default max entry size 256 KB, LRU eviction by entry count and total bytes.
- Store interface: CacheStore.get/set. Default is lru-cache; Redis is optional.
- Out of scope for v1: semantic (embedding-based) caching.

### 7.5 Task Analyzer

Purpose: decide what the request is and what the serving model must be able to do.

Output: { task, requiredCapabilities, estimatedPromptTokens, confidence, source } where source is hint, rule, classifier or default.

Precedence (first match wins):

1. Explicit hint from x-gateway-task.
2. Hard signals from the endpoint and payload: embeddings endpoint means embedding; image content parts mean vision; tools means the tools capability; response_format of JSON means the json_mode capability; stream: true means the streaming capability.
3. Rules on the text: code fences, programming-language names, phrases like write a function or fix this bug mean code; math notation, prove, derive or step by step mean reasoning; a long input with summarize or TL;DR means summarization; extract, parse or return JSON with fields means extraction.
4. Lightweight classifier (phase 7, optional) for prompts the rules leave ambiguous. It runs in the worker_threads pool with a hard time budget (default 20 ms). On timeout or error the analyzer falls back to default.
5. Default: chat.

The analyzer must never block the pipeline beyond its budget and must never fail the request. Capability signals are requirements. Task is only a ranking input.

### 7.6 Model Registry and Model Selector

Registry: loaded from config into ModelSpec records (section 5). Quality scores come from task-specific evaluation sets, not guesses. Until real eval data exists, placeholder scores must be marked as such in the config so the benchmark report can flag them.

Selection algorithm:

1. Explicit model. If the client named a concrete model or alias, resolve it, check permission (403) and capabilities (422), and use it. No ranking. Priority does not change the model.
2. Filter (for auto). Keep models that: have all required capabilities, have a context window larger than estimated prompt tokens plus max_tokens, are permitted for the key, and have at least one worker that is healthy, not breaker-open and not draining. If nothing remains, return 422 no_compatible_model (nothing compatible exists) or 503 no_healthy_worker (compatible models exist but none are available).
3. Quality floor. In low_latency mode, drop models whose quality for the task is below selector.minQuality (default 0.5). Fast must not mean useless.
4. Rank. Score each remaining model as wq * quality + wl * latency + wc * cost, where each term is scaled relative to the best candidate: quality is q / qBest, latency is lBest / l, cost is cBest / c. Missing quality for the task falls back to the model's chat score and flags the decision. Missing cost counts as equal.
5. Tie-break by lower cost, then by model id, so decisions are deterministic.

Weights by priority (configurable):

| Priority | Quality weight | Latency weight | Cost weight |
| --- | --- | --- | --- |
| low_latency | 0.15 | 0.75 | 0.10 |
| balanced | 0.40 | 0.40 | 0.20 |
| high_quality | 0.75 | 0.15 | 0.10 |

Latency estimate for a model: ttft + expectedOutputTokens / tokensPerSec. Use the live EWMA values aggregated over the model's healthy workers once there are at least 20 samples, otherwise the baseline values. expectedOutputTokens is the request's max_tokens, capped by a per-task default (for example 256 for chat, 512 for code).

Worked example (code task, two eligible models):

| Model | Quality (code) | Est. latency | Relative cost |
| --- | --- | --- | --- |
| small-8b | 0.62 | 600 ms | 1 |
| large-70b | 0.88 | 2400 ms | 4 |

Scaled terms: small has quality 0.70, latency 1.00, cost 1.00; large has quality 1.00, latency 0.25, cost 0.25.

| Priority | small-8b score | large-70b score | Winner |
| --- | --- | --- | --- |
| low_latency | 0.955 | 0.363 | small-8b |
| balanced | 0.880 | 0.550 | small-8b |
| high_quality | 0.775 | 0.813 | large-70b |

The weights are starting points. The benchmark and eval work should tune them, and the report must state the values used.

Fallback rule. For auto, every model in the ranking is acceptable by construction, so if the top model's workers all become unavailable during dispatch, the gateway may fall through to the next ranked model and sets x-gateway-fallback: true. For an explicit model there is never a model fallback. The output of the selector is the ordered candidate list, and the decision record stores the scores.

### 7.7 Coalescer

Purpose: avoid duplicate upstream work. It is not a token batcher (vLLM already batches tokens internally).

- Dedupe mode (v1). Key is the cache key plus the resolved model. If an identical request is already in flight, the new one becomes a follower and receives the leader's result. Eligible only for non-streaming, deterministic requests. Streaming followers are a stretch goal using a replay buffer.
- Cancellation safety. Waiters are reference counted. A leader whose client disconnects must not cancel the upstream call while followers still wait. The upstream call is aborted only when the last waiter is gone.
- Embedding micro-batching (stretch, off by default). Collect single-input embedding requests for the same model during a short window (coalescer.windowMs, 5 to 20 ms) and send one upstream call with an array input, up to maxBatchSize. Split the result back to the callers.
- Metrics: coalesced request count, wait time, batch sizes.

### 7.8 Worker Registry and Health Monitor

Registry. An in-memory Map<workerId, WorkerState>. In v1 workers come from config. Admin registration and removal at runtime are stretch.

Active probing. Every health.probeIntervalMs (default 5000, with random jitter) the monitor calls each worker's health endpoint (vLLM /health, Ollama root or /api/tags, mock /health). It also reads the worker's model list to update loadedModels, and where available scrapes the worker's /metrics for queue depth (for vLLM, the running and waiting request counts) and cache usage.

Passive signals. Request outcomes (timeouts, connection errors, 5xx) feed the circuit breaker and the error-rate window immediately, without waiting for the next probe.

Health state machine:

| From | To | Condition |
| --- | --- | --- |
| healthy | degraded | Probe latency above threshold, or recent error rate above degradedErrorRate |
| degraded | unhealthy | unhealthyAfterFailures consecutive probe failures (default 3) |
| unhealthy | degraded | recoverAfterSuccesses consecutive probe successes (default 2) |
| degraded | healthy | Metrics back under thresholds |
| any | draining | Admin drain request or shutdown. No new requests, in-flight requests finish. |

Degraded workers stay eligible but are penalized by adaptive routing. Unhealthy and draining workers are excluded.

Statistics.

- EWMA of end-to-end latency and time to first token, with alpha 0.2 by default.
- Recent error rate over a sliding window (last 50 requests or 60 seconds, whichever is smaller).
- inFlight is incremented at dispatch and decremented in a finally block on every outcome: success, error, timeout and client abort. A leak here silently skews every strategy, so it has a dedicated test (section 12).
- Client aborts are recorded separately and are not counted as worker errors.

### 7.9 Router

The Router receives the chosen model and returns a worker. It works in two steps.

Step 1: filter (shared by all strategies). Exclude workers that: do not serve the model or have not loaded it, are unhealthy or draining, have an open circuit breaker, were already tried for this request, or are saturated (inFlight >= maxConcurrency). Half-open breakers admit only their limited trial requests.

Step 2: pick (the strategy). All strategies implement RoutingStrategy:

| Strategy | Rule |
| --- | --- |
| round_robin | Per-model cursor over the filtered list. Advance the cursor on every pick. |
| least_in_flight | Choose the lowest inFlight. Break ties randomly. |
| power_of_two | Sample two filtered workers at random and choose the one with the lower inFlight. |
| adaptive | Score each worker and choose the lowest score (below). |

Adaptive score (lower is better):

```text
load  = (inFlight + queueDepth ?? 0) / maxConcurrency
lat   = ewmaLatencyMs / min(ewmaLatencyMs across candidates)   // 1.0 is the best candidate
err   = recentErrorRate                                        // 0..1
score = wLoad * load + wLat * (lat - 1) + wErr * err * errScale + degradedPenalty
```

Defaults: wLoad 0.5, wLat 0.3, wErr 0.2, errScale 5, degradedPenalty 0.5. All of these are configurable and are the main tuning surface of the research.

Adaptive details:

- Cold start. A worker with fewer than minSamples (default 20) uses the pool median latency, so a new or recovered worker is not starved or flooded.
- Herding control. Optionally pick among the best two scores at random (adaptive.sample: p2c) so a burst of requests does not all pick the same worker on stale statistics.
- Ramp-up. A worker that just left the unhealthy state is capped at 50% of its maxConcurrency for rampUpMs (default 10000).
- Heterogeneous workers. Load is normalized by each worker's own maxConcurrency, so a larger worker takes proportionally more traffic.

When every candidate is saturated. The request waits in a bounded per-model FIFO queue (routing.maxQueue, routing.queueTimeoutMs default 2000). On timeout or when the queue is full the gateway returns 503 gateway_overloaded or no_healthy_worker, whichever is accurate. The wait counts against the request deadline and is cancelled on client abort.

Strategy selection. The default strategy is set in config. Keys with the bench role may override it per request with x-gateway-routing, which is how the benchmark compares strategies on the same running system and the same trace.

### 7.10 Resilience Layer

Timeouts:

| Timeout | Default | Applies to |
| --- | --- | --- |
| Connect | 2 s | Opening a connection to a worker |
| First byte (TTFT) | 30 s | Time until the worker sends its first response byte or token, streaming or not |
| Stream idle | 15 s | Maximum gap between chunks after streaming began. Exceeding it counts as a worker failure. |
| Total deadline | 120 s | The whole request: queueing, retries and streaming. Can be shortened with x-gateway-timeout-ms. |

Retry policy. A request is retried only when all of these hold:

- No byte has been written to the client yet.
- The failure is retryable: connection refused or reset, connect timeout, first-byte timeout, upstream 502, 503 or 504, or upstream 429 (respecting its retry-after).
- The deadline still has time left and the retry budget allows it.

Never retry: upstream 400, 401, 403, 404 or 422 (these are request or configuration errors), client aborts, or any request whose stream has already started.

Other rules:

- Default maxAttempts is 2 (the original plus one retry).
- Each attempt must use a different worker (triedWorkerIds). If none is left, fail with the last error mapped to the gateway error table.
- Backoff uses full jitter, base 50 ms, cap 500 ms, and is cancelled by the abort signal.
- Retry budget: retries may not exceed 10% of requests over a rolling 10-second window (with a small minimum so low traffic can still retry). This prevents a retry storm from making a degraded pool worse.

Circuit breaker (one per worker):

| State | Behavior | Transition |
| --- | --- | --- |
| closed | Normal traffic | Opens on 5 consecutive failures, or an error rate of 50% or more over at least 20 requests in the last 30 s |
| open | No traffic | After openMs (default 10 s, doubling on repeated trips up to 60 s) becomes half_open |
| half_open | At most halfOpenMax (default 2) trial requests at a time | 2 consecutive successes close it. Any failure reopens it. |

Failures that count: connect errors, timeouts, 5xx, stream idle timeouts. Failures that do not count: 4xx responses and client aborts.

The breaker reacts quickly to real traffic. Health reflects probes. The Router excludes a worker if either one says so.

Failover. Worker-level failover is the retry rule above. Model-level fallback exists only for auto (section 7.6). If every worker for the model is excluded, the answer is 503 no_healthy_worker.

Streaming rule. Before the first byte reaches the client, a failure can be retried on another worker. After the first byte, the gateway never switches workers, because that could duplicate or corrupt output. It sends the SSE error event, closes the stream and counts a stream_interrupted. Safe stream continuation is out of scope.

Out of scope for v1: hedged requests (sending a duplicate to a second worker after a delay).

### 7.11 Streaming Proxy

- Delay response headers until the first upstream chunk arrives. This keeps retries possible and lets pre-stream failures return a real HTTP status. After the first chunk, headers go out with content-type: text/event-stream, cache-control: no-cache, no-transform and x-accel-buffering: no.
- Backpressure. Pipe the upstream body to the client with stream.pipeline, honoring the write return value and the drain event. A slow client must not make the gateway buffer without limit. If a client stalls longer than streaming.clientStallMs (default 30 s), abort the upstream call and close.
- Client disconnect. Abort the upstream call immediately so the worker stops generating and frees capacity.
- Heartbeat. After headers are sent, emit an SSE comment line (: ping) after 15 s of idleness so proxies do not close the connection.
- Light parsing only. Detect SSE event boundaries in the byte stream. Record time to first token at the first data chunk. Find the final usage chunk by a cheap string check before JSON-parsing it. Never JSON-parse every chunk; per-chunk parsing is the most likely way to waste CPU on the event loop.
- Cleanup. Every path (finished, error, abort, timeout) ends in the same finalize step that releases counters.

### 7.12 Upstream Adapters

```typescript
interface WorkerAdapter {
  chat(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamResponse>;      // non-streaming
  chatStream(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamStream>;  // resolves at response headers
  embeddings?(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamResponse>;
  health(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number }>;
  listModels(signal: AbortSignal): Promise<string[]>;
  scrapeMetrics?(signal: AbortSignal): Promise<{ queueDepth?: number; running?: number }>;
}
```

- vLLM adapter: pass-through to its OpenAI-compatible /v1/chat/completions. Maps the canonical model id to the worker's model name.
- Ollama adapter: use Ollama's OpenAI-compatible endpoint when available. Otherwise translate to /api/chat and convert its newline-delimited JSON stream into SSE chunks.
- Mock adapter: pass-through (the mock worker speaks the OpenAI format).
- Each adapter owns an undici Pool per worker, sized at least maxConcurrency, with keep-alive.
- Errors are normalized to UpstreamError { kind: 'connect' | 'timeout' | 'http' | 'stream'; status?: number; retryable: boolean } so the Resilience Layer never needs to know the backend.
- Strip hop-by-hop headers and inject traceparent on every upstream call.

### 7.13 Observability

Metrics (Prometheus, via prom-client). Never use request id or user text as a label. Use the key id as a label only when few keys are configured.

| Metric | Type | Labels |
| --- | --- | --- |
| gateway_requests_total | counter | route, status, model, priority, cache, strategy |
| gateway_request_duration_seconds | histogram | route, model |
| gateway_ttft_seconds | histogram | model, worker |
| gateway_upstream_duration_seconds | histogram | worker |
| gateway_routing_overhead_seconds | histogram | stage (auth, ratelimit, analyze, select, route) |
| gateway_inflight_requests | gauge | worker |
| gateway_worker_health | gauge | worker (0 unhealthy, 1 degraded, 2 healthy) |
| gateway_circuit_state | gauge | worker (0 closed, 1 half_open, 2 open) |
| gateway_retries_total | counter | reason |
| gateway_failovers_total | counter | kind (worker, model) |
| gateway_stream_interrupted_total | counter | worker |
| gateway_rate_limited_total | counter | limit (requests, tokens, concurrency) |
| gateway_cache_events_total | counter | result (hit, miss, bypass, store) |
| gateway_coalesced_requests_total | counter | none |
| gateway_queue_depth | gauge | model |
| gateway_queue_wait_seconds | histogram | model |
| gateway_model_selection_total | counter | task, priority, model |
| gateway_tokens_total | counter | direction (prompt, completion), model |
| nodejs_eventloop_lag_seconds and default process metrics | gauge and histogram | none |

Event loop lag is the most important health signal of the gateway itself, because the gateway is a single Node process.

Tracing (OpenTelemetry). One root span per request, with child spans auth, ratelimit, cache, analyze, select_model, route, and one upstream span per attempt carrying worker.id, model, retry.attempt and ttft_ms. Propagate traceparent to workers.

Logs (pino JSON). One structured line per request containing the decision record. Prompt and response bodies are never logged unless logging.logBodies is explicitly enabled.

Decision records. The last observability.decisionBuffer (default 1000) records are kept in a ring buffer and served by the admin API. They are the main debugging tool for why did this request go there.

### 7.14 Admin Plane

| Endpoint | Purpose | Phase |
| --- | --- | --- |
| GET /admin/stats | Live JSON snapshot for the dashboard: request rate, latency percentiles, error rate, per-worker state, per-model counts, cache hit rate, event loop lag | v1 |
| GET /admin/workers | Worker states including breaker and health | v1 |
| GET /admin/models | Registry with live latency estimates | v1 |
| GET /admin/decisions?limit=N | Recent decision records | v1 |
| GET /admin/config | Effective config with secrets redacted | v1 |
| POST /admin/config/reload | Re-read and validate the config, then swap it atomically. An invalid config is rejected and the old one stays active. A SIGHUP does the same. | v1 |
| POST /admin/workers/:id/drain | Stop new requests to a worker, let in-flight finish | Stretch |
| POST /admin/workers, DELETE /admin/workers/:id | Register or remove a worker at runtime | Stretch |
| API key management | Create, rotate and revoke keys | Stretch |

### 7.15 Dashboard

A React app that polls /admin/stats every 1 to 2 seconds for live views, and loads benchmark result files for comparison views. Grafana remains available for deeper metric exploration.

- Overview: requests per second, error rate, p50, p95 and p99 latency, cache hit rate, gateway overhead and event loop lag.
- Workers: one card per worker with health, breaker state, in-flight count, EWMA latency, error rate and a short history chart.
- Models and routing: distribution of selected models by task and priority, fallback count, queue depth.
- Strategy comparison: charts from benchmark runs showing p50, p95 and p99 latency, throughput, error rate and load imbalance per strategy and scenario.
- Recent decisions: searchable table of decision records with the reason for each choice.

### 7.16 Mock Worker

A small OpenAI-compatible server in TypeScript. It lets the whole team develop and benchmark without GPUs, and it makes failure scenarios reproducible.

- Endpoints: /v1/chat/completions (streaming and non-streaming), /v1/embeddings, /v1/models, /health, /metrics (running and waiting counts), and a control endpoint /__control.
- Latency model: time to first token and tokens per second are configurable per model, with jitter (log-normal by default). Output length follows a configurable distribution, with a heavy tail option, because heavy tails are where routing strategies differ.
- Load behavior: the worker has a capacity c. When inFlight exceeds c, latency inflates (slowdown = 1 + k * (inFlight - c) / c), or requests wait in an internal queue, selectable by config. This is what makes load-aware routing matter.
- Fault injection (set at start or at runtime through /__control): error rate, probability of hanging, crash after N requests, degradation windows (for example latency times 5 from t=60 s), failing health checks while still serving, and refusing connections.
- Determinism: with a seed, the same prompt gives the same output and timing draw, so cache and coalescing tests are repeatable.
- Profiles: presets such as fast-small, slow-large and flaky, so a benchmark can mix heterogeneous workers by name.

### 7.17 Benchmark Harness

The harness exists to answer the research question with measurements.

Method rules:

- Open-loop load. Requests arrive at a target rate regardless of how fast the system answers (k6 constant-arrival-rate or a Poisson generator). Closed-loop load hides overload by slowing itself down.
- Same trace for every strategy. Use the same seeds and the same request trace, switching strategies with x-gateway-routing or config.
- Warm-up and repetition. 30 s warm-up, 5 minutes of measurement, at least 5 repetitions per scenario and strategy. Report mean and confidence interval, not one run.
- Isolation. Run the gateway, the mock workers and the load generator as separate processes (separate containers with CPU limits). A load generator that shares a CPU with the gateway invalidates the result. Record the machine details with every run.
- Overhead baseline. Measure the gateway's own ceiling against zero-latency mock workers, so gateway cost can be separated from routing effects.

Scenarios:

| ID | Scenario | Purpose |
| --- | --- | --- |
| S1 | Homogeneous workers, steady load | Baseline. Adaptive should not be worse here. |
| S2 | Heterogeneous workers (for example 2x speed difference) | Does load-plus-latency awareness beat counting in-flight requests? |
| S3 | One worker slows down mid-run | Reaction time and tail latency during degradation |
| S4 | One worker crashes, then recovers | Failover, breaker behavior, time to recover, error rate |
| S5 | Bursty traffic and spikes | Queueing, shedding and herding behavior |
| S6 | Heavy-tailed output lengths | Where in-flight counting misjudges real load |
| S7 | Priority mix with auto models | Model selection correctness against expected choices |

Metrics per run: end-to-end latency p50, p95 and p99; time to first token; throughput; error rate; retry and failover counts; load imbalance (standard deviation of per-worker request share); time to recover after a fault; gateway CPU usage and event loop lag p99.

Outputs: raw JSON per run, an aggregated JSON file for the dashboard, and a generated Markdown report that states the configuration, strategy parameters and weights used.

Hypothesis to test: adaptive routing improves tail latency when workers are heterogeneous or degrade (S2, S3, S6) and gives little or no gain when workers are identical (S1). The report must state plainly when the data does not support this.

## 8. Configuration

One YAML file, validated at startup by zod schemas from packages/shared. Invalid config makes the gateway refuse to start (and makes a hot reload fail without changing anything). Secrets come from environment variables, never from the file. Every value below is a default or an example.

```yaml
server:
  port: 8080
  adminPort: 8081
  bodyLimitBytes: 1048576
  defaultTimeoutMs: 120000
  shutdownGraceMs: 30000

auth:
  keys:
    - id: team-a
      name: Team A
      hashEnv: KEY_TEAM_A_SHA256          # env var holding the SHA-256 of the key
      roles: [client]
      allowedModels: ['*']
      defaultPriority: balanced
      limits: { rpm: 600, tpm: 200000, maxConcurrent: 32 }
    - id: bench
      name: Benchmark runner
      hashEnv: KEY_BENCH_SHA256
      roles: [client, bench]
      allowedModels: ['*']
      limits: { rpm: 100000, tpm: 100000000, maxConcurrent: 2000 }

limits:
  maxGlobalInFlight: 500
  maxEventLoopLagMs: 100                   # shed load above this p99 lag

rateLimit:
  store: memory                            # memory | redis
  failMode: open                           # open | closed (only matters for redis)

cache:
  enabled: true
  store: memory                            # memory | redis
  ttlSeconds: 600
  maxEntries: 5000
  maxEntryBytes: 262144
  requireDeterministic: true
  replayStreaming: true

selector:
  defaultPriority: balanced
  minQuality: 0.5
  weights:
    low_latency: { quality: 0.15, latency: 0.75, cost: 0.10 }
    balanced:    { quality: 0.40, latency: 0.40, cost: 0.20 }
    high_quality: { quality: 0.75, latency: 0.15, cost: 0.10 }

models:
  - id: llama-3
    aliases: [llama3]
    capabilities: [chat, completion, streaming, json_mode]
    contextWindow: 8192
    qualitySource: placeholder             # replace with eval-set results
    quality: { chat: 0.75, code: 0.70, reasoning: 0.65, summarization: 0.75 }
    baseline: { ttftMs: 300, tokensPerSec: 70 }
    costPer1kTokens: 2
  - id: mistral
    capabilities: [chat, completion, streaming]
    contextWindow: 8192
    qualitySource: placeholder
    quality: { chat: 0.70, code: 0.62, reasoning: 0.60, summarization: 0.70 }
    baseline: { ttftMs: 200, tokensPerSec: 90 }
    costPer1kTokens: 1
  - id: phi
    capabilities: [chat, streaming]
    contextWindow: 4096
    qualitySource: placeholder
    quality: { chat: 0.55, code: 0.50, reasoning: 0.45, summarization: 0.55 }
    baseline: { ttftMs: 120, tokensPerSec: 120 }
    costPer1kTokens: 0.5

workers:
  - id: vllm-1
    backend: vllm
    baseUrl: http://vllm-1:8000
    maxConcurrency: 16
    models: { llama-3: meta-llama/Meta-Llama-3-8B-Instruct, mistral: mistralai/Mistral-7B-Instruct-v0.3 }
  - id: vllm-2
    backend: vllm
    baseUrl: http://vllm-2:8000
    maxConcurrency: 16
    models: { llama-3: meta-llama/Meta-Llama-3-8B-Instruct }
  - id: ollama-1
    backend: ollama
    baseUrl: http://ollama-1:11434
    maxConcurrency: 4
    models: { phi: phi3, gemma: gemma2 }

health:
  probeIntervalMs: 5000
  unhealthyAfterFailures: 3
  recoverAfterSuccesses: 2
  degradedErrorRate: 0.2

routing:
  strategy: adaptive                       # round_robin | least_in_flight | power_of_two | adaptive
  maxQueue: 200
  queueTimeoutMs: 2000
  adaptive:
    wLoad: 0.5
    wLat: 0.3
    wErr: 0.2
    errScale: 5
    degradedPenalty: 0.5
    minSamples: 20
    rampUpMs: 10000
    sample: all                            # all | p2c

resilience:
  maxAttempts: 2
  connectTimeoutMs: 2000
  firstByteTimeoutMs: 30000
  streamIdleTimeoutMs: 15000
  retryBudget: { ratio: 0.1, windowMs: 10000 }
  breaker: { consecutiveFailures: 5, errorRate: 0.5, minRequests: 20, windowMs: 30000, openMs: 10000, maxOpenMs: 60000, halfOpenMax: 2 }

streaming:
  clientStallMs: 30000
  heartbeatMs: 15000

observability:
  decisionBuffer: 1000
  otlpEndpoint: http://otel-collector:4318
logging:
  level: info
  logBodies: false
```

## 9. System behavior

### 9.1 Walkthrough: a streaming request with model: auto

A client sends POST /v1/chat/completions with model: auto, stream: true, header x-gateway-priority: high_quality and a prompt that asks for a function in TypeScript.

1. The API Layer validates the body, assigns request ID r-123 and wires client disconnect to an abort signal.
2. Auth finds key team-a. The rate limiter takes one request from the bucket and checks concurrency.
3. The cache key is computed. The request is streaming and not deterministic, so it is not cache-eligible. The decision record notes cache: bypass.
4. The Rate Limiter reserves estimated tokens (prompt estimate plus max_tokens).
5. The Task Analyzer sees a code fence and the word function, so task: code, source: rule, and required capabilities are chat and streaming.
6. The Selector filters models by capability, context length, permission and available workers, then ranks them with the high_quality weights. The top model is llama-3.
7. The Router filters workers that serve llama-3 (vllm-1 and vllm-2), drops any unhealthy, breaker-open or saturated one, and asks the active strategy to pick. It picks vllm-2. inFlight for vllm-2 goes up by one.
8. The Resilience Layer starts the call with the first-byte timeout and the request deadline. The adapter sends the request and injects stream_options.include_usage.
9. The first chunk arrives. The Streaming Proxy records time to first token, sends response headers (x-gateway-model: llama-3, x-gateway-worker: vllm-2) and starts forwarding chunks with backpressure.
10. The final usage chunk arrives, then data: [DONE].
11. Finalize runs: inFlight goes down, EWMA latency and TTFT for vllm-2 update, the breaker records a success, unused reserved tokens are refunded, metrics and the trace are emitted, and the decision record is stored.

### 9.2 Failure and edge behavior

| Situation | Gateway behavior | Client sees |
| --- | --- | --- |
| Worker refuses connections before dispatch | Count a breaker failure and retry on another worker | Normal response, x-gateway-attempts: 2 |
| Worker times out before the first token | Abort, count a failure, retry elsewhere if attempts and deadline allow | Normal response, or 504 upstream_timeout if exhausted |
| Worker dies in the middle of a stream | No retry. Send an SSE error event and close. Count stream_interrupted and a breaker failure. | Truncated stream ending in an error event |
| Worker is alive but slow | Latency EWMA rises. Adaptive routing shifts traffic away. Round-robin does not, and that difference is what the benchmark measures. | Normal responses, slower on affected worker |
| All workers for an explicit model are down | No substitution. 503 with retry-after. | 503 no_healthy_worker |
| All workers for the top auto model are down | Fall through to the next ranked model, set the fallback header. If none remain, 503. | Normal response with x-gateway-fallback: true, or 503 |
| No model has a required capability (for example images) | Reject before any worker is touched | 422 no_compatible_model |
| Client disconnects | Abort upstream, release counters, record as client cancelled (not a worker error) | Nothing |
| Rate limit exceeded | Reject before any upstream call | 429 with retry-after |
| All candidate workers saturated | Wait in the bounded queue. On timeout or full queue, reject. | 503 gateway_overloaded |
| Event loop lag above maxEventLoopLagMs | Shed new requests until lag recovers | 503 gateway_overloaded |
| Cache hit | Serve the stored response, no worker involved | Response with x-gateway-cache: hit |
| Identical request already in flight | Become a follower of the leader's upstream call | Same response as the leader |
| Redis unreachable | Cache treated as a miss. Rate limiter follows failMode. Metric incremented. | Normal behavior |
| Invalid config on reload | Reject the reload, keep the active config, log the error | Admin call returns the validation error |

### 9.3 Startup and shutdown

Startup: load and validate config (fail fast), build adapters and connection pools, start the admin and metrics listeners, run a first health probe round (all workers start as unhealthy until a probe succeeds), then open the public listener. /readyz reports ready only when at least one worker is healthy.

Shutdown (SIGTERM): /readyz turns unready, the public listener stops accepting new connections, in-flight requests get up to shutdownGraceMs (default 30 s) to finish, remaining streams receive an SSE error event and are closed, logs and metrics are flushed, and the process exits.

### 9.4 Invariants

These must hold at all times and are the basis for property and leak tests.

- A request is never sent to a worker that is unhealthy, draining, breaker-open, missing the model, or already tried for this request.
- An explicitly named model is never replaced by another model.
- After the first byte is sent to the client, the worker for that request never changes.
- Total upstream attempts never exceed maxAttempts.
- Every request produces exactly one finalize and one decision record.
- When the gateway is idle, every worker's inFlight is 0.
- Prompt and response text never appear in logs unless logBodies is enabled.

## 10. Node.js concurrency and performance guidelines

The gateway is a single Node process with one event loop. Its own overhead will show up in every benchmark, so these rules are part of the spec, not optional polish.

- Keep per-request CPU work tiny. The pipeline should add microseconds to low milliseconds. Target (to be validated by the overhead baseline): gateway-added latency p99 under 5 ms excluding queue wait.
- Nothing blocking on the hot path. No synchronous file or crypto work, no large JSON parse or stringify per streamed chunk, no regex that can backtrack on prompt text. Cap body size.
- Offload CPU-heavy tasks (exact tokenization, the classifier) to a piscina worker pool with time budgets.
- Connection pools. One undici Pool per worker with connections at least equal to the worker's maxConcurrency, keep-alive on, no pipelining for streaming.
- Stream, do not buffer. Respect backpressure, cap cache entry sizes, avoid per-chunk allocations, and expose heap and event loop metrics.
- Watch the event loop. Use perf_hooks.monitorEventLoopDelay, export it as a metric, and shed load when it passes the threshold.
- No cluster or multi-process in v1. In-flight counts, breakers, rate limits and the cache live in one process's memory. Splitting across processes would break the routing comparison. If one process saturates, that ceiling is a result to record. Multi-process would need shared state (Redis) and is a later design.
- Timers and cancellation. Use AbortSignal everywhere, clear timers in finalize, and never leave a promise that ignores the abort signal.
- Crash policy. Unhandled rejections and uncaught exceptions are logged and the process exits. The container restart policy brings it back.
- Build. tsx for development, a compiled ESM build for production and benchmarks (never benchmark under tsx).

## 11. Security and privacy

- API keys are stored only as hashes and never logged. Admin endpoints use a separate admin key and port.
- TLS terminates at a reverse proxy (Caddy or nginx) in front of the gateway, or at Node if configured.
- Worker addresses come only from config, never from request content, which rules out server-side request forgery.
- Forward only an allowlist of headers to workers. Never forward the client's Authorization.
- Enforce body size, message count and header limits. Validate every input with zod.
- Logs exclude prompts and responses by default. Cache entries are namespaced per API key, have a TTL, and are never shared across keys unless explicitly configured.
- Commit the lockfile, pin versions, and run a dependency audit in CI.

## 12. Testing strategy

| Level | What is covered |
| --- | --- |
| Unit | Selector filters and scoring (reproduce the worked example in 7.6), each routing strategy, circuit breaker state machine (fake timers), token bucket, cache key canonicalization (key order must not matter), SSE parser, task analyzer rules, config schemas |
| Property (fast-check) | The selector never returns a model lacking a required capability. The router never returns an excluded worker. The rate limiter never admits more than its capacity. |
| Integration (vitest, gateway in process with real mock workers) | Streaming and non-streaming happy paths, auto selection, retry after a worker kill, breaker open and close, cache hit, coalescing, rate limit, queue overflow, client abort |
| Fault injection | Kill a mock worker mid-stream, hang it, slow it, flap its health checks |
| Compatibility | The official openai npm client calls chat (streaming and not) and /v1/models against the gateway without changes |
| Leak test | Send at least 10,000 requests with random aborts and timeouts, then assert every inFlight is 0, no open handles remain and the heap is stable |
| Load | The benchmark harness (section 7.17), plus a short smoke benchmark in CI to catch regressions |

Coverage target: at least 90% line coverage on the decision modules (selector, router, breaker, limiter). CI runs install with a frozen lockfile, lint, typecheck, tests and build.

## 13. Delivery plan

Agree the interfaces in packages/shared first (section 5) so people can work in parallel.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| P0 Skeleton | Monorepo, shared types, config loader, gateway proxying to one mock worker (streaming and not), basic mock worker | The official OpenAI client works against the gateway |
| P1 Workers and routing | Registry, health monitor, round_robin, least_in_flight, power_of_two, decision records, basic metrics | Traffic spreads across workers and unhealthy workers get none |
| P2 Resilience | Timeouts, retries, circuit breaker, bounded queue, streaming rules, fault injection in the mock | Scenario S4 passes with no client-visible errors for retryable faults |
| P3 Model layer | Model registry, task analyzer rules, selector, auto | Selector tests pass and the worked example is reproduced |
| P4 Protection | Auth, rate limiter, cache, coalescer | Limits, cache and coalescing behave as specified |
| P5 Observability | Full metrics, tracing, admin stats, dashboard pages | Live dashboard shows worker, breaker and queue state |
| P6 Adaptive and benchmarks | Adaptive strategy, harness, scenarios S1 to S6, report | Report compares all four strategies |
| P7 Stretch | Classifier, admin mutations, Redis adapters, embedding micro-batching, semantic cache | Optional |

Suggested ownership for a four-person team (adjust to your size): one person on gateway core (API, auth, pipeline, streaming proxy), one on workers, routing and resilience, one on the model layer (analyzer, selector, eval data), one on mock worker, benchmarks and dashboard.

## 14. Acceptance criteria

- The official OpenAI client works unchanged against the gateway for chat, streaming and model listing.
- model: auto with each priority selects the expected model on the test set, and the worked example in 7.6 is reproduced.
- An explicit model is never substituted, and a request no model can serve returns 422.
- Workers that are unhealthy, draining or breaker-open receive no new requests.
- When a worker is killed during a run, requests that had not started streaming succeed through retry, and interrupted streams end with an error event.
- The leak test finishes with every inFlight at 0.
- Rate-limited requests receive 429 with retry-after.
- Cache hits skip workers, and non-deterministic requests are not cached.
- The dashboard shows live worker state, and the benchmark report compares all four strategies across scenarios S1 to S6.
- The gateway's own overhead (added latency and CPU at a stated request rate against zero-latency mock workers) is measured and documented.
- The final report states whether adaptive routing helped, under which conditions, and says plainly where the data shows no benefit.

## 15. Assumptions and open questions

- Real workers. Assumed: development and benchmarks use mock workers, with one validation run against real vLLM and Ollama if hardware is available. Confirm.
- Quality scores. Per-task quality needs evaluation sets (small curated sets are enough to start). Until then the scores are placeholders and the report must say so.
- Redis. Assumed not needed in v1. Memory stores are the default and Redis is a later adapter.
- Target scale. No request rate or concurrent-stream target is given. The overhead baseline will establish the ceiling of a single Node process.
- Tool calling. Assumed to be pass-through only. The gateway does not execute tools.
- Multi-instance gateway. Deferred. It would require shared registry and rate-limit state, and a plan for coalescing across instances.
- Authentication. Static API keys only. Anything richer (OAuth, per-user quotas) is out of scope.
