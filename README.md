# Inference Gateway

Single-instance OpenAI-compatible inference gateway in TypeScript. The design is in [docs/SPEC.md](docs/SPEC.md); the delivery checklist is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

The repository currently contains the workspace foundation and a JSON chat proxy to a mock worker. Streaming, authentication, routing and resilience are later phases. Use this scaffold locally until those protections are implemented.

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

The local configuration needs no secrets. `config/deployment.example.yaml` demonstrates the full schema, including canonical model mappings and placeholder quality scores. To validate that example at startup, set `GATEWAY_CONFIG=config/deployment.example.yaml`, `KEY_TEAM_A_SHA256`, `KEY_BENCH_SHA256` (64 hexadecimal SHA-256 characters each), and `VLLM_API_KEY`. These settings do not enable authentication or routing yet; the current proxy uses the first configured worker.

Configuration is validated before listening. Unknown fields, duplicate IDs or aliases, invalid references, nonpositive capacities/timeouts and selector weights that do not sum to one fail with field paths. Defaults are defined in `packages/shared/src/config.ts`. Worker credentials use `apiKeyEnv`; literal secrets and URL credentials are rejected. Missing required environment secrets fail startup. Do not commit `.env` files.

The loader separates YAML reading, schema validation and secret resolution. Call `redactConfig` before serializing a resolved configuration; it replaces API key hashes and worker credentials with `[REDACTED]`. Never log the raw resolved object.

## Workspace commands

| Command             | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `pnpm build`        | Build packages in dependency order       |
| `pnpm typecheck`    | Check TypeScript without emitting output |
| `pnpm lint`         | Run ESLint with TypeScript rules         |
| `pnpm format`       | Format supported repository files        |
| `pnpm format:check` | Check formatting                         |
| `pnpm test`         | Run configuration and contract tests     |

The current tests cover configuration and request extension contracts. SDK compatibility and streaming checks belong to later phases.

Example JSON request:

```sh
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Hello"}]}'
```

Architecture review and optional feature proposals: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
