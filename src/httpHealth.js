import { createServer } from 'node:http';

/** Minimal HTTP server so Render's free Web Service detects an open port. */
export function startHttpHealthServer({ port = process.env.PORT, getStatus = () => ({}), logger = console } = {}) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) return { server: null, stop: async () => {} };
  const server = createServer((req, res) => {
    const body = JSON.stringify({ ok: true, ...getStatus() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.on('error', error => logger.error?.('HTTP health server error', { message: error.message }));
  server.listen(parsed, '0.0.0.0', () => logger.info?.('HTTP health server listening', { port: parsed }));
  return { server, stop: () => new Promise(resolve => server.close(() => resolve())) };
}
