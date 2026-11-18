import type {
  RouteContext,
  RoutingStrategy,
  WorkerState,
} from '@gateway/shared';
import { GatewayError } from './errors.js';
import type { WorkerEntry, WorkerRegistry } from './registry.js';

export type BaselineStrategy =
  | 'round_robin'
  | 'least_in_flight'
  | 'power_of_two';
export function baselineStrategy(name: string): BaselineStrategy {
  if (
    name === 'round_robin' ||
    name === 'least_in_flight' ||
    name === 'power_of_two'
  )
    return name;
  throw new GatewayError(
    400,
    'invalid_request',
    'Adaptive routing is not implemented; select a baseline strategy',
  );
}

export class RoundRobin implements RoutingStrategy {
  readonly name = 'round_robin';
  private readonly cursors = new Map<string, number>();
  pick(candidates: WorkerState[], ctx: RouteContext) {
    if (!candidates.length) return;
    const cursor = this.cursors.get(ctx.model) ?? 0;
    this.cursors.set(ctx.model, (cursor + 1) % Number.MAX_SAFE_INTEGER);
    return candidates[cursor % candidates.length];
  }
}
export class LeastInFlight implements RoutingStrategy {
  readonly name = 'least_in_flight';
  constructor(private readonly random = Math.random) {}
  pick(candidates: WorkerState[]) {
    if (!candidates.length) return;
    const min = Math.min(...candidates.map((worker) => worker.inFlight));
    const ties = candidates.filter((worker) => worker.inFlight === min);
    return ties[Math.floor(this.random() * ties.length)];
  }
}
export class PowerOfTwo implements RoutingStrategy {
  readonly name = 'power_of_two';
  constructor(private readonly random = Math.random) {}
  pick(candidates: WorkerState[]) {
    if (candidates.length < 2) return candidates[0];
    const first = Math.floor(this.random() * candidates.length);
    const offset = Math.floor(this.random() * (candidates.length - 1));
    const second = offset >= first ? offset + 1 : offset;
    const a = candidates[first],
      b = candidates[second];
    if (a.inFlight === b.inFlight) return this.random() < 0.5 ? a : b;
    return a.inFlight < b.inFlight ? a : b;
  }
}

export interface BreakerAdmission {
  /** Pure eligibility check. Half-open workers require an explicit trial policy. */
  canAdmit(entry: WorkerEntry): boolean;
  /** Synchronous trial reservation, called only for the selected worker. */
  admit(entry: WorkerEntry): boolean;
}

export class WorkerRouter {
  private readonly strategies: Record<BaselineStrategy, RoutingStrategy>;
  constructor(
    private readonly registry: WorkerRegistry,
    random = Math.random,
    private readonly breaker: BreakerAdmission = {
      canAdmit: (entry) => entry.state.breaker === 'closed',
      admit: (entry) => entry.state.breaker === 'closed',
    },
  ) {
    this.strategies = {
      round_robin: new RoundRobin(),
      least_in_flight: new LeastInFlight(random),
      power_of_two: new PowerOfTwo(random),
    };
  }

  candidates(ctx: RouteContext) {
    return this.registry
      .eligible(ctx.model)
      .filter(
        (entry) =>
          !ctx.triedWorkerIds.has(entry.config.id) &&
          entry.state.breaker !== 'open' &&
          this.breaker.canAdmit(entry),
      );
  }

  /** No await between eligibility, breaker admission and capacity reservation. */
  select(ctx: RouteContext, name: BaselineStrategy) {
    ctx.request.signal.throwIfAborted();
    const eligible = this.candidates(ctx);
    let available = eligible.filter(
      (entry) => entry.state.inFlight < entry.config.maxConcurrency,
    );
    while (available.length) {
      const state = this.strategies[name].pick(
        available.map((entry) => entry.state),
        ctx,
      )!;
      const entry = available.find((entry) => entry.state === state)!;
      if (this.breaker.admit(entry))
        return { entry, release: this.registry.reserve(entry), strategy: name };
      available = available.filter((candidate) => candidate !== entry);
    }
    const saturated = eligible.some(
      (entry) => entry.state.inFlight >= entry.config.maxConcurrency,
    );
    throw new GatewayError(
      503,
      saturated ? 'gateway_overloaded' : 'no_healthy_worker',
      saturated
        ? 'All eligible workers are at capacity'
        : 'No eligible worker serves this model',
      'server_error',
    );
  }
}
