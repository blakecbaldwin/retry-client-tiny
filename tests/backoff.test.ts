import { describe, expect, it } from 'vitest';
import { backoffCeiling, computeBackoff } from '../src/backoff.js';

describe('backoffCeiling', () => {
  it('doubles with each attempt', () => {
    expect(backoffCeiling(0, 100, 10_000)).toBe(100);
    expect(backoffCeiling(1, 100, 10_000)).toBe(200);
    expect(backoffCeiling(2, 100, 10_000)).toBe(400);
    expect(backoffCeiling(3, 100, 10_000)).toBe(800);
  });

  it('never exceeds the cap, even for huge attempt counts', () => {
    expect(backoffCeiling(5, 100, 2000)).toBe(2000);
    expect(backoffCeiling(30, 100, 2000)).toBe(2000);
    expect(backoffCeiling(1000, 100, 2000)).toBe(2000);
  });

  it('is the base itself when the base is above the cap', () => {
    expect(backoffCeiling(0, 5000, 2000)).toBe(2000);
  });
});

describe('computeBackoff with full jitter', () => {
  it('returns 0 when the rng returns 0', () => {
    expect(computeBackoff(3, 100, 2000, 'full', () => 0)).toBe(0);
  });

  it('approaches but never reaches the ceiling as the rng approaches 1', () => {
    const delay = computeBackoff(2, 100, 2000, 'full', () => 0.999999);
    expect(delay).toBeLessThan(400);
    expect(delay).toBeGreaterThan(399);
  });

  it('scales linearly with the rng value', () => {
    expect(computeBackoff(1, 100, 2000, 'full', () => 0.5)).toBe(100);
    expect(computeBackoff(1, 100, 2000, 'full', () => 0.25)).toBe(50);
  });

  it('stays within [0, cap] for random inputs across many attempts', () => {
    for (let i = 0; i < 500; i++) {
      const attempt = Math.floor(Math.random() * 12);
      const delay = computeBackoff(attempt, 100, 2000, 'full', Math.random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(backoffCeiling(attempt, 100, 2000));
    }
  });
});

describe('computeBackoff with jitter none', () => {
  it('returns the whole ceiling and ignores the rng', () => {
    expect(computeBackoff(0, 100, 2000, 'none', () => 0)).toBe(100);
    expect(computeBackoff(2, 100, 2000, 'none', () => 0.5)).toBe(400);
    expect(computeBackoff(9, 100, 2000, 'none', Math.random)).toBe(2000);
  });
});
