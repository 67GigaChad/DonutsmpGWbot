// Tiny HTTP health server so the bot can run as a Render web service (free tier).
// It does no real work: it just answers Render's port check and health checks.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;

const json = (res, code, body, method) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
};

export function startServer(status = () => ({})) {
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const url = (req.url || '/').split('?')[0];

    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }

    if (url === '/') {
      // This is NOT a website: it exists only because Render's free plan only
      // offers Web Services, so the bot needs something listening on PORT.
      const text = 'DonutSMP Giveaway Bot is running.\nThis URL is only a health endpoint - the bot lives in Discord.\n';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(method === 'HEAD' ? undefined : text);
    }

    if (url === '/ready') {
      // Readiness: 503 until Discord is actually connected. Keep /health as a
      // liveness check so Render doesn't restart us while Discord is reconnecting.
      const s = status();
      const ready = Boolean(s.bot);
      return json(res, ready ? 200 : 503, { ok: ready, uptime: Math.round(process.uptime()), ...s }, method);
    }

    if (url === '/health' || url === '/healthz') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), ...status() }, method);
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
