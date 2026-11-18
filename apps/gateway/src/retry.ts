import { setTimeout as sleep } from 'node:timers/promises';

export function retryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | undefined {
  if (typeof value !== 'string') return;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000
    : undefined;
  const ms = seconds ?? Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
export function backoff(
  attempt: number,
  random = Math.random,
  retryAfterMs = 0,
) {
  return Math.max(
    retryAfterMs,
    random() * Math.min(500, 50 * 2 ** Math.min(attempt - 1, 4)),
  );
}
export async function waitForRetry(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (ms > 0) await sleep(ms, undefined, { signal });
  signal.throwIfAborted();
}

/** Shared rolling budget: one retry per window is allowed at low traffic by default. */
export class RetryBudget {
  private requests: number[] = [];
  private retries: number[] = [];
  constructor(
    private readonly config: {
      ratio: number;
      windowMs: number;
      minRetries: number;
    },
    private readonly now = Date.now,
  ) {}
  private prune() {
    const cutoff = this.now() - this.config.windowMs;
    this.requests = this.requests.filter((at) => at > cutoff);
    this.retries = this.retries.filter((at) => at > cutoff);
  }
  recordRequest() {
    this.prune();
    this.requests.push(this.now());
  }
  allowed() {
    this.prune();
    return (
      this.retries.length <
      Math.max(
        this.config.minRetries,
        Math.floor(this.requests.length * this.config.ratio),
      )
    );
  }
  take() {
    if (!this.allowed()) return false;
    this.retries.push(this.now());
    return true;
  }
}
