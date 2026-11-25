import { computeBackoff } from './backoff.js';
import { TokenBucket } from './budget.js';
import { parseConfig, type RetryConfig } from './config.js';
import { TimeoutError } from './errors.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RetryEvent {
  /** The attempt that just failed (0-based). */
  attempt: number;
  /** Why the client is retrying: an HTTP status, a network error, or a timeout. */
  reason: string;
  /** How long it will sleep before the next attempt. */
  delayMs: number;
  /** Budget balance after paying for this retry, or null when no budget is configured. */
  budgetBalance: number | null;
}

export interface RetryClientDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter, returning values in [0, 1). */
  rng?: () => number;
  now?: () => number;
  /** Called once per scheduled retry, before the backoff sleep. */
  onRetry?: (event: RetryEvent) => void;
}

export interface RetryRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Sent under the configured idempotency header on every attempt of this
   * call, with the same value each time, so a server that honors the key can
   * safely deduplicate the retries.
   */
  idempotencyKey?: string;
}

export function isRetryableStatus(status: number, retryableStatuses: number[]): boolean {
  return retryableStatuses.includes(status);
}

/** Parse a Retry-After header value (delay seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

/**
 * An HTTP client that implements the Builders' Library rules:
 * a timeout on every attempt, capped exponential backoff with full jitter,
 * retries only for failures that can plausibly heal, an optional
 * idempotency key that stays stable across the retries of one call, and a
 * token-bucket budget that makes the client fail fast once retries stop
 * being worth their load.
 */
export class RetryClient {
  readonly config: RetryConfig;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly bucket: TokenBucket | null;

  constructor(config?: unknown, deps: RetryClientDeps = {}) {
    this.config = parseConfig(config);
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.onRetry = deps.onRetry;
    this.bucket =
      this.config.retryBudget === null
        ? null
        : new TokenBucket(
            this.config.retryBudget.capacity,
            this.config.retryBudget.refillPerSecond,
            this.now,
          );
  }

  /** Current retry budget balance, or null when no budget is configured. */
  budgetBalance(): number | null {
    return this.bucket === null ? null : this.bucket.balance();
  }

  async request(url: string, options: RetryRequestOptions = {}): Promise<Response> {
    const { maxAttempts } = this.config;
    let lastResponse: Response | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      lastResponse = undefined;
      lastError = undefined;
      try {
        lastResponse = await this.attemptOnce(url, options);
      } catch (err) {
        lastError = err as Error;
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) break;

      const reason = this.retryReason(lastResponse, lastError);
      if (reason === null) break;

      // The budget is the fail-fast rule: if it cannot pay for this retry,
      // stop here and hand back the last outcome instead of adding load.
      if (this.bucket !== null && !this.bucket.tryConsume(this.config.retryBudget!.costPerRetry)) {
        break;
      }

      let delayMs = computeBackoff(
        attempt,
        this.config.backoffBaseMs,
        this.config.backoffCapMs,
        this.config.jitter,
        this.rng,
      );
      if (lastResponse !== undefined) {
        const retryAfterMs = parseRetryAfterMs(lastResponse.headers.get('retry-after'), this.now());
        if (retryAfterMs !== null && retryAfterMs > delayMs) delayMs = retryAfterMs;
      }

      this.onRetry?.({
        attempt,
        reason,
        delayMs,
        budgetBalance: this.bucket === null ? null : this.bucket.balance(),
      });
      await this.sleep(delayMs);
    }

    if (lastResponse !== undefined) return lastResponse;
    throw lastError ?? new Error('request failed without a response or an error');
  }

  /** Why the last outcome deserves a retry, or null when it should be returned as final. */
  private retryReason(response: Response | undefined, error: Error | undefined): string | null {
    if (error !== undefined) {
      return error instanceof TimeoutError ? 'timeout' : 'network error';
    }
    if (response !== undefined && isRetryableStatus(response.status, this.config.retryableStatuses)) {
      return `status ${response.status}`;
    }
    return null;
  }

  private async attemptOnce(url: string, options: RetryRequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.idempotencyKey !== undefined) {
      headers[this.config.idempotencyKeyHeader] = options.idempotencyKey;
    }
    try {
      return await this.fetchFn(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new TimeoutError(this.config.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
