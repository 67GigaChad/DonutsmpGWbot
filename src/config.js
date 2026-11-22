import fs from 'node:fs';
import { parseEmoji } from './util.js';

// .env is optional: on hosting panels just set DISCORD_TOKEN as an environment variable.
// process.loadEnvFile() needs Node >= 20.12, so keep a tiny fallback for older Node.
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* no .env file */ }
} else {
  try {
    const text = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !m[1] || m[1] in process.env) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env file */ }
}

export const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN.startsWith('put_your')) {
  console.error('Missing DISCORD_TOKEN.');
  console.error('On Render: Dashboard → your service → Environment → add DISCORD_TOKEN, then redeploy.');
  console.error('Locally: put DISCORD_TOKEN=your_token in .env.');
  process.exit(1);
}

// Dev only: register commands to one server for instant updates. Leave unset for a public bot (global commands).
export const GUILD_ID = process.env.DEV_GUILD_ID || null;
export const DONUT = process.env.DONUT_EMOJI || '🍩';
export const EMOJI = parseEmoji(DONUT);
export const SPEED = Number(process.env.ROULETTE_SPEED) || 1;

export const COLORS = { pink: 0xff7eb6, gold: 0xffc857, green: 0x57f287, red: 0xed4245 };
export const PALETTE = [0xff7eb6, 0xffc857, 0xa78bfa, 0x5eead4, 0xfb923c, 0xf472b6];
