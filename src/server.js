// Tiny HTTP health server so the bot can run as a Render web service (free tier).
// It does no real work: it just answers Render's port check and health checks.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;

export function startServer(status = () => ({})) {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    if (req.url === '/' || req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ...status() }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  server.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on :${PORT}`));
  server.on('error', (e) => console.error('Health server error:', e.message));
  return server;
}

// Free Render web services spin down after 15 min with no inbound traffic.
// Ping our own public URL every 10 min so the bot stays online.
// KEEPALIVE_URL overrides the URL Render provides automatically.
export function startKeepAlive() {
  const url = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url) return;

  const ping = () => fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  setTimeout(ping, 30_000).unref();
  setInterval(ping, 10 * 60_000).unref();
  console.log(`Keep-alive pinger targeting ${url}`);
}
