// .env is optional: on hosting panels just set DISCORD_TOKEN as an environment variable
try { process.loadEnvFile(); } catch { /* no .env file */ }

import { parseEmoji } from './util.js';

export const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN.startsWith('put_your')) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// Dev only: register commands to one server for instant updates. Leave unset for a public bot (global commands).
export const GUILD_ID = process.env.DEV_GUILD_ID || null;
export const DONUT = process.env.DONUT_EMOJI || '🍩';
export const EMOJI = parseEmoji(DONUT);
export const SPEED = Number(process.env.ROULETTE_SPEED) || 1;

export const COLORS = { pink: 0xff7eb6, gold: 0xffc857, green: 0x57f287, red: 0xed4245 };
export const PALETTE = [0xff7eb6, 0xffc857, 0xa78bfa, 0x5eead4, 0xfb923c, 0xf472b6];
