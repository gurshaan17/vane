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

The local configuration needs no secrets. `config/deployment.example.yaml` demonstrates the full schema, including canonical model mappings and placeholder quality scores. Loading that example requires `KEY_TEAM_A_SHA256`, `KEY_BENCH_SHA256` (64 hexadecimal SHA-256 characters each), and `VLLM_API_KEY`. Its vLLM backend remains a deployment proposal: the running gateway currently requires the first configured worker to use `backend: mock` and rejects other backends at startup. These settings do not enable authentication or worker routing yet.

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

Every parsed HTTP request returns `x-request-id`. Inbound IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; other values are replaced with a UUID v7. Errors contain `error: { message, type, code, request_id }`, including JSON parsing and limit failures. HTTP parser failures before Fastify creates a request also receive an error envelope and a generated ID. Admission and cache response headers arrive with their owning phases. The default adapter rejects `stream: true` with 400 until Phase 5 implements SSE handling.

## One-worker JSON adapter

`MockWorkerAdapter` owns an Undici keep-alive pool with `maxConcurrency` connections and no HTTP pipelining. It supports non-streaming chat, `/v1/models` and `/health` probes. Active requests carry an abort signal through connection setup, pool waits and JSON reads; response bodies are limited to 16 MiB. HTTP error bodies are discarded without exposing worker messages. Normalized failures carry a kind (`connect`, `timeout`, `http`, `stream`), upstream HTTP status when present and retry eligibility; no retries run yet.

Explicit model IDs and aliases resolve to a canonical ID, then to the worker-specific name from `workers[].models`. The response model and `x-gateway-model` use the canonical ID. Successful chat also returns `x-gateway-worker`, `x-gateway-attempts: 1` and `x-gateway-fallback: false`. Unknown models return 404 `model_not_found`; configured models absent from the first worker return 503 `no_healthy_worker`. `auto` returns 400 until automatic selection is implemented. Model listing queries the worker and exposes only registered canonical IDs whose mapped worker models are loaded.

The adapter removes the `gateway` body field and preserves other inference fields. It constructs upstream headers from an allowlist: JSON content headers, the safe request ID, valid or generated `traceparent`, and the worker's own configured bearer key. Client authorization, cookies and SDK metadata are never forwarded. Upstream transport headers, cookies and request IDs cannot overwrite gateway headers. Redirects are not followed.

`app.close()` closes the owned pool after active work finishes. The compiled server handles SIGINT/SIGTERM by closing the app; bounded draining and forced shutdown remain Phase 17 work. Health probing is available on the adapter, while `/readyz` remains a placeholder until Phase 7 wires worker health into readiness.

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

The current tests cover configuration, lifecycle behavior, SDK JSON compatibility, model mapping, safe forwarding, error classification, keep-alive reuse and cancellation/cleanup. HTTP tests bind temporary loopback ports. `pnpm test:smoke` starts both compiled services on available local ports with temporary configuration, checks SDK chat/model listing and unknown-model errors, then verifies gateway SIGTERM shutdown and removes its temporary files. Complete streaming checks belong to Phase 5.

Example JSON request:

```sh
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Hello"}]}'
```

Architecture review and optional feature proposals: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
