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
| `/giveaway start amount duration claim_time [winners] [host] [payment_channel] [required_role] [ping_role]` | Normal giveaway (amount is per winner) |
| `/giveaway splitsteal amount duration claim_time [decision_time] ...` | 2 players are picked and secretly choose Split or Steal |
| `/giveaway doublekeep start_amount max_amount duration claim_time [decision_time] ...` | Winner chooses Keep or Double (a new, bigger giveaway runs until the max) |
| `/giveaway end [id]` / `reroll [id]` / `cancel [id]` / `list` | Manage giveaways |
| `/ign name` | Save your DonutSMP IGN |
| `/forgetme` | Delete your saved IGN and leave running giveaways |

- **Amounts** are required and understand `k`, `m`, `b` (`500k`, `1.5m`, `2b`).
- **claim_time** is required: `-1` = unlimited, otherwise `5m`, `1h`, `2d`...
- **Split or Steal:** both split = half each, one steals = stealer takes all, both steal = nobody wins. No pick in time = Split.
- **Double or Keep:** Keep = claim the prize. Double = the winner gives up that prize and a new giveaway runs for 2x (capped at the max). Repeats until the max is reached, where the winner just keeps it. No pick in time = Keep. If a doubled round gets no entries, the player who doubled gets their prize back.
- Winners get a **DM with a Claim button**, and the giveaway message shows claim status. Claiming asks for the username and pings the host in the payment channel.

## Optional env

`DONUT_EMOJI` (custom emoji), `ROULETTE_SPEED` (1 = normal, lower = faster), `DEV_GUILD_ID`.

See [PRIVACY.md](PRIVACY.md). Not affiliated with DonutSMP.

## Hosting panels (Wispbyte, Pterodactyl, etc.)

1. Upload the project (zip) and extract it, or `git clone` your repo.
2. Pick Node.js 18 or newer (22 recommended).
3. Set the environment variable `DISCORD_TOKEN` in the panel (or put it in a `.env` file).
4. Install command: `npm install --omit=dev`  •  Start command: `node index.js`
5. Keep the `data/` folder when updating. It holds settings and giveaways.
