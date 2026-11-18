# Inference Gateway

Single-instance OpenAI-compatible inference gateway in TypeScript. The design is in [docs/SPEC.md](docs/SPEC.md); the delivery checklist is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

The repository provides a validated HTTP gateway and a pooled JSON adapter to a mock worker, verified with the official OpenAI JavaScript SDK. Streaming, authentication, routing and retries are later phases. Use this scaffold locally until those protections are implemented.

## Requirements and installation

Use Node.js 22 and pnpm 10.14.0. With nvm installed:

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
```

## Development

From the repository root:

```sh
pnpm dev
```

This builds the shared package first, then watches the gateway and mock worker. Rebuild shared with `pnpm --filter @gateway/shared build` after changing its exports.

Default ports:

| Service     | Port | Endpoint                                         |
| ----------- | ---- | ------------------------------------------------ |
| Gateway     | 8080 | `/healthz`, `/v1/models`, `/v1/chat/completions` |
| Mock worker | 8081 | `/health`, `/v1/models`, `/v1/chat/completions`  |

The current mock port will need to change when a separate gateway admin listener is added.

## Compiled startup

```sh
pnpm build
```

Start these in separate terminals:

```sh
pnpm start:mock
```

```sh
pnpm start:gateway
```

Build order follows workspace dependencies. Each package emits JavaScript and declarations into its own `dist/`. Shared exports resolve to compiled ESM and declarations; production startup uses Node directly.

## Configuration

`config/gateway.yaml` supplies the gateway settings, model registry and worker definitions. Its default path resolves relative to the gateway module and works for both source and compiled startup. Keep the `config/` directory alongside `apps/` when deploying this scaffold.

| Variable         | Purpose                                                              | Default                          |
| ---------------- | -------------------------------------------------------------------- | -------------------------------- |
| `GATEWAY_CONFIG` | YAML path; relative paths resolve from the process working directory | Repository `config/gateway.yaml` |
| `PORT`           | Mock worker listening port                                           | `8081`                           |

The local configuration needs no secrets. `config/deployment.example.yaml` demonstrates the full schema, including canonical model mappings and placeholder quality scores. Loading that example requires `KEY_TEAM_A_SHA256`, `KEY_BENCH_SHA256` (64 hexadecimal SHA-256 characters each), and `VLLM_API_KEY`. Its vLLM backend remains a deployment proposal: the running gateway currently requires configured workers to use `backend: mock` and rejects other backends at startup. Authentication and adaptive routing remain pending.

Configuration is validated before listening. Unknown fields, duplicate IDs or aliases, invalid references, nonpositive capacities/timeouts and selector weights that do not sum to one fail with field paths. Defaults are defined in `packages/shared/src/config.ts`. Worker credentials use `apiKeyEnv`; literal secrets and URL credentials are rejected. Missing required environment secrets fail startup. Do not commit `.env` files.

The loader separates YAML reading, schema validation and secret resolution. Call `redactConfig` before serializing a resolved configuration; it replaces API key hashes and worker credentials with `[REDACTED]`. Never log the raw resolved object.

## HTTP request lifecycle

`createApp(config)` in `apps/gateway/src/app.ts` constructs the gateway without opening a port; `server.ts` loads configuration and starts the listener. Integration tests can inject requests, supply a dispatch function and observe finalization without starting a process.

Chat requests require a nonempty model, a nonempty messages array and an optional boolean `stream`. Validation preserves additional OpenAI fields, tool messages and multimodal content parts. The gateway applies these configurable limits under `server`:

| Setting            | Default | Rejection               |
| ------------------ | ------- | ----------------------- |
| `bodyLimitBytes`   | 1048576 | 413 `request_too_large` |
| `maxMessages`      | 1024    | 413 `request_too_large` |
| `maxHeaderBytes`   | 16384   | 431 `invalid_request`   |
| `maxHeaders`       | 100     | 431 `invalid_request`   |
| `defaultTimeoutMs` | 120000  | 504 `upstream_timeout`  |

Optional extensions use `gateway: { priority, task, cache, timeoutMs, routing }` in the body, or the `x-gateway-*` headers defined in [SPEC.md](docs/SPEC.md#62-gateway-extensions). Each header overrides its corresponding body field. Invalid effective extension values return 400. Priority and task enter the request context; cache bypass and routing overrides are validated for later phases and do not enable caching or routing today. Bench role enforcement arrives with authentication in Phase 14.

The deadline starts before body parsing. A timeout extension can shorten it but cannot extend it; timeout headers also cover stalled uploads. The same abort signal reaches upstream I/O and response reads. Disconnects abort outstanding work. One finalizer clears the deadline timer and disconnect/finish listeners, logs the terminal outcome and calls the optional completion observer once.

Every parsed HTTP request returns `x-request-id`. Inbound IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; other values are replaced with a UUID v7. Errors contain `error: { message, type, code, request_id }`, including JSON parsing and limit failures. HTTP parser failures before Fastify creates a request also receive an error envelope and a generated ID. Admission and cache response headers arrive with their owning phases. The mock adapter supports `stream: true` with SSE role/content chunks and `[DONE]`; set `stream_options.include_usage` to request a usage chunk.

## One-worker JSON adapter

`MockWorkerAdapter` owns an Undici keep-alive inference pool with `maxConcurrency` connections and no HTTP pipelining, plus a separate two-connection probe pool. It supports JSON/SSE chat, model and health probes, and optional mock metrics. Active requests carry an abort signal through connection setup, pool waits and JSON reads; response bodies are limited to 16 MiB. HTTP error bodies are discarded without exposing worker messages. Normalized failures carry a kind (`connect`, `timeout`, `http`, `stream`), upstream HTTP status when present and retry eligibility and bounded retry handling.

Explicit model IDs and aliases resolve to a canonical ID, then to the worker-specific name from `workers[].models`. The response model and `x-gateway-model` use the canonical ID. Successful chat also returns `x-gateway-worker`, `x-gateway-attempts` (actual attempt count) and `x-gateway-fallback: false`. Unknown models return 404 `model_not_found`; configured models without an eligible worker return 503 `no_healthy_worker`. `auto` returns 400 until automatic selection is implemented. Model listing reads the registry and exposes registered canonical IDs with at least one eligible worker advertising the mapped model.

The adapter removes the `gateway` body field and preserves other inference fields. It constructs upstream headers from an allowlist: JSON content headers, the safe request ID, valid or generated `traceparent`, and the worker's own configured bearer key. Client authorization, cookies and SDK metadata are never forwarded. Upstream transport headers, cookies and request IDs cannot overwrite gateway headers. Redirects are not followed.

`app.close()` closes the owned pool after active work finishes. The compiled server handles SIGINT/SIGTERM by closing the app; bounded draining and forced shutdown remain Phase 17 work. `/readyz` returns 200 only when at least one healthy or degraded worker advertises a configured model; otherwise it returns 503. `/healthz` remains process liveness.

## Workspace commands

| Command             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `pnpm build`        | Build packages in dependency order                   |
| `pnpm typecheck`    | Check TypeScript without emitting output             |
| `pnpm lint`         | Run ESLint with TypeScript rules                     |
| `pnpm format`       | Format supported repository files                    |
| `pnpm format:check` | Check formatting                                     |
| `pnpm test`         | Run configuration and HTTP lifecycle tests           |
| `pnpm test:smoke`   | Build and test compiled services with the OpenAI SDK |

The current tests cover configuration, lifecycle behavior, SDK JSON compatibility, model mapping, safe forwarding, error classification, keep-alive reuse and cancellation/cleanup. HTTP tests bind temporary loopback ports. `pnpm test:smoke` starts both compiled services on available local ports with temporary configuration, checks SDK chat/model listing and unknown-model errors, then verifies gateway SIGTERM shutdown and removes its temporary files. Streaming tests cover split UTF-8/SSE boundaries, bounded inspection, missing terminal markers, cancellation, backpressure and timeouts. The compiled smoke check also verifies SDK streaming and usage.

Example JSON request:

```sh
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Hello"}]}'
```

Architecture review and optional feature proposals: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reproducible mock worker

The default worker preserves the single-chunk echo behavior. Use a preset (`fast-small`, `slow-large`, or `flaky`) or a JSON settings file for simulations:

```sh
MOCK_PROFILE=fast-small pnpm start:mock
MOCK_CONFIG=config/mock-worker.json MOCK_ENABLE_CONTROL=1 pnpm start:mock
```

Settings from `MOCK_CONFIG` override the preset. The worker binds to `127.0.0.1` by default; set `MOCK_HOST` for container networking. `PORT` defaults to 8081. Controls are disabled unless `MOCK_ENABLE_CONTROL=1`, and both control methods require a loopback peer even when another host is configured.

`GET /__control` returns effective settings, running/waiting counts, request/completion/cancellation counts and time since reset. `POST /__control` accepts a strict command:

```json
{
  "reset": true,
  "profile": "fast-small",
  "settings": {
    "seed": "benchmark-1",
    "capacity": 4,
    "loadMode": "queue",
    "maxQueue": 100
  }
}
```

Settings updates merge at the top level; `models` replaces the whole model map. Invalid updates leave settings unchanged. Reset restores startup settings, clears counters and restarts the degradation clock, then applies the supplied preset/settings. Reset returns 409 while requests are running or queued. Existing requests retain their captured settings; capacity updates affect queue admission immediately.

Per-model settings are `ttftMs`, `tokensPerSecond`, `jitter` (log-normal timing spread), `outputTokens`, `outputDistribution` (`fixed`, `lognormal`, `heavy-tail`), `errorRate` and `hangRate`. Output lengths are capped at 16,384 simulated tokens and respect `max_tokens`/`max_completion_tokens`. The first simulated token echoes the last message and subsequent tokens are numbered. Usage is synthetic, with approximate prompt counts. JSON and SSE responses produce matching text and usage.

Seeded draws depend on canonical request content, not arrival order, request IDs or gateway hints. Chat streaming options do not change draws. Seeds reproduce base timing, output length and fault decisions; wall-clock scheduling, concurrency slowdown and degradation windows still affect observed latency. For comparable runs, reset to the same seed and replay the same arrival trace.

`loadMode: slowdown` applies `1 + slowdownK * max(0, running - capacity) / capacity`, captured at admission. `loadMode: queue` admits up to capacity, queues up to `maxQueue`, then returns 429. `GET /metrics` exports Prometheus `mock_running_requests`, `mock_waiting_requests`, and request/completed/cancelled totals. Counts remain occupied until the response finishes or the client disconnects. Shutdown aborts running and queued work.

Fault settings include `healthFailure` (503 health probes while inference still works), `refuseConnections` (close inference sockets while controls remain reachable), `crashAfterRequests` (exit code 1 on the Nth accepted inference request), and `degradation: [{ "startMs": 60000, "durationMs": 30000, "multiplier": 5 }]`. Degradation windows are relative to startup/reset and apply at admission. Error/hang probabilities are per model; hangs continue until cancellation or shutdown. These controls are intended for local development and benchmarks.

`POST /v1/embeddings` accepts string or string-array input, `dimensions` (1–4096), and `encoding_format` (`float` or `base64`). It returns stable normalized synthetic vectors and shares capacity, timing and fault behavior with chat. `/v1/models` lists the current model map.

## Worker registry and health

Each configured mock worker has separate runtime state: health, loaded upstream model names, in-flight requests, optional queue depth, EWMA latency/TTFT and a recent error rate. Workers start unavailable. Startup waits for one bounded probe pass; the first successful probe admits a worker as degraded. Probes run without overlap at `health.probeIntervalMs` (default 5000), with ±10% jitter. Their shared deadline is `health.probeTimeoutMs` (default 1000). Optional `/metrics` failures do not invalidate successful health/model probes. Dedicated probe connections keep busy inference sockets from starving health checks.

Failed probes degrade an eligible worker; `health.unhealthyAfterFailures` consecutive failures (default 3) mark it unhealthy and clear its loaded models. An unhealthy worker needs `health.recoverAfterSuccesses` successful probes (default 2) to return as degraded, then a further normal probe can restore healthy status. Slow health probes above `health.degradedLatencyMs` (default 1000) and error rates above `health.degradedErrorRate` (default 0.2) retain degraded status. Degraded workers stay eligible; unhealthy, draining and missing-model workers are excluded. Dispatch uses the configured baseline routing strategy among eligible workers with available capacity.

Dispatch reserves one in-flight count. The request lifecycle releases it once on response completion, failure, deadline or client disconnect, including SSE completion/failure. Client cancellations do not enter worker latency/error samples; upstream 4xx responses do not count as worker failures. Other upstream failures and timeouts update the passive error window immediately. Error rate uses the newest 50 outcomes within 60 seconds. EWMA uses `health.ewmaAlpha` (default 0.2); TTFT is recorded from streaming events. These observations are runtime state for later routing/admin work; circuit breaking is still pending.

Shutdown immediately marks workers draining and stops probes, then closes both pool types after active inference finishes. `/v1/models` uses the latest registry snapshot, so changes appear after probing. Bounded shutdown deadlines and a public drain endpoint remain later-phase work.

## Baseline worker routing

`routing.strategy` selects `round_robin`, `least_in_flight` (the interim default), or `power_of_two`. Round-robin keeps an independent cursor per canonical model. Least-in-flight chooses the smallest count with random ties. Power-of-two samples distinct workers and chooses the lower count, also breaking ties randomly. Aliases share their canonical model's cursor.

All strategies exclude unhealthy/draining workers, absent or unloaded models, open breakers, previously tried workers, and workers at `maxConcurrency`. Half-open breakers require an explicit admission policy; the breaker phase will provide trial limits. Selection and in-flight reservation happen synchronously, so concurrent requests cannot reserve the same final capacity slot. The existing lifecycle releases capacity once after JSON/SSE completion, failure or cancellation.

Chat responses include `x-gateway-routing` with the selected strategy. Finalization logs and the `onFinalize` callback include a `decision` containing the requested/canonical model, chosen worker, strategy, attempt count, status and timing. Requests rejected before selection have no chosen worker and zero attempts. Public decision history/admin endpoints remain later-phase work.

For local benchmark development, `x-gateway-routing` or the existing `gateway.routing` body extension can override the strategy (header takes precedence). The gateway remains unauthenticated; bench-role enforcement arrives with Phase 14 authentication. Explicit `adaptive` selection returns 400 until Phase 18, including startup validation when configured as the default. The deployment example describes the eventual full feature set.

When all otherwise eligible workers are saturated, requests receive 503 `gateway_overloaded`; when no eligible worker remains, they receive 503 `no_healthy_worker`. Bounded waiting is Phase 11 work. Retry dispatch supplies tried-worker sets so each attempt selects a different worker.

## Timeouts and retries

`resilience.maxAttempts` defaults to 2, including the original dispatch. Connect timeout bounds opening a connection; `firstByteTimeoutMs` bounds each attempt from dispatch until its first upstream body bytes, including header and pool waits. Streaming waits for and preserves the first chunk before exposing the response to the proxy. After that, the proxy owns stream-idle/client-stall timers, heartbeats and error framing; it never retries. JSON body completion remains bounded by the request's total deadline. Caller deadlines and disconnects cover attempts and backoff.

Before a response starts, retryable transport failures, connect/first-byte timeouts and upstream 429/502/503/504 may retry on a different eligible worker. Non-retryable HTTP statuses, malformed responses, client cancellation and started SSE responses never retry. If workers or attempts are exhausted, the last upstream error remains 502 `upstream_error` or 504 `upstream_timeout`. Each failed attempt releases its reservation and records its own outcome before another starts. Upstream 4xx does not count as a worker failure, even when 429 is retryable; client cancellation is excluded from worker error statistics.

Backoff uses full jitter with a 50ms exponential base and a 500ms cap. Valid Retry-After seconds or HTTP dates set a minimum wait; values requiring over 500ms cause the gateway to return the upstream failure instead of retrying early. Invalid/past values are ignored. Backoff is abortable, and a retry that cannot fit within the remaining deadline is skipped.

One process-wide budget per gateway dispatch instance limits retries over `resilience.retryBudget.windowMs` (default 10000). It allows `max(minRetries, floor(originalRequests * ratio))` retries in that window, with `ratio: 0.1` and `minRetries: 1` by default. The one-retry minimum supports low-traffic recovery. Set `minRetries: 0` for strict proportional budgeting, or both ratio and minimum to zero to disable retries. Budget is consumed only after reserving an eligible retry worker and immediately before dispatch; concurrent retry attempts share the same allowance. `x-gateway-attempts` and finalized decision records report actual upstream attempts.
