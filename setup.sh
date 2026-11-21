#!/usr/bin/env bash
# Usage: ./setup.sh <BOT_TOKEN> [--service]
#   installs deps (pacman, no prompts), saves the token, optionally installs a systemd user service
set -euo pipefail
cd "$(dirname "$0")"

TOKEN="${1:-${DISCORD_TOKEN:-}}"
SERVICE=0
for a in "$@"; do [ "$a" = "--service" ] && SERVICE=1; done
[ "$TOKEN" = "--service" ] && TOKEN="${DISCORD_TOKEN:-}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  sudo pacman -S --noconfirm --needed nodejs npm
fi
npm install --omit=dev --no-fund --no-audit --loglevel=error

if [ -n "$TOKEN" ]; then
  printf 'DISCORD_TOKEN=%s\n' "$TOKEN" > .env
  chmod 600 .env
elif [ ! -f .env ]; then
  echo "No token given. Run: ./setup.sh <BOT_TOKEN>" >&2
  exit 1
fi

if [ "$SERVICE" = 1 ]; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/donut-giveaway.service" <<UNIT
[Unit]
Description=DonutSMP Giveaway Bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$PWD
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now donut-giveaway.service
  sudo loginctl enable-linger "$USER"
  echo "🍩 Running as a service. Logs: journalctl --user -u donut-giveaway -f"
else
  echo "🍩 Ready. Start it with: npm start"
fi
