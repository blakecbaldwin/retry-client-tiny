// A deliberately flaky HTTP server with no framework, just node:http.
// After every reset it fails all work requests with 503 for a fixed failure
// window, then recovers and answers 200. It records the arrival time of
// every work request so the runner can chart load over time.
import http from 'node:http';

export function startFlakyServer({ failureWindowMs }) {
  let windowStart = Date.now();
  let timestamps = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/reset' && req.method === 'POST') {
      windowStart = Date.now();
      timestamps = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalRequests: timestamps.length, timestampsMs: timestamps }));
      return;
    }
    const elapsed = Date.now() - windowStart;
    timestamps.push(elapsed);
    if (elapsed < failureWindowMs) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
