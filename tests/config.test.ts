import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('returns the defaults for empty input', () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('applies overrides and keeps the other defaults', () => {
    const cfg = parseConfig({ timeoutMs: 250, maxAttempts: 2, jitter: 'none' });
    expect(cfg.timeoutMs).toBe(250);
    expect(cfg.maxAttempts).toBe(2);
    expect(cfg.jitter).toBe('none');
    expect(cfg.backoffCapMs).toBe(DEFAULT_CONFIG.backoffCapMs);
  });

  it('accepts retryBudget null to disable the budget', () => {
    expect(parseConfig({ retryBudget: null }).retryBudget).toBeNull();
  });

  it('merges a partial retry budget with the default budget values', () => {
    const cfg = parseConfig({ retryBudget: { capacity: 3 } });
    expect(cfg.retryBudget).toEqual({
      capacity: 3,
      refillPerSecond: DEFAULT_CONFIG.retryBudget!.refillPerSecond,
      costPerRetry: DEFAULT_CONFIG.retryBudget!.costPerRetry,
    });
  });

  it('rejects non-object config', () => {
    expect(() => parseConfig('nope')).toThrow(ConfigError);
    expect(() => parseConfig([1, 2])).toThrow(ConfigError);
  });

  it('collects every problem at once instead of failing on the first', () => {
    try {
      parseConfig({ timeoutMs: -5, maxAttempts: 0, jitter: 'some', backoffCapMs: 0 });
      expect.unreachable('parseConfig should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems).toHaveLength(4);
      expect(problems.join(' ')).toContain('timeoutMs');
      expect(problems.join(' ')).toContain('maxAttempts');
      expect(problems.join(' ')).toContain('jitter');
      expect(problems.join(' ')).toContain('backoffCapMs');
    }
  });

  it('rejects a fractional maxAttempts', () => {
    expect(() => parseConfig({ maxAttempts: 2.5 })).toThrow(/maxAttempts/);
  });

  it('rejects invalid retry budget fields', () => {
    expect(() => parseConfig({ retryBudget: { capacity: -1 } })).toThrow(/capacity/);
    expect(() => parseConfig({ retryBudget: { costPerRetry: 0 } })).toThrow(/costPerRetry/);
    expect(() => parseConfig({ retryBudget: 'lots' })).toThrow(/retryBudget/);
  });

  it('rejects invalid status lists and header names', () => {
    expect(() => parseConfig({ retryableStatuses: [99] })).toThrow(/retryableStatuses/);
    expect(() => parseConfig({ retryableStatuses: '503' })).toThrow(/retryableStatuses/);
    expect(() => parseConfig({ idempotencyKeyHeader: '' })).toThrow(/idempotencyKeyHeader/);
  });

  it('does not mutate the defaults when a caller overrides nested values', () => {
    parseConfig({ retryBudget: { capacity: 1 } });
    expect(DEFAULT_CONFIG.retryBudget!.capacity).toBe(10);
  });
});
