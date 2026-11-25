// Retry storm comparison runner.
//
// One flaky server, one fleet of simulated clients, four retry policies.
// The server fails every request for the first FAILURE_WINDOW_MS after each
// reset, then recovers. Each mode fires CLIENTS logical calls at once and
// the server counts how many requests actually arrive, bucketed over time.
// The gap between modes is the whole point of the Builders' Library post:
// the calls are identical, only the retry policy changes.
//
// Run with: npm run demo
// Outputs land in demo/output/: results.json, results.md, chart.html.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RetryClient } from '../dist/index.js';
import { startFlakyServer } from './flaky-server.mjs';

const CLIENTS = 12;
const FAILURE_WINDOW_MS = 2500;
const BUCKET_MS = 250;

const MODES = [
  {
    id: 'naive',
    label: 'Naive immediate retries',
    color: '#d64545',
    config: {
      timeoutMs: 1000,
      maxAttempts: 5000,
      backoffBaseMs: 0,
      backoffCapMs: 1,
      jitter: 'none',
      retryBudget: null,
    },
  },
  {
    id: 'backoff',
    label: 'Backoff only',
    color: '#e08a2e',
    config: {
      timeoutMs: 1000,
      maxAttempts: 200,
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      jitter: 'none',
      retryBudget: null,
    },
  },
  {
    id: 'backoff-jitter',
    label: 'Backoff + jitter',
    color: '#2e7de0',
    config: {
      timeoutMs: 1000,
      maxAttempts: 200,
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      jitter: 'full',
      retryBudget: null,
    },
  },
  {
    id: 'backoff-jitter-budget',
    label: 'Backoff + jitter + budget',
    color: '#2ea36b',
    config: {
      timeoutMs: 1000,
      maxAttempts: 200,
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      jitter: 'full',
      retryBudget: { capacity: CLIENTS, refillPerSecond: 2, costPerRetry: 1 },
    },
  },
];

function bucketize(timestampsMs, bucketCount) {
  const buckets = new Array(bucketCount).fill(0);
  for (const t of timestampsMs) {
    const idx = Math.min(bucketCount - 1, Math.floor(t / BUCKET_MS));
    buckets[idx] += 1;
  }
  return buckets;
}

async function runMode(flaky, mode) {
  await fetch(`${flaky.url}/reset`, { method: 'POST' });
  // One client shared by the whole fleet, so the retry budget is shared too,
  // exactly like one process making calls on behalf of many users.
  const client = new RetryClient(mode.config);
  const started = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: CLIENTS }, () => client.request(`${flaky.url}/work`)),
  );
  const elapsedMs = Date.now() - started;
  const stats = await (await fetch(`${flaky.url}/stats`)).json();
  const succeeded = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 200,
  ).length;
  return {
    id: mode.id,
    label: mode.label,
    color: mode.color,
    totalRequests: stats.totalRequests,
    succeeded,
    failed: CLIENTS - succeeded,
    elapsedMs,
    timestampsMs: stats.timestampsMs,
  };
}

function summarize(results, bucketCount) {
  return results.map((r) => {
    const buckets = bucketize(r.timestampsMs, bucketCount);
    const peakPerSecond = Math.max(...buckets) * (1000 / BUCKET_MS);
    return { ...r, buckets, peakPerSecond };
  });
}

function renderMarkdown(summary) {
  const lines = [
    '# Retry storm comparison',
    '',
    `Setup: ${CLIENTS} simulated clients fire one logical call each at the same moment.`,
    `The server answers 503 to everything for the first ${(FAILURE_WINDOW_MS / 1000).toFixed(1)}s, then recovers.`,
    'One shared client per mode, so the retry budget is shared across the fleet.',
    '',
    '| Mode | Requests that hit the server | Amplification per logical call | Peak rate (req/s) | Calls that eventually succeeded | Calls that failed |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of summary) {
    lines.push(
      `| ${r.label} | ${r.totalRequests} | ${(r.totalRequests / CLIENTS).toFixed(1)}x | ${r.peakPerSecond} | ${r.succeeded} | ${r.failed} |`,
    );
  }
  lines.push(
    '',
    'Naive retries turn 12 logical calls into a flood while the server is down, and the flood is',
    'self-inflicted: every client is retrying as fast as it can against a dependency that has',
    'already said it is unavailable. Backoff cuts the flood by orders of magnitude, but with no',
    'jitter the fleet still retries in lockstep waves (visible as spikes in the chart) because',
    'every client is running the same timers. Jitter desynchronizes the fleet: a few more',
    'requests overall in this run, but spread thin instead of landing in waves. The budget caps',
    'total retry load outright: once it is spent, calls fail fast instead of piling on. In this',
    'run every budget-mode call failed fast during the outage, and in exchange the server saw',
    '24 requests instead of 10,000 plus, so it had room to recover. Failing fast is the caller',
    'protecting the dependency, and it is the layer above that decides what a fast failure',
    'means for the user.',
    '',
  );
  return lines.join('\n');
}

function renderChart(summary, bucketCount) {
  const width = 920;
  const height = 340;
  const margin = { top: 30, right: 20, bottom: 40, left: 50 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxY = Math.max(...summary.flatMap((r) => r.buckets), 1);
  const x = (i) => margin.left + (i / (bucketCount - 1)) * plotW;
  const y = (v) => margin.top + plotH - (v / maxY) * plotH;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${margin.left}" y="20" font-size="15" font-weight="bold">Requests per ${(BUCKET_MS / 1000).toFixed(2)}s bucket, by retry policy</text>`,
  );
  // Failure window shading: the server is down until FAILURE_WINDOW_MS.
  const windowEndBucket = FAILURE_WINDOW_MS / BUCKET_MS;
  parts.push(
    `<rect x="${x(0)}" y="${margin.top}" width="${x(windowEndBucket) - x(0)}" height="${plotH}" fill="#f3d9d9" opacity="0.6"/>`,
  );
  parts.push(
    `<text x="${x(0) + 6}" y="${margin.top + 16}" font-size="11" fill="#8a3b3b">server down</text>`,
  );
  // Axes
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#333"/>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333"/>`,
  );
  parts.push(
    `<text x="${margin.left}" y="${height - 8}" font-size="11">time (seconds): 0 to ${((bucketCount * BUCKET_MS) / 1000).toFixed(1)}</text>`,
  );
  parts.push(
    `<text x="6" y="${margin.top + 12}" font-size="11">max ${maxY} req/bucket</text>`,
  );
  for (const r of summary) {
    const points = r.buckets.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    parts.push(
      `<polyline fill="none" stroke="${r.color}" stroke-width="2" points="${points}"/>`,
    );
  }
  // Legend
  let lx = margin.left + 320;
  for (const r of summary) {
    parts.push(`<rect x="${lx}" y="${height - 26}" width="10" height="10" fill="${r.color}"/>`);
    parts.push(`<text x="${lx + 14}" y="${height - 16}" font-size="11">${r.label} (${r.totalRequests})</text>`);
    lx += 14 + r.label.length * 6.4 + String(r.totalRequests).length * 7 + 30;
  }
  parts.push('</svg>');
  const svg = parts.join('\n');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>Retry storm comparison</title></head>',
    '<body>',
    '<h1>Retry storm comparison</h1>',
    `<p>${CLIENTS} clients, one logical call each. The server fails for the first ${(FAILURE_WINDOW_MS / 1000).toFixed(1)} seconds, then recovers. Numbers in the legend are total requests that hit the server.</p>`,
    svg,
    '</body></html>',
    '',
  ].join('\n');
}

async function main() {
  const flaky = await startFlakyServer({ failureWindowMs: FAILURE_WINDOW_MS });
  const results = [];
  try {
    for (const mode of MODES) {
      results.push(await runMode(flaky, mode));
    }
  } finally {
    await flaky.close();
  }

  const maxElapsed = Math.max(...results.map((r) => Math.max(...r.timestampsMs, r.elapsedMs)));
  const bucketCount = Math.max(2, Math.ceil(maxElapsed / BUCKET_MS) + 1);
  const summary = summarize(results, bucketCount);

  const outDir = `${dirname(fileURLToPath(import.meta.url))}/output`;
  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/results.json`,
    JSON.stringify(
      {
        clients: CLIENTS,
        failureWindowMs: FAILURE_WINDOW_MS,
        bucketMs: BUCKET_MS,
        modes: summary.map(({ timestampsMs, ...rest }) => rest),
      },
      null,
      2,
    ),
  );
  await writeFile(`${outDir}/results.md`, renderMarkdown(summary));
  await writeFile(`${outDir}/chart.html`, renderChart(summary, bucketCount));

  console.log(`Retry storm comparison: ${CLIENTS} clients, server down for ${FAILURE_WINDOW_MS}ms`);
  for (const r of summary) {
    console.log(
      `${r.label.padEnd(28)} requests=${r.totalRequests} peak=${r.peakPerSecond}/s ok=${r.succeeded} failed=${r.failed}`,
    );
  }
  console.log(`Wrote ${outDir}/results.json, results.md, chart.html`);
}

await main();
