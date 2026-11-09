import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GatewayError } from './errors.js';

export function requestId(inbound: string | string[] | undefined): string {
  if (
    typeof inbound === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(inbound)
  )
    return inbound;
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FinalizedRequest {
  requestId: string;
  outcome: 'completed' | 'rejected' | 'cancelled' | 'timeout';
  statusCode: number;
  errorCode?: string;
  durationMs: number;
}

export class RequestLifecycle {
  readonly startedAt = Date.now();
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  deadlineAt: number;
  errorCode?: string;
  private done = false;
  private timer?: NodeJS.Timeout;
  private readonly onFinish = () =>
    this.finalize(this.reply.statusCode >= 400 ? 'rejected' : 'completed');
  private readonly onDisconnect = () => {
    if (!this.reply.raw.writableFinished) this.cancel('cancelled');
  };

  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
    timeoutMs: number,
    private readonly onFinalize?: (result: FinalizedRequest) => void,
  ) {
    this.deadlineAt = this.startedAt + timeoutMs;
    request.raw.once('aborted', this.onDisconnect);
    reply.raw.once('close', this.onDisconnect);
    reply.raw.once('finish', this.onFinish);
    this.scheduleDeadline();
  }

  shortenDeadline(timeoutMs?: number) {
    if (timeoutMs !== undefined)
      this.deadlineAt = Math.min(this.deadlineAt, this.startedAt + timeoutMs);
    this.scheduleDeadline();
  }

  private scheduleDeadline() {
    clearTimeout(this.timer);
    if (this.done) return;
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.cancel('timeout');
      return;
    }
    this.timer = setTimeout(
      () => this.scheduleDeadline(),
      Math.min(remaining, 2147483647),
    );
    this.timer.unref();
  }

  private cancel(outcome: 'cancelled' | 'timeout') {
    if (this.done) return;
    const error = new GatewayError(
      outcome === 'timeout' ? 504 : 499,
      outcome === 'timeout' ? 'upstream_timeout' : 'client_cancelled',
      outcome === 'timeout'
        ? 'Request deadline exceeded'
        : 'Client disconnected',
      'server_error',
    );
    this.errorCode = error.code;
    this.controller.abort(error);
    this.finalize(outcome);
    if (outcome === 'timeout') {
      if (!this.reply.raw.headersSent) this.reply.send(error);
      else this.reply.raw.destroy();
    }
  }

  finalize(outcome: FinalizedRequest['outcome']) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.request.raw.off('aborted', this.onDisconnect);
    this.reply.raw.off('close', this.onDisconnect);
    this.reply.raw.off('finish', this.onFinish);
    const result: FinalizedRequest = {
      requestId: this.request.id,
      outcome,
      statusCode:
        outcome === 'cancelled'
          ? 499
          : outcome === 'timeout'
            ? 504
            : this.reply.statusCode,
      errorCode: this.errorCode,
      durationMs: Date.now() - this.startedAt,
    };
    this.request.log.info(result, 'request finalized');
    this.onFinalize?.(result);
  }
}
