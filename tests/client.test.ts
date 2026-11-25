import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, RetryClient, type FetchFn, type RetryEvent } from '../src/client.js';
import { TimeoutError } from '../src/errors.js';

type Outcome = Response | Error | 'hang';

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** A fetch fake that plays back scripted outcomes, repeating the last one when the script runs out. */
function scriptedFetch(outcomes: Outcome[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if (outcome === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')));
      });
    }
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  };
  return { fetchFn, calls };
}

function makeClient(outcomes: Outcome[], config: unknown = {}, deps: { now?: () => number } = {}) {
  const { fetchFn, calls } = scriptedFetch(outcomes);
  const delays: number[] = [];
  const events: RetryEvent[] = [];
  const client = new RetryClient(config, {
    fetchFn,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    rng: () => 0.5,
    now: deps.now,
    onRetry: (event) => events.push(event),
  });
  return { client, calls, delays, events };
}

const NO_BUDGET = { retryBudget: null };

describe('basic behavior', () => {
  it('returns a first-try success with exactly one fetch', async () => {
    const { client, calls, events } = makeClient([resp(200)]);
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('passes method, headers, and body through on every attempt', async () => {
    const { client, calls } = makeClient([resp(503), resp(200)], NO_BUDGET);
    await client.request('http://x.test/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"amount":10}',
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.method).toBe('POST');
      expect(call.init.body).toBe('{"amount":10}');
      expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    }
  });
});

describe('status classification', () => {
  it('retries a 503 and returns the eventual success', async () => {
    const { client, calls, events } = makeClient([resp(503), resp(200)]);
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('status 503');
  });

  it('retries 429 and the other default retryable statuses', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const { client, calls } = makeClient([resp(status), resp(200)]);
      const res = await client.request('http://x.test/a');
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
    }
  });

  it('does not retry a 400', async () => {
    const { client, calls, events } = makeClient([resp(400), resp(200)]);
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('does not retry a 404', async () => {
    const { client, calls } = makeClient([resp(404), resp(200)]);
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('honors a custom retryable status list', async () => {
    const { client, calls } = makeClient([resp(503), resp(200)], {
      ...NO_BUDGET,
      retryableStatuses: [500],
    });
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('returns the last response when attempts run out', async () => {
    const { client, calls } = makeClient([resp(503)], { ...NO_BUDGET, maxAttempts: 3 });
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(3);
  });
});

describe('network errors and timeouts', () => {
  it('retries a network error and then succeeds', async () => {
    const { client, calls, events } = makeClient([new TypeError('fetch failed'), resp(200)]);
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(events[0]!.reason).toBe('network error');
  });

  it('throws the last network error when attempts run out', async () => {
    const boom = new TypeError('fetch failed');
    const { client, calls } = makeClient([boom], { ...NO_BUDGET, maxAttempts: 3 });
    await expect(client.request('http://x.test/a')).rejects.toBe(boom);
    expect(calls).toHaveLength(3);
  });

  it('times out a hanging attempt, retries, and succeeds', async () => {
    const { client, calls, events } = makeClient(['hang', resp(200)], {
      ...NO_BUDGET,
      timeoutMs: 20,
    });
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(events[0]!.reason).toBe('timeout');
  });

  it('throws TimeoutError when every attempt hangs', async () => {
    const { client, calls } = makeClient(['hang'], { ...NO_BUDGET, timeoutMs: 20, maxAttempts: 2 });
    await expect(client.request('http://x.test/a')).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(2);
  });
});

describe('retry budget', () => {
  it('fails fast when the budget is empty instead of using all attempts', async () => {
    const { client, calls, events } = makeClient([resp(503)], {
      maxAttempts: 10,
      retryBudget: { capacity: 2, refillPerSecond: 0, costPerRetry: 1 },
    });
    const res = await client.request('http://x.test/a');
    expect(res.status).toBe(503);
    // First attempt plus the two retries the budget could pay for. Not 10.
    expect(calls).toHaveLength(3);
    expect(events).toHaveLength(2);
    expect(client.budgetBalance()).toBe(0);
  });

  it('a budget of zero allows the first attempt and no retries', async () => {
    const { client, calls } = makeClient([resp(503)], {
      maxAttempts: 5,
      retryBudget: { capacity: 0, refillPerSecond: 0, costPerRetry: 1 },
    });
    await client.request('http://x.test/a');
    expect(calls).toHaveLength(1);
  });

  it('refilled budget lets a later call retry again', async () => {
    let nowMs = 0;
    const { client, calls } = makeClient(
      [resp(503)],
      { maxAttempts: 5, retryBudget: { capacity: 1, refillPerSecond: 1, costPerRetry: 1 } },
      { now: () => nowMs },
    );
    await client.request('http://x.test/a');
    expect(calls).toHaveLength(2);
    await client.request('http://x.test/a');
    expect(calls).toHaveLength(3);
    nowMs += 2000;
    await client.request('http://x.test/a');
    expect(calls).toHaveLength(5);
  });

  it('with no budget configured, retries run to maxAttempts and balance is null', async () => {
    const { client, calls } = makeClient([resp(503)], { ...NO_BUDGET, maxAttempts: 4 });
    await client.request('http://x.test/a');
    expect(calls).toHaveLength(4);
    expect(client.budgetBalance()).toBeNull();
  });
});

describe('backoff timing', () => {
  it('with jitter none, delays follow the capped ceiling exactly', async () => {
    const { client, delays } = makeClient([resp(503)], {
      ...NO_BUDGET,
      maxAttempts: 5,
      jitter: 'none',
      backoffBaseMs: 100,
      backoffCapMs: 250,
    });
    await client.request('http://x.test/a');
    expect(delays).toEqual([100, 200, 250, 250]);
  });

  it('with full jitter and a fixed rng, delays scale with the rng', async () => {
    const { client, delays } = makeClient([resp(503)], {
      ...NO_BUDGET,
      maxAttempts: 3,
      jitter: 'full',
      backoffBaseMs: 100,
      backoffCapMs: 2000,
    });
    await client.request('http://x.test/a');
    // rng is fixed at 0.5 in makeClient: half of ceilings 100 and 200.
    expect(delays).toEqual([50, 100]);
  });

  it('a Retry-After header raises the delay when it is larger than the backoff', async () => {
    const { client, delays } = makeClient([resp(503, { 'Retry-After': '2' }), resp(200)], {
      ...NO_BUDGET,
      jitter: 'none',
      backoffBaseMs: 100,
    });
    await client.request('http://x.test/a');
    expect(delays).toEqual([2000]);
  });
});

describe('idempotency keys', () => {
  it('sends the same key on every attempt of a call', async () => {
    const { client, calls } = makeClient([resp(503), resp(503), resp(200)], NO_BUDGET);
    await client.request('http://x.test/pay', { method: 'POST', idempotencyKey: 'order-123' });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['Idempotency-Key']).toBe('order-123');
    }
  });

  it('sends no key header when the call does not supply one', async () => {
    const { client, calls } = makeClient([resp(503), resp(200)], NO_BUDGET);
    await client.request('http://x.test/a');
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    }
  });

  it('uses the configured header name', async () => {
    const { client, calls } = makeClient([resp(200)], {
      ...NO_BUDGET,
      idempotencyKeyHeader: 'X-Idempotency-Key',
    });
    await client.request('http://x.test/pay', { method: 'POST', idempotencyKey: 'k-1' });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('k-1');
  });

  it('different calls keep their own keys', async () => {
    const { client, calls } = makeClient([resp(200)], NO_BUDGET);
    await client.request('http://x.test/pay', { method: 'POST', idempotencyKey: 'first' });
    await client.request('http://x.test/pay', { method: 'POST', idempotencyKey: 'second' });
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('first');
    expect((calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('second');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delay seconds', () => {
    expect(parseRetryAfterMs('3', 0)).toBe(3000);
    expect(parseRetryAfterMs('0', 0)).toBe(0);
  });

  it('parses an HTTP date relative to now', () => {
    const nowMs = Date.parse('Wed, 25 Nov 2026 12:00:00 GMT');
    expect(parseRetryAfterMs('Wed, 25 Nov 2026 12:00:05 GMT', nowMs)).toBe(5000);
    expect(parseRetryAfterMs('Wed, 25 Nov 2026 11:59:55 GMT', nowMs)).toBe(0);
  });

  it('returns null for missing or garbage values', () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs('soon', 0)).toBeNull();
  });
});
