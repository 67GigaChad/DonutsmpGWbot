#!/usr/bin/env bash
# Usage: ./publish.sh [repo-name]      (set GH_TOKEN=... to skip the browser login)
set -euo pipefail
cd "$(dirname "$0")"
command -v gh >/dev/null 2>&1 || sudo pacman -S --noconfirm --needed github-cli git
NAME="${1:-donut-giveaway-bot}"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https
gh auth setup-git
[ -d .git ] || git init -q -b main
git add -A
git commit -qm "🍩 DonutSMP giveaway bot" || true
gh repo create "$NAME" --public --source=. --remote=origin --push \
  --description "Public Discord giveaway bot for DonutSMP: roulette draw, claim button, auto payment requests"
