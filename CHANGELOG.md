# Changelog

## v1.1.0 — 2026-11-22

Feature release plus Render hosting.

### Features

- **Normal giveaways** with required amount, duration and claim time
- **Split or Steal** — two winners secretly choose Split or Steal
- **Double or Keep** — the winner keeps the prize or doubles it into a new giveaway, up to a max
- **Claim timers** — winners get a DM with a Claim button; unclaimed winners expire
- **Payment requests** — claiming pings the host in the payment channel with a ready `/pay IGN amount`
- Amounts understand `k`, `m`, `b` (`500k`, `1.5m`, `2b`)

### Hosting

- Render **web service** support: tiny HTTP health server on `PORT` (`/health`, `/healthz`, `/ready`)
- Keep-alive self-ping (`RENDER_EXTERNAL_URL`, override with `KEEPALIVE_URL`) to avoid free-tier spin-down
- `render.yaml` blueprint with build/start commands and health check path
- `package-lock.json` + `npm ci` for reproducible builds
- `DATA_DIR` env var for a paid Render persistent disk (`/var/data`)
- Graceful shutdown: pending `data/db.json` writes are flushed on `SIGTERM` / `SIGINT`
- Clear error when `DISCORD_TOKEN` is missing or invalid
- Corrupt `db.json` no longer crashes the bot on boot

### Data

- `data/db.json` stores guild settings, saved IGNs, and giveaways
- Finished giveaways are pruned after 30 days
- `/forgetme` deletes a user's IGN; removing the bot deletes that server's data

## v1.0.0 — 2026-11-21

First public release.
