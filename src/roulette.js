import { EmbedBuilder } from 'discord.js';
import { shuffle, sleep } from './util.js';
import { DONUT, PALETTE, COLORS, SPEED } from './config.js';

const W = 22;
const FRAMES = 24;

const fit = (s) => (s.length > W ? s.slice(0, W - 1) + '…' : s).padEnd(W);

export function renderBox(rows) {
  const bar = '═'.repeat(W + 6);
  const line = (i, name) => {
    if (i === 2) return `║ ▶ ${fit(name.toUpperCase())} ◀ ║`;
    const edge = i === 1 || i === 3 ? ' ▒ ' : ' ░ ';
    return `║${edge}${fit(name)}   ║`;
  };
  return ['╔' + bar + '╗', ...rows.map((n, i) => line(i, n)), '╚' + bar + '╝'].join('\n');
}

async function edit(message, embed) {
  try { await message.edit({ embeds: [embed], components: [] }); } catch (e) { console.error('roulette edit failed:', e.message); }
}

/** Spins one roulette that is guaranteed to land on winnerIgn. */
export async function spin({ message, prize, names, winnerIgn, index, total, locked }) {
  const base = shuffle(names);
  const n = base.length;
  const winIdx = base.indexOf(winnerIgn);
  const offset = (((winIdx - (FRAMES + 1)) % n) + n) % n;
  const reel = Array.from({ length: FRAMES + 4 }, (_, i) => base[(i + offset) % n]);

  for (let p = 0; p < FRAMES; p++) {
    const embed = new EmbedBuilder()
      .setColor(PALETTE[p % PALETTE.length])
      .setTitle(`${DONUT}  DONUT ROULETTE  ${DONUT}`)
      .setDescription([
        ...(locked.length ? [...locked, ''] : []),
        `${DONUT} Spinning for **winner ${index}/${total}** …`,
        '```',
        renderBox(reel.slice(p, p + 5)),
        '```',
      ].join('\n'))
      .addFields({ name: 'Prize', value: prize })
      .setFooter({ text: `${n} entries • good luck!` });
    await edit(message, embed);
    const t = p / (FRAMES - 1);
    await sleep(Math.round((900 + t ** 3 * 1700) * SPEED));
  }

  const win = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`🎉  WINNER #${index}  🎉`)
    .setDescription([...(locked.length ? [...locked, ''] : []), `## ${DONUT} ${winnerIgn} ${DONUT}`, '```', renderBox(reel.slice(FRAMES - 1, FRAMES + 4)), '```'].join('\n'))
    .addFields({ name: 'Prize', value: prize });
  await edit(message, win);
  await sleep(Math.round(2200 * SPEED));
}
