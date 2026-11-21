# 🍩 DonutSMP Giveaway Bot

Public Discord giveaway bot for DonutSMP servers.

- **Live roulette draw**: the winner is picked on a slot-machine reel built from message edits
- **Claim Prize button**: pings the host in a payment channel with a ready `/pay IGN amount`
- **IGN entries**: one saved IGN per player, no duplicate IGNs per giveaway
- **Per-server config via slash commands**, no config files

## Self-host

```bash
npm install --omit=dev
# put your bot token in .env  ->  DISCORD_TOKEN=your_token
npm start
```

The invite link is printed on startup. Create the bot at https://discord.com/developers/applications (no privileged intents needed) and turn on **Public Bot** if you want others to add it.

## Commands

| Command | What it does |
|---|---|
| `/setup [payment_channel] [manager_role] [ping_role]` | Per-server config (Manage Server). No options shows current settings. |
| `/giveaway start prize duration [winners] [host] [payment_channel] [required_role] [ping_role]` | Start a giveaway |
| `/giveaway end [id]` / `reroll [id]` / `cancel [id]` / `list` | Manage giveaways |
| `/ign name` | Save your DonutSMP IGN |
| `/forgetme` | Delete your saved IGN and leave running giveaways |

Durations: `30m`, `1h30m`, `2d`. Money prizes like `5m` or `500k` generate a `/pay` command in the claim request.

## Optional env

`DONUT_EMOJI` (custom emoji), `ROULETTE_SPEED` (1 = normal, lower = faster), `DEV_GUILD_ID`.

See [PRIVACY.md](PRIVACY.md). Not affiliated with DonutSMP.

## Hosting panels (Wispbyte, Pterodactyl, etc.)

1. Upload the project (zip) and extract it, or `git clone` your repo.
2. Pick Node.js 18 or newer (22 recommended).
3. Set the environment variable `DISCORD_TOKEN` in the panel (or put it in a `.env` file).
4. Install command: `npm install --omit=dev`  •  Start command: `node src/index.js`
5. Keep the `data/` folder when updating. It holds settings and giveaways.
