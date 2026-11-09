# Inference Gateway implementation plan

Status: proposed execution plan. Source of truth: [SPEC.md](SPEC.md), Draft v0.1. See [ARCHITECTURE.md](ARCHITECTURE.md) for proposed ownership, correctness and benchmark refinements mapped to these phases.

This plan divides the specification into small deliverables that can be reviewed and verified independently. A phase is complete only when its exit checks pass. The current repository is an initial scaffold; it does not yet satisfy P0. Keep later functionality out of earlier phases unless required to make that phase work.

## Current baseline

Present: pnpm workspace, strict TypeScript base configuration, shared chat interfaces, a gateway proxy, a JSON mock worker, starter YAML configuration and a lockfile.

Phase 1 now provides compiled shared exports, per-package builds, workspace checks and an explicit disconnect controller. Frozen install, lint, typecheck, formatting and build passed on Node 26. Node 22 verification and compiled HTTP startup remain pending because the execution environment lacked Node 22 and denied listening on ports. The gateway still forwards upstream headers wholesale and reports readiness without checking the worker. The mock worker returns JSON even when streaming is requested. SDK compatibility, streaming and lifecycle correctness remain unproven.

## Execution rules

- Use Node.js 22, TypeScript ESM and compiled builds for production and benchmarks.
- Prefer one reviewable change per numbered step below. Keep every merged phase runnable.
- Implement interfaces at their first real use; avoid empty implementations that imply support.
- Add unit checks for decision logic and integration checks at HTTP boundaries. Use fake clocks and seeded randomness where appropriate.
- Carry abort signals and deadlines through every asynchronous operation.
- Maintain one finalization owner for request counters, telemetry and cleanup.
- Do not claim performance or quality improvements until measured.
- Update this document with completion evidence, commands and remaining limitations as phases land.

## Decisions to settle before their dependent phase

| Decision                 | Proposed starting point                                                                                 | Needed before |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------- |
| Local real workers       | Mock workers first; real backend validation when hardware is available                                  | Phase 22      |
| Quality evaluation       | Mark all initial scores as placeholders; record dataset and evaluation version later                    | Phase 13      |
| Latency units            | Convert output-token duration to milliseconds before adding TTFT                                        | Phase 13      |
| Analyzer precedence      | Hints choose task; independently collect every hard capability requirement                              | Phase 12      |
| Health eligibility       | Include degraded workers; exclude unhealthy and draining workers                                        | Phase 7       |
| Adaptive load expression | Use `(inFlight + (queueDepth ?? 0)) / maxConcurrency`                                                   | Phase 18      |
| Example inconsistency    | Worker `ollama-1` references unregistered `gemma`; remove it or register it in valid example config     | Phase 2       |
| Live model latency       | Track throughput as well as latency; define aggregation and sample threshold                            | Phase 13      |
| Reload scope             | Build and validate replacement resources before swapping; retire old pools after active requests finish | Phase 16      |
| Missing SSE completion   | Treat EOF without a valid terminal marker as interruption, never cache it                               | Phase 5       |

These clarify implementation ambiguities; changes to public behavior should be reflected in SPEC.md when agreed.

## Phase 1 — Make the workspace reproducible

**Depends on:** existing scaffold. **Spec:** sections 3, 10, 12; P0.

1. Set Node 22 and pnpm versions in repository metadata; format package manifests and pin dependencies in the lockfile.
2. Define shared TypeScript configuration and package build order. Export compiled JavaScript and declarations from shared.
3. Add root scripts for development, build, lint, typecheck and tests. Add development tooling and Node types.
4. Make configuration paths independent of whether code runs through tsx or from dist.
5. Document clean setup, ports, environment variables and compiled startup in README.md.

**Exit:** frozen-lockfile installation and all workspace builds succeed on Node 22; a fresh checkout has documented commands to start both services.

## Phase 2 — Shared contracts and configuration

**Depends on:** 1. **Spec:** sections 5, 8.

1. Add Priority, Task, Capability, ModelSpec, WorkerConfig, WorkerState, GatewayRequest, RouteContext, RoutingStrategy and DecisionRecord.
2. Add zod schemas for gateway configuration and request extensions; infer types rather than duplicating schemas.
3. Separate file loading, environment secret resolution and validation. Fail startup on missing required secrets.
4. Validate duplicate IDs, alias collisions, worker model references, positive capacities, timeouts and selector weights.
5. Provide a valid local mock configuration and a separate deployment example. Redact resolved secrets before serialization.

**Exit:** invalid files fail with actionable field paths; example config is valid; secrets never appear in effective config output.

## Phase 3 — HTTP request lifecycle

**Depends on:** 2. **Spec:** sections 6, 7.1, 9.4.

1. Separate app construction from process startup so integration checks can create and close a service.
2. Implement chat body validation with unknown OpenAI fields preserved, body/message/header limits and safe request IDs.
3. Normalize header/body extensions with header precedence and reject invalid extension values.
4. Create request context with deadline, disconnect cancellation and exactly-once finalization.
5. Centralize OpenAI-shaped errors and response headers, including errors before dispatch.

**Exit:** invalid input has stable status/code; disconnect aborts context; finalization runs once on success, rejection and abort.

## Phase 4 — One-worker adapter and JSON proxy

**Depends on:** 3. **Spec:** sections 7.12; P0.

1. Define adapter request/response and normalized UpstreamError contracts.
2. Implement an undici Pool for the mock worker, canonical model mapping and upstream header allowlist.
3. Strip gateway-only payload fields; preserve output-affecting OpenAI fields.
4. Handle non-streaming chat, model listing and health probes. Never forward client Authorization.
5. Close pools during service shutdown and propagate cancellation to upstream I/O.

**Exit:** official OpenAI client completes JSON chat and model listing against the gateway; unknown models return clear errors.

## Phase 5 — Streaming proxy

**Depends on:** 4. **Spec:** sections 6.5, 7.11.

1. Implement mock SSE role/content/usage chunks and terminal `[DONE]`.
2. Delay client headers until the first upstream body chunk; use bounded buffering and backpressure.
3. Detect SSE boundaries across arbitrary byte splits, including UTF-8 boundaries, without parsing every event.
4. Extract usage and TTFT; wire first-byte, idle, total and client-stall timers with cleanup.
5. Emit heartbeats only after headers. On post-start failure, write one error event and close without retry.

**Exit:** SDK streaming works; slow clients do not cause unbounded buffers; mid-stream faults and disconnects release all resources. Phases 1–5 complete the usable P0 path.

## Phase 6 — Reproducible mock worker

**Depends on:** 5. **Spec:** section 7.16.

1. Add seeded per-request output/timing draws, model profiles, TTFT, token rate and output distributions.
2. Add capacity slowdown and optional internal queue behavior; expose running/waiting metrics.
3. Implement embeddings, model listing and validated `/__control` settings.
4. Add hangs, error probabilities, degradation windows, health failures and process crash controls.
5. Support deterministic reset between benchmark runs and prompt identity independent of strategy execution order.

**Exit:** a recorded seed/control sequence reproduces draws; hanging work can be aborted; control APIs remain local to development/benchmark environments.

## Phase 7 — Worker registry and health

**Depends on:** 4, 6. **Spec:** section 7.8; P1.

1. Store configured workers separately from mutable runtime state; start unavailable until probing succeeds.
2. Probe health and loaded models with jitter, timeout and no overlapping probes per worker.
3. Implement health transitions, passive outcome windows, EWMA latency/TTFT and optional metric scraping.
4. Add dispatch/release ownership so inFlight changes exactly once, including aborts.
5. Make readiness depend on actual available workers and shutdown state.

**Exit:** unhealthy/draining/missing-model workers are excluded; counters return to zero on every outcome; timers stop on close.

## Phase 8 — Baseline worker routing

**Depends on:** 7. **Spec:** section 7.9; P1.

1. Centralize candidate filtering, including saturation, tried workers and breaker admission hooks.
2. Implement per-model round-robin, random-tie least-in-flight and power-of-two choices.
3. Inject randomness for repeatable routing checks and avoid duplicate sampling when two candidates exist.
4. Reserve worker capacity synchronously with selection to prevent oversubscription between concurrent requests.
5. Record chosen strategy and worker in the request decision.

**Exit:** traffic distributes as defined; property checks never select excluded workers; independent models do not corrupt round-robin cursors.

## Phase 9 — Timeouts and bounded retries

**Depends on:** 5, 8. **Spec:** section 7.10; P2.

1. Apply connect/first-byte/idle/deadline limits with normalized upstream failures.
2. Retry only eligible pre-response failures, always on a different worker, within maxAttempts and deadline.
3. Implement abortable full-jitter backoff and bounded Retry-After handling.
4. Add the rolling retry budget and a documented low-traffic allowance.
5. Keep worker error accounting separate from client aborts and non-failing upstream 4xx.

**Exit:** retryable pre-stream faults recover when capacity exists; no retry occurs after client bytes; exhausted failures map to documented errors.

## Phase 10 — Circuit breakers

**Depends on:** 9. **Spec:** section 7.10.

1. Implement consecutive-failure and rolling-error trip thresholds using an injected clock.
2. Add open backoff, half-open trial reservations and required consecutive recovery successes.
3. Release trial slots on every outcome and define cancellation without treating it as worker failure.
4. Integrate breaker admission into routing while retaining independent probe health.

**Exit:** fake-clock transition checks pass; trial concurrency is bounded; open workers receive no ordinary traffic.

## Phase 11 — Bounded dispatch queue

**Depends on:** 8–10. **Spec:** section 7.9.

1. Add per-model FIFO queues with capacity and wait timeout.
2. Wake waiters when worker capacity or availability changes; remove cancelled entries promptly.
3. Include queue time in total deadlines and distinguish overload from absent healthy capacity.
4. Bound timers/listeners and reject remaining waiters during shutdown.

**Exit:** queue order, full rejection, timeout and abort behavior are proven; no dispatch exceeds worker capacity.

## Phase 12 — Task analysis and model compatibility

**Depends on:** 2, 7. **Spec:** sections 7.5–7.6; P3.

1. Build model registry and canonical alias resolution with key permission inputs.
2. Collect endpoint, vision, tools, JSON and streaming requirements independently from task classification.
3. Implement bounded text rules and character-based prompt token estimates.
4. Validate explicit models for capability and context without substitution.
5. Distinguish incompatible models from compatible models with unavailable workers.

**Exit:** property checks never accept missing capabilities; explicit models stay explicit; hints cannot bypass payload requirements.

## Phase 13 — Automatic model selection

**Depends on:** 12. **Spec:** section 7.6.

1. Implement quality floor, normalized quality/latency/cost terms and deterministic tie-breaking.
2. Handle absent quality/cost and zero denominators explicitly; flag fallback quality and placeholders.
3. Estimate latency with consistent units, output limits, baseline stats and documented live aggregation.
4. Return the full ordered ranking; dispatch lower-ranked models only for auto when availability changes.
5. Set fallback/model headers and record scores and effective weights.

**Exit:** worked example winners and approximate scores match; all priorities have curated expected choices; explicit requests never fall back.

## Phase 14 — Authentication and admission

**Depends on:** 3, 13. **Spec:** sections 7.2–7.3; P4.

1. Hash bearer keys and resolve configured roles, allowed models, priority and limits.
2. Restrict routing overrides to bench keys and admin routes to admin keys.
3. Define RateLimitStore and implement atomic in-memory request/token buckets and concurrency limits.
4. Check concurrency then requests; reserve tokens after cache miss and reconcile actual usage once.
5. Add global in-flight shedding, rejection rollback and remaining/retry headers.

**Exit:** unauthorized calls do not reach workers; token refunds and rejection rollback are correct; cache hits will consume requests but no tokens.

## Phase 15 — Exact cache and coalescing

**Depends on:** 5, 13–14. **Spec:** sections 7.4, 7.7.

1. Define CacheStore and canonical keys covering all supported output-affecting fields, endpoint, priority and key namespace.
2. Implement LRU limits, TTL, deterministic eligibility, tools exclusion and bypass behavior.
3. Store only clean complete successes within size limits; synthesize streaming replay with usage.
4. Coalesce eligible non-streaming calls by cache key and resolved model using shared upstream ownership.
5. Reference-count waiters: leader cancellation preserves followers; last waiter cancellation aborts shared work.

**Exit:** cache hits skip dispatch; parameter/key differences cannot collide; truncated streams never cache; coalescing cancellation has no leaks.

## Phase 16 — Admin plane and config reload

**Depends on:** 7, 10, 13–15. **Spec:** section 7.14.

1. Open a separate admin listener with authentication and redacted configuration output.
2. Expose workers, models, bounded decision history and live stats schemas.
3. Implement atomic reload through POST and SIGHUP; validate/build replacements before activation.
4. Preserve active request resources until completion and close retired pools safely.
5. Reject invalid reloads without altering current state; document counter/cache behavior for changed keys and models.

**Exit:** secrets remain redacted; invalid reload preserves service; valid reload under traffic does not interrupt active work.

## Phase 17 — Observability and operational lifecycle

**Depends on:** 9–16. **Spec:** sections 7.13, 9.3, 10.

1. Emit the full metric inventory with bounded labels and one structured decision per request, including early errors and cache hits.
2. Add root/stage/attempt traces, traceparent propagation and OTLP shutdown flushing.
3. Track event-loop delay, process metrics and lag-based admission shedding with recovery behavior.
4. Implement graceful drain, public listener shutdown, forced stream errors after grace and cleanup of every timer/pool.
5. Add Compose services and provisioned Prometheus/Grafana/tracing configuration; keep Redis optional.

**Exit:** metrics and traces explain one request end to end; bodies are absent from default logs; graceful and forced shutdown release handles.

## Phase 18 — Adaptive routing

**Depends on:** 8, 17. **Spec:** section 7.9; P6.

1. Implement configurable load, latency, error and degraded terms with finite-value guards.
2. Use pool median for cold workers and normalized capacity for heterogeneous workers.
3. Add optional best-two random selection and recovery ramp-up capacity.
4. Log effective strategy parameters with benchmark metadata; keep shared filtering identical across strategies.

**Exit:** deterministic score examples pass; cold workers get traffic; ramp-up caps hold; all four strategies share identical eligibility rules.

## Phase 19 — Dashboard

**Depends on:** 16–18. **Spec:** section 7.15; P5.

1. Add React/Vite workspace and typed admin client with secure local admin credential handling.
2. Implement overview, worker cards/history, model distribution and decision search.
3. Poll every 1–2 seconds with cancellation, stale/error states and bounded history.
4. Add benchmark JSON loading and strategy/scenario comparison charts once phase 20 defines the artifact schema.

**Exit:** worker/queue/breaker changes appear live; no credentials enter public bundles; invalid/offline responses remain understandable.

## Phase 20 — Benchmark runner and artifacts

**Depends on:** 6, 17–18. **Spec:** section 7.17.

1. Define versioned run manifests, raw result and aggregate schemas with machine/config/commit metadata.
2. Generate seeded request traces and schedule open-loop arrivals through k6 and a TypeScript orchestrator.
3. Run gateway, workers and generator in isolated processes/CPU allocations using compiled builds.
4. Reset worker state between strategies; use identical traces, warm-up, measurement and repetition settings.
5. Aggregate latency, TTFT, throughput, errors, retries, recovery, imbalance, CPU and loop lag with confidence intervals.

**Exit:** a short smoke run produces valid raw/aggregate artifacts; results report dropped arrivals and generator saturation rather than hiding overload.

## Phase 21 — Scenarios and research report

**Depends on:** 20. **Spec:** sections 7.17, 14.

1. Implement S1 homogeneous, S2 heterogeneous and S3 degradation scenarios.
2. Add S4 crash/recovery, S5 bursts, S6 heavy tails and S7 priority/model correctness.
3. Measure a direct-worker baseline and zero-latency gateway ceiling at stated rates.
4. Execute standard 30-second warm-up, 5-minute measurement and at least five repetitions for each strategy/scenario.
5. Generate Markdown findings with configuration, weights, uncertainty, placeholder quality caveats and unsupported hypotheses stated plainly.

**Exit:** report compares all four strategies across S1–S6, includes overhead evidence and states where adaptive routing offers no measured benefit.

## Phase 22 — Release acceptance

**Depends on:** 1–21. **Spec:** sections 12, 14.

1. Run official SDK compatibility for JSON chat, streaming and model listing; verify embeddings when configured.
2. Run capability, routing and admission properties; achieve 90% line coverage for selector/router/breaker/limiter.
3. Run at least 10,000 requests with random aborts/timeouts and verify zero in-flight counts, no leaked handles and stable heap behavior.
4. Exercise faults before/after first client bytes, retry limits, queues, reload and shutdown.
5. Add CI frozen install, lint, typecheck, tests, build, dependency audit and short benchmark smoke.
6. Validate real vLLM/Ollama where available; otherwise record this acceptance limitation explicitly.

**Exit:** each acceptance item in SPEC.md has linked evidence or an explicit unresolved limitation; no performance target is marked achieved without measurements.

## Deferred work

Classifier in a worker pool, Redis stores, runtime worker mutations, embedding micro-batching, semantic caching and multi-instance operation remain separate proposals. Each needs its own acceptance criteria and failure model. Legacy text completions are optional and should be added only when a client requires them.

## Completion record

For each completed phase, append: commit/PR, commands run, observed results, changed assumptions and remaining limitations. A pushed scaffold is not evidence that its runtime acceptance checks passed.

### Phase 1 progress

Implemented Node 22/pnpm 10.14.0 metadata, formatted manifests, exact dependency versions, shared compiled exports, package-local output directories, root development/build/lint/typecheck/test commands, ESLint/Prettier configuration, Node types declaration and setup/startup documentation. Gateway config paths support source and compiled module layouts with a GATEWAY_CONFIG override. Fixed the nonexistent Fastify request.signal reference while preparing compilation.

Validation after dependencies were installed in the normal terminal:

- Frozen offline install succeeded using the existing pnpm store; lockfile matches manifests.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build` passed on Node 26.7.0.
- `pnpm test` runs successfully with no test files; it establishes no behavioral coverage.
- Compiled startup reached the listen calls, but this sandbox denied binding ports 8080/8081 with EPERM. HTTP smoke checks could not run.
- Node 22 remains unavailable in this shell. Node 22 installation/build and compiled HTTP startup must still be checked in a normal terminal before marking Phase 1 complete.

### Phase 2 progress

- Added shared schema-derived model, worker, priority, task and capability contracts, runtime request/routing/decision interfaces and request extension validation.
- Added full configuration defaults, field-path diagnostics, duplicate/alias/reference checks, capacity/timeout/weight validation and strict unknown-field rejection.
- Separated YAML reading, validation and environment secret resolution. Startup rejects missing secrets; effective configuration serialization uses explicit redaction.
- Replaced the local scaffold config and added a separate deployment example without the unregistered gemma reference. The proxy still uses its first worker until routing phases.
- Added tests for examples, defaults, invalid configurations, extension values, missing secrets and redaction. Node 22 remains unavailable; validation was run on Node 26.
- Verification: 23 tests, workspace build, typecheck, lint and formatting passed. Compiled startup rejects missing secrets with field paths. Both compiled services started in an HTTP smoke check, but the existing chat proxy returned an empty body; end-to-end proxy correctness remains pending in its lifecycle/adapter phases.
