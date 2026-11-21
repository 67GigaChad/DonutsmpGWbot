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

export const isMoney = (s) => /^\$?\d+(\.\d+)?[kmbt]?$/i.test(s.trim());
export const IGN_RE = /^\.?[A-Za-z0-9_]{3,16}$/;
