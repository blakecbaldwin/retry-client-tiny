# retry-client-tiny

A tiny HTTP client that retries the way Amazon's engineering rules say to retry: a timeout on every attempt, capped exponential backoff with full jitter, retries only for failures that can plausibly heal, and a token-bucket retry budget that makes the client fail fast once retries stop helping. It ships with a demo that shows the opposite default, the retry storm, and what each protection does to it.

## Why this exists

This project is a small-scale build of the client behavior described in the Amazon Builders' Library post ["Timeouts, retries, and backoff with jitter"](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) (Marc Brooker, December 5, 2019). The post is Amazon's house guide to calling other services without making their outages worse. Its core points:

- Every remote call gets a timeout. Without one, a slow dependency ties up the caller's threads and queues until the caller falls over too.
- Retries multiply load. One client retrying 3 times is fine; five layers of a stack each retrying 3 times is 243 attempts against a struggling database.
- Backoff must be capped and jittered. Uncapped exponential backoff eventually sleeps forever, and identical timers make a whole fleet retry in lockstep waves.
- Retries need a budget. The AWS SDKs carry a token bucket per client: retries cost tokens, tokens refill slowly, and when the bucket is empty the client stops retrying. That is the mechanical version of "stop retrying when retries stop helping."

This is project two in a small arc. Project one, [chaos-monkey-tiny](https://github.com/blakecbaldwin/chaos-monkey-tiny), breaks services on purpose, following the Netflix Simian Army post. Safe retries are the first defense a service needs to survive the monkey, so they come next.

## How the tiny version maps to the post

| Builders' Library rule | retry-client-tiny |
| --- | --- |
| Set a timeout on every call | `timeoutMs` applies per attempt; a hung attempt is aborted and counts as a retryable timeout |
| Use exponential backoff with a cap | Delay ceiling is `min(cap, base * 2^attempt)`; the cap is a hard bound, verified by tests |
| Add jitter to every timer | Full jitter by default: `sleep = random(0, ceiling)`. A `jitter: "none"` mode exists so the demo can show why it matters |
| Limit retries with a token bucket | `retryBudget` prices every retry; when the bucket cannot pay, the client returns the last outcome instead of retrying |
| Retry only what can heal | Network errors, timeouts, 429, and 5xx are retried; other 4xx answers come straight back |
| Make retried calls safe to repeat | Per-call `idempotencyKey` is sent under one header with the same value on every attempt |
| Respect the server's own pacing | A `Retry-After` header on a retryable response raises the delay when it asks for a longer wait |

What it deliberately leaves out: circuit breakers, hedged requests, and per-host budgets. One client, one bucket, the rules from the post.

## The four protections

**Timeouts.** Every attempt runs under an `AbortController` with `timeoutMs`. A dependency that hangs produces a `TimeoutError` in bounded time instead of a caller that waits forever, and the timeout is retryable because a hang is exactly the failure a retry can heal.

**Capped exponential backoff.** The wait before retry number `n` has a ceiling of `min(backoffCapMs, backoffBaseMs * 2^n)`. The ceiling can never exceed the cap, no matter how many attempts have happened. Tests pin this down at attempt 1000, not just attempt 3.

**Full jitter.** The actual sleep is a uniform random value between 0 and the ceiling. Clients that failed together do not wake together, so the retry load spreads out instead of arriving in synchronized waves. The demo chart shows both shapes.

**Retry budget.** A token bucket, shared by every call the client makes. First attempts are free; each retry costs `costPerRetry` tokens; the bucket refills at `refillPerSecond` up to `capacity`. When the bucket cannot pay, the client fails fast with the last response or error. This is the rule that cannot be argued with at runtime: it is not a comment saying "please do not retry too much," it is arithmetic that stops the retry.

## Quickstart

You need Node 20+. There are no runtime dependencies; the client uses the global `fetch`.

```sh
npm install
npm run build
npm test
```

### Use the client

```ts
import { RetryClient } from './dist/index.js';

const client = new RetryClient({
  timeoutMs: 800,
  maxAttempts: 4,
  backoffBaseMs: 100,
  backoffCapMs: 2000,
  jitter: 'full',
  retryBudget: { capacity: 10, refillPerSecond: 1, costPerRetry: 1 },
});

const res = await client.request('https://api.example.com/charge', {
  method: 'POST',
  body: JSON.stringify({ amount: 1000 }),
  idempotencyKey: 'order-1234',
});
```

Bad config fails fast with every problem listed at once, not one error per run.

### Run the demo

```sh
npm run demo
```

The demo starts a local server that answers 503 to everything for 2.5 seconds and then recovers, fires 12 simulated clients at it under four retry policies, and writes `results.json`, `results.md`, and a standalone `chart.html` (inline SVG, no chart library) to `demo/output/`.

## Demo results

Measured locally on 2026-11-25 with the demo in this repo: 12 clients, one logical call each, one shared client per policy, server down for the first 2.5 seconds. Exact counts move a little from run to run; the shape does not.

| Mode | Requests that hit the server | Amplification per logical call | Peak rate (req/s) | Calls that eventually succeeded | Calls that failed |
| --- | --- | --- | --- | --- | --- |
| Naive immediate retries | 10,851 | 904.3x | 5,992 | 12 | 0 |
| Backoff only | 72 | 6.0x | 96 | 12 | 0 |
| Backoff + jitter | 105 | 8.8x | 164 | 12 | 0 |
| Backoff + jitter + budget | 24 | 2.0x | 96 | 0 | 12 |

Three things worth reading out of that table:

- The naive policy turned 12 calls into 10,851 requests, sustained at thousands per second for the whole outage. Every one of those requests is load the clients inflicted on a server that had already said it was down. This is how a small blip becomes a full outage.
- Backoff alone fixes the volume but not the shape. With identical timers, the fleet retries in lockstep waves, visible as spikes in the chart. Jitter trades a slightly higher request count in this run for retries spread thin across time instead of stacked into waves.
- The budget is the only policy that bounds the total. It spent its tokens in the first moments of the outage, then every call failed fast. Those 12 failures are the trade: the caller gives up quickly during an outage so the dependency gets the quiet it needs to recover, and the layer above the client decides what a fast failure means for the user.

## Configuration

`RetryClient` takes one config object; every field is optional and validated.

| Field | Meaning |
| --- | --- |
| `timeoutMs` | Per-attempt timeout in milliseconds (default 1000) |
| `maxAttempts` | Total attempts including the first try (default 4) |
| `backoffBaseMs` | Base of the backoff formula, `base * 2^attempt` (default 100) |
| `backoffCapMs` | Hard ceiling on any computed backoff delay (default 2000) |
| `jitter` | `"full"` for the post's formula, `"none"` for deterministic ceilings (default `"full"`) |
| `retryBudget` | `{ capacity, refillPerSecond, costPerRetry }`, or `null` for no budget (default capacity 10, refill 1/s, cost 1) |
| `retryableStatuses` | HTTP statuses worth retrying (default 408, 429, 500, 502, 503, 504) |
| `idempotencyKeyHeader` | Header that carries the idempotency key (default `Idempotency-Key`) |

## Project layout

```
src/
  config.ts     config shape, defaults, and validation
  backoff.ts    capped exponential ceiling and the full-jitter formula
  budget.ts     the token bucket that prices retries
  client.ts     RetryClient: attempt loop, timeout wiring, classification
  errors.ts     TimeoutError
  index.ts      public exports
demo/
  flaky-server.mjs  node:http server that fails for a fixed window, then recovers
  run.mjs           four-policy comparison runner; writes results and the chart
  output/           generated results.json, results.md, chart.html
tests/          Vitest suite, runs against a scripted fake fetch
```

The client takes its `fetch`, `sleep`, `rng`, and clock as injectable dependencies, which is what lets the test suite verify the safety rules mechanically (budget exhaustion stops retries, the key is stable across attempts, delays never pass the cap) without real timers or a real server.

## What I learned

- The budget is the interesting piece. Backoff and jitter shape retries; the budget is the only mechanism that puts a hard bound on how much retry load a client can produce, and it does it with about forty lines of arithmetic.
- Jitter's value is shape, not count. In the demo run the jittered policy made slightly more requests than plain backoff and was still clearly better behaved, because the load arrived spread out instead of in waves.
- Failing fast is a feature with a cost you can see. The budget run is the only one with failed calls, and it is also the only one where the server saw almost nothing. Both halves of that sentence matter.
- Per-attempt timeouts are easy to get subtly wrong: the timer has to be created fresh for each attempt and cleared on every path, or the second attempt inherits the first attempt's deadline.

## Limitations

- One budget per client instance. A fleet of processes each gets its own bucket, so the fleet-wide bound is capacity times process count, same as the SDK design the post describes.
- Retrying a request with a streaming body is not supported; the client sends string bodies it can replay.
- The demo server fails on a timer, not under real load, so the storm numbers show client behavior, not a server melting.
- Retry-After is honored in seconds and HTTP-date form, but it can raise a delay past the backoff cap, because the server's explicit instruction outranks the local formula.

## What's next

The follow-up in the arc, a tiny version of another engineering blog post:

1. **An idempotency middleware**, from Airbnb's "Avoiding double payments in a distributed payments system": idempotency keys with stored-response replay, so the retries this client makes can never double-charge anyone. The client half of that contract is already here.

## License

MIT
