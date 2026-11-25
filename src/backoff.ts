/**
 * The delay ceiling before attempt number `attempt` (0-based: the wait before
 * the first retry is attempt 0). Grows as base * 2^attempt and is hard-capped,
 * so the ceiling can never exceed capMs no matter how large attempt gets.
 */
export function backoffCeiling(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

/**
 * The actual sleep before a retry, following the article's "full jitter"
 * formula: sleep = random(0, ceiling). With jitter "none" the sleep is the
 * whole ceiling, which is what the demo uses to show why jitter matters.
 * `rng` returns a value in [0, 1) and is injectable for tests.
 */
export function computeBackoff(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitter: 'full' | 'none',
  rng: () => number,
): number {
  const ceiling = backoffCeiling(attempt, baseMs, capMs);
  if (jitter === 'none') return ceiling;
  return rng() * ceiling;
}
