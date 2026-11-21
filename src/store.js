import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/db.json');
export const db = { giveaways: {}, users: {}, guilds: {} };

export function load() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (fs.existsSync(FILE)) Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
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
    write();
  }, 150);
}

// Write pending changes immediately (used on shutdown: hosting panels send SIGTERM).
export function flush() {
  if (!t) return;
  clearTimeout(t);
  t = null;
  write();
}
