import { randomInt } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseDuration(str) {
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
  const mult = { d: 864e5, h: 36e5, m: 6e4, s: 1e3 };
  let ms = 0, found = false, m;
  while ((m = re.exec(str))) {
    found = true;
    ms += parseFloat(m[1]) * mult[m[2].toLowerCase()];
  }
  return found ? Math.round(ms) : null;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function parseEmoji(s) {
  const m = /^<(a?):(\w+):(\d+)>$/.exec(s.trim());
  return m ? { animated: !!m[1], name: m[2], id: m[3] } : s.trim();
}

export const IGN_RE = /^\.?[A-Za-z0-9_]{3,16}$/;

/** "500k" -> 500000, "1.5m" -> 1500000, "2b" -> 2e9, "1,000" -> 1000. Returns null if invalid. */
export function parseAmount(str) {
  const m = /^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?$/i.exec(String(str).trim());
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const n = Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? mult[m[2].toLowerCase()] : 1));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 1500000 -> "1.5m" (falls back to the plain number when it can't be shortened exactly). */
export function fmtAmount(n) {
  for (const [s, v] of [['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]]) {
    if (n >= v) {
      const r = Math.round((n / v) * 1000) / 1000;
      if (Math.round(r * v) === n) return `${r}${s}`;
    }
  }
  return String(n);
}

/** "-1" = unlimited (-1), otherwise a duration between 10s and 30d. null if invalid. */
export function parseClaimTime(str) {
  const s = String(str).trim();
  if (s === '-1') return -1;
  const ms = parseDuration(s);
  return ms && ms >= 10_000 && ms <= 30 * 864e5 ? ms : null;
}

export function fmtDuration(ms) {
  const out = [];
  for (const [s, v] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3]]) {
    const n = Math.floor(ms / v);
    if (n) { out.push(`${n}${s}`); ms -= n * v; }
  }
  return out.join(' ') || '0s';
}

/** Golden Balls rules. Returns [amountA, amountB]. */
export function sosOutcome(amount, a, b) {
  if (a === 'split' && b === 'split') { const h = Math.floor(amount / 2); return [h, h]; }
  if (a === 'steal' && b === 'steal') return [0, 0];
  return a === 'steal' ? [amount, 0] : [0, amount];
}
