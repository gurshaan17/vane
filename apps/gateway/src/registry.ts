import type { WorkerState } from '@gateway/shared';
import type { ResolvedConfig } from './config.js';
import { MockWorkerAdapter, type WorkerAdapter } from './adapter.js';

export interface WorkerEntry {
  readonly config: ResolvedConfig['workers'][number];
  readonly adapter: WorkerAdapter;
  readonly state: WorkerState;
}
interface ProbeState {
  failures: number;
  successes: number;
  observed: boolean;
  latencySamples: number;
  ttftSamples: number;
  outcomes: Array<{ at: number; failed: boolean }>;
  timer?: NodeJS.Timeout;
  controller?: AbortController;
  pending?: Promise<void>;
}
export interface WorkerOutcome {
  failed?: boolean;
  cancelled?: boolean;
  latencyMs: number;
  ttftMs?: number;
}

/** Owns worker resources and observations; routing algorithms consume eligible entries later. */
export class WorkerRegistry {
  readonly entries = new Map<string, WorkerEntry>();
  private readonly probes = new Map<string, ProbeState>();
  private stopped = false;
  private started = false;
  private closing?: Promise<void>;

  constructor(
    private readonly config: ResolvedConfig,
    factory: (worker: ResolvedConfig['workers'][number]) => WorkerAdapter = (
      worker,
    ) => {
      if (worker.backend !== 'mock')
        throw new Error('Only the mock backend is implemented');
      return new MockWorkerAdapter(worker, config.resilience);
    },
    private readonly random = Math.random,
  ) {
    for (const worker of config.workers) {
      this.entries.set(worker.id, {
        config: structuredClone(worker),
        adapter: factory(worker),
        state: {
          id: worker.id,
          health: 'unhealthy',
          breaker: 'closed',
          inFlight: 0,
          ewmaLatencyMs: 0,
          ewmaTtftMs: 0,
          recentErrorRate: 0,
          sampleCount: 0,
          loadedModels: new Set(),
          lastProbeAt: 0,
        },
      });
      this.probes.set(worker.id, {
        failures: 0,
        successes: 0,
        observed: false,
        latencySamples: 0,
        ttftSamples: 0,
        outcomes: [],
      });
    }
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    await Promise.all([...this.entries.keys()].map((id) => this.probe(id)));
  }

  private refresh(entry: WorkerEntry, probe: ProbeState) {
    const now = Date.now();
    probe.outcomes = probe.outcomes
      .filter((outcome) => now - outcome.at < 60000)
      .slice(-50);
    entry.state.recentErrorRate = probe.outcomes.length
      ? probe.outcomes.filter((outcome) => outcome.failed).length /
        probe.outcomes.length
      : 0;
  }

  eligible(model?: string) {
    if (this.stopped) return [];
    return [...this.entries.values()].filter((entry) => {
      this.refresh(entry, this.probes.get(entry.config.id)!);
      const state = entry.state;
      return (
        (state.health === 'healthy' || state.health === 'degraded') &&
        (model
          ? Object.hasOwn(entry.config.models, model) &&
            state.loadedModels.has(entry.config.models[model])
          : Object.values(entry.config.models).some((name) =>
              state.loadedModels.has(name),
            ))
      );
    });
  }

  get ready() {
    return this.eligible().length > 0;
  }

  probe(id: string): Promise<void> {
    const entry = this.entries.get(id)!;
    const probe = this.probes.get(id)!;
    if (this.stopped || entry.state.health === 'draining')
      return Promise.resolve();
    if (probe.pending) return probe.pending;
    clearTimeout(probe.timer);
    probe.pending = this.runProbe(entry, probe).finally(() => {
      probe.pending = undefined;
      if (!this.stopped && entry.state.health !== 'draining') {
        probe.timer = setTimeout(
          () => {
            void this.probe(id);
          },
          Math.max(
            1,
            this.config.health.probeIntervalMs * (0.9 + this.random() * 0.2),
          ),
        );
        probe.timer.unref();
      }
    });
    return probe.pending;
  }

  private async runProbe(entry: WorkerEntry, probe: ProbeState) {
    const controller = new AbortController();
    probe.controller = controller;
    const timer = setTimeout(
      () => controller.abort(new Error('Worker probe timed out')),
      this.config.health.probeTimeoutMs,
    );
    timer.unref();
    try {
      const [health, models] = await Promise.all([
        entry.adapter.health(controller.signal),
        entry.adapter.listModels(controller.signal),
      ]);
      controller.signal.throwIfAborted();
      if (!health.ok) throw new Error('Worker health probe failed');
      // Metrics are optional; absent or malformed metrics never invalidate a healthy model probe.
      let queueDepth: number | undefined;
      try {
        queueDepth = (await entry.adapter.metrics?.(controller.signal))
          ?.queueDepth;
      } catch {
        /* Optional endpoint. */
      }
      if (this.stopped || entry.state.health === 'draining') return;
      entry.state.loadedModels = new Set(models);
      entry.state.queueDepth = queueDepth;
      this.refresh(entry, probe);
      probe.failures = 0;
      probe.successes++;
      const slow = health.latencyMs > this.config.health.degradedLatencyMs;
      const errors =
        entry.state.recentErrorRate > this.config.health.degradedErrorRate;
      if (
        !probe.observed ||
        entry.state.health !== 'unhealthy' ||
        probe.successes >= this.config.health.recoverAfterSuccesses
      )
        entry.state.health =
          slow || errors || entry.state.health === 'unhealthy'
            ? 'degraded'
            : 'healthy';
      probe.observed = true;
    } catch {
      controller.abort();
      if (this.stopped || entry.state.health === 'draining') return;
      probe.observed = true;
      probe.successes = 0;
      probe.failures++;
      if (
        probe.failures >= this.config.health.unhealthyAfterFailures ||
        entry.state.health === 'unhealthy'
      ) {
        entry.state.health = 'unhealthy';
        entry.state.loadedModels.clear();
      } else entry.state.health = 'degraded';
      entry.state.queueDepth = undefined;
    } finally {
      clearTimeout(timer);
      // Cancels sibling requests if one branch failed before the others finished.
      controller.abort();
      probe.controller = undefined;
      entry.state.lastProbeAt = Date.now();
    }
  }

  reserve(entry: WorkerEntry) {
    const state = entry.state;
    const probe = this.probes.get(entry.config.id)!;
    state.inFlight++;
    let released = false;
    return (outcome: WorkerOutcome) => {
      if (released) return;
      released = true;
      state.inFlight--;
      if (outcome.cancelled) return;
      probe.outcomes.push({ at: Date.now(), failed: outcome.failed === true });
      this.refresh(entry, probe);
      state.sampleCount++;
      const alpha = this.config.health.ewmaAlpha;
      state.ewmaLatencyMs = probe.latencySamples++
        ? alpha * outcome.latencyMs + (1 - alpha) * state.ewmaLatencyMs
        : outcome.latencyMs;
      if (outcome.ttftMs !== undefined)
        state.ewmaTtftMs = probe.ttftSamples++
          ? alpha * outcome.ttftMs + (1 - alpha) * state.ewmaTtftMs
          : outcome.ttftMs;
      if (
        state.health === 'healthy' &&
        state.recentErrorRate > this.config.health.degradedErrorRate
      )
        state.health = 'degraded';
    };
  }

  drain(id: string) {
    const entry = this.entries.get(id)!;
    const probe = this.probes.get(id)!;
    entry.state.health = 'draining';
    clearTimeout(probe.timer);
    probe.controller?.abort();
  }

  stop() {
    this.stopped = true;
    for (const id of this.entries.keys()) this.drain(id);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stop();
      this.closing = (async () => {
        await Promise.all(
          [...this.probes.values()].map((probe) => probe.pending),
        );
        await Promise.all(
          [...this.entries.values()].map((entry) => entry.adapter.close()),
        );
      })();
    }
    return this.closing;
  }
}
