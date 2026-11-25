/**
 * A token bucket that prices retries. Successful first attempts are free;
 * every retry costs tokens, and tokens refill at a fixed rate. When the
 * bucket cannot pay, the caller must fail fast instead of retrying. That is
 * the mechanical version of the article's rule: a client should stop adding
 * retries once the retries stop helping, because a fleet of clients all
 * retrying at once multiplies load on a dependency that is already down.
 *
 * The clock is injectable so tests can move time without sleeping.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = (current - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = current;
  }

  /** Current token balance, after applying any refill that is due. */
  balance(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Take `cost` tokens if the bucket can pay. Returns true when the tokens
   * were spent, false when the bucket is too empty and nothing was spent.
   */
  tryConsume(cost: number): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
