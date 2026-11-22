import fs from 'node:fs';
import path from 'node:path';

// DATA_DIR lets you point at a Render persistent disk, e.g. /var/data.
const DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DIR, 'db.json');

export const db = { giveaways: {}, users: {}, guilds: {} };

export function load() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const key of Object.keys(db)) {
      if (parsed && typeof parsed[key] === 'object' && parsed[key] !== null) db[key] = parsed[key];
    }
  } catch (e) {
    // A corrupt/partial file (or a read-only disk) must not take the bot down on boot.
    console.error(`Could not read ${FILE}: ${e.message}`);
    try { fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
  }
}

function write() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

let t = null;
export function save() {
  clearTimeout(t);
  t = setTimeout(() => {
    t = null;
    try { write(); } catch (e) { console.error('Could not save data:', e.message); }
  }, 150);
}

// Write pending changes immediately (used on shutdown: hosting panels send SIGTERM).
export function flush() {
  if (!t) return;
  clearTimeout(t);
  t = null;
  try { write(); } catch (e) { console.error('Could not save data:', e.message); }
}

export const dataFile = FILE;
