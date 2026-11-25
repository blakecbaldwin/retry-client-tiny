# Retry storm comparison

Setup: 12 simulated clients fire one logical call each at the same moment.
The server answers 503 to everything for the first 2.5s, then recovers.
One shared client per mode, so the retry budget is shared across the fleet.

| Mode | Requests that hit the server | Amplification per logical call | Peak rate (req/s) | Calls that eventually succeeded | Calls that failed |
| --- | --- | --- | --- | --- | --- |
| Naive immediate retries | 10851 | 904.3x | 5992 | 12 | 0 |
| Backoff only | 72 | 6.0x | 96 | 12 | 0 |
| Backoff + jitter | 105 | 8.8x | 164 | 12 | 0 |
| Backoff + jitter + budget | 24 | 2.0x | 96 | 0 | 12 |

Naive retries turn 12 logical calls into a flood while the server is down, and the flood is
self-inflicted: every client is retrying as fast as it can against a dependency that has
already said it is unavailable. Backoff cuts the flood by orders of magnitude, but with no
jitter the fleet still retries in lockstep waves (visible as spikes in the chart) because
every client is running the same timers. Jitter desynchronizes the fleet: a few more
requests overall in this run, but spread thin instead of landing in waves. The budget caps
total retry load outright: once it is spent, calls fail fast instead of piling on. In this
run every budget-mode call failed fast during the outage, and in exchange the server saw
24 requests instead of 10,000 plus, so it had room to recover. Failing fast is the caller
protecting the dependency, and it is the layer above that decides what a fast failure
means for the user.
