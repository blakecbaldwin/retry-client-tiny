import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/budget.js';

function makeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('starts full', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(10, 1, clock.now);
    expect(bucket.balance()).toBe(10);
  });

  it('spends tokens on consume and refuses when it cannot pay', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(2, 0, clock.now);
    expect(bucket.tryConsume(1)).toBe(true);
    expect(bucket.tryConsume(1)).toBe(true);
    expect(bucket.tryConsume(1)).toBe(false);
    expect(bucket.balance()).toBe(0);
  });

  it('spends nothing on a refused consume', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(3, 0, clock.now);
    expect(bucket.tryConsume(2)).toBe(true);
    expect(bucket.tryConsume(2)).toBe(false);
    expect(bucket.balance()).toBe(1);
  });

  it('refills over time at the configured rate', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(10, 2, clock.now);
    expect(bucket.tryConsume(10)).toBe(true);
    expect(bucket.balance()).toBe(0);
    clock.advance(1000);
    expect(bucket.balance()).toBe(2);
    clock.advance(500);
    expect(bucket.balance()).toBe(3);
  });

  it('never refills past capacity', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(5, 100, clock.now);
    clock.advance(60_000);
    expect(bucket.balance()).toBe(5);
  });

  it('supports fractional refill and fractional costs', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(1, 0.5, clock.now);
    expect(bucket.tryConsume(1)).toBe(true);
    clock.advance(1000);
    expect(bucket.balance()).toBeCloseTo(0.5);
    expect(bucket.tryConsume(0.5)).toBe(true);
    expect(bucket.balance()).toBeCloseTo(0);
  });

  it('a zero refill rate means an empty bucket stays empty', () => {
    const clock = makeClock();
    const bucket = new TokenBucket(1, 0, clock.now);
    expect(bucket.tryConsume(1)).toBe(true);
    clock.advance(3_600_000);
    expect(bucket.tryConsume(1)).toBe(false);
  });
});
