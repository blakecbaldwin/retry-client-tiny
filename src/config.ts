export interface RetryBudgetConfig {
  /** Maximum tokens the bucket can hold. The bucket starts full. */
  capacity: number;
  /** Tokens added back per second. */
  refillPerSecond: number;
  /** Tokens one retry costs. */
  costPerRetry: number;
}

export interface RetryConfig {
  /** Per-attempt timeout in milliseconds. Every attempt gets its own fresh timeout. */
  timeoutMs: number;
  /** Total attempts including the first try. 1 means no retries at all. */
  maxAttempts: number;
  /** Base delay in milliseconds for the backoff formula: base * 2^attempt. */
  backoffBaseMs: number;
  /** Hard ceiling in milliseconds. No computed backoff delay ever exceeds this. */
  backoffCapMs: number;
  /** "full" applies the article's full jitter; "none" sleeps for the whole ceiling. */
  jitter: 'full' | 'none';
  /**
   * Token-bucket retry budget, or null for no budget (retries limited only by
   * maxAttempts). When the bucket cannot pay for a retry, the client fails
   * fast with the last outcome instead of retrying.
   */
  retryBudget: RetryBudgetConfig | null;
  /** HTTP statuses treated as retryable. Network errors and timeouts are always retryable. */
  retryableStatuses: number[];
  /** Header used to send the idempotency key when a call supplies one. */
  idempotencyKeyHeader: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid retry config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_CONFIG: RetryConfig = {
  timeoutMs: 1000,
  maxAttempts: 4,
  backoffBaseMs: 100,
  backoffCapMs: 2000,
  jitter: 'full',
  retryBudget: { capacity: 10, refillPerSecond: 1, costPerRetry: 1 },
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  idempotencyKeyHeader: 'Idempotency-Key',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate raw config input into a RetryConfig, collecting every problem so
 * the caller can fix everything in one pass instead of one error at a time.
 * Unknown top-level fields are ignored; missing fields fall back to defaults.
 */
export function parseConfig(raw: unknown): RetryConfig {
  if (raw === undefined || raw === null) {
    return structuredClone(DEFAULT_CONFIG);
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(['config must be an object']);
  }

  const problems: string[] = [];
  const cfg: RetryConfig = structuredClone(DEFAULT_CONFIG);

  if (raw.timeoutMs !== undefined) {
    if (isPositiveNumber(raw.timeoutMs)) cfg.timeoutMs = raw.timeoutMs;
    else problems.push('timeoutMs must be a positive number');
  }

  if (raw.maxAttempts !== undefined) {
    if (typeof raw.maxAttempts === 'number' && Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1) {
      cfg.maxAttempts = raw.maxAttempts;
    } else {
      problems.push('maxAttempts must be an integer of at least 1');
    }
  }

  if (raw.backoffBaseMs !== undefined) {
    if (isNonNegativeNumber(raw.backoffBaseMs)) cfg.backoffBaseMs = raw.backoffBaseMs;
    else problems.push('backoffBaseMs must be a number of at least 0');
  }

  if (raw.backoffCapMs !== undefined) {
    if (isPositiveNumber(raw.backoffCapMs)) cfg.backoffCapMs = raw.backoffCapMs;
    else problems.push('backoffCapMs must be a positive number');
  }

  if (raw.jitter !== undefined) {
    if (raw.jitter === 'full' || raw.jitter === 'none') cfg.jitter = raw.jitter;
    else problems.push('jitter must be "full" or "none"');
  }

  if (raw.retryBudget !== undefined) {
    if (raw.retryBudget === null) {
      cfg.retryBudget = null;
    } else if (!isPlainObject(raw.retryBudget)) {
      problems.push('retryBudget must be an object or null');
    } else {
      const budget: RetryBudgetConfig = { ...DEFAULT_CONFIG.retryBudget! };
      const b = raw.retryBudget;
      if (b.capacity !== undefined) {
        if (isNonNegativeNumber(b.capacity)) budget.capacity = b.capacity;
        else problems.push('retryBudget.capacity must be a number of at least 0');
      }
      if (b.refillPerSecond !== undefined) {
        if (isNonNegativeNumber(b.refillPerSecond)) budget.refillPerSecond = b.refillPerSecond;
        else problems.push('retryBudget.refillPerSecond must be a number of at least 0');
      }
      if (b.costPerRetry !== undefined) {
        if (isPositiveNumber(b.costPerRetry)) budget.costPerRetry = b.costPerRetry;
        else problems.push('retryBudget.costPerRetry must be a positive number');
      }
      cfg.retryBudget = budget;
    }
  }

  if (raw.retryableStatuses !== undefined) {
    if (
      Array.isArray(raw.retryableStatuses) &&
      raw.retryableStatuses.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)
    ) {
      cfg.retryableStatuses = [...raw.retryableStatuses];
    } else {
      problems.push('retryableStatuses must be an array of HTTP status codes');
    }
  }

  if (raw.idempotencyKeyHeader !== undefined) {
    if (typeof raw.idempotencyKeyHeader === 'string' && raw.idempotencyKeyHeader.length > 0) {
      cfg.idempotencyKeyHeader = raw.idempotencyKeyHeader;
    } else {
      problems.push('idempotencyKeyHeader must be a non-empty string');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
