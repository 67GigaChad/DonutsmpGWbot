import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, PermissionFlagsBits,
  ChannelType, MessageFlags, REST, Routes, InteractionContextType,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { GUILD_ID, TOKEN, DONUT, EMOJI, COLORS, SPEED } from './config.js';
import * as store from './store.js';
import {
  parseDuration, parseAmount, parseClaimTime, fmtAmount, fmtDuration, sosOutcome, shuffle, sleep, IGN_RE,
} from './util.js';
import { spin } from './roulette.js';

const EPH = MessageFlags.Ephemeral;
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
store.load();
const db = store.db;
const busy = new Set();

/* ───────────────────────── commands ───────────────────────── */

const idOpt = (o) => o.setName('id').setDescription('Giveaway ID (defaults to the latest)');

const timeOpts = (s) => s
  .addStringOption((o) => o.setName('duration').setDescription('How long it runs: 30m, 1h30m, 2d').setRequired(true))
  .addStringOption((o) => o.setName('claim_time').setDescription('Time winners have to claim: 5m, 1h, or -1 for unlimited').setRequired(true));

const commonOpts = (s) => s
  .addUserOption((o) => o.setName('host').setDescription('Who pays the prize (default: you)'))
  .addChannelOption((o) => o.setName('payment_channel').setDescription('Where claim requests are posted')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
  .addRoleOption((o) => o.setName('required_role').setDescription('Role needed to enter'))
  .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping'));

const decisionOpt = (s, d) => s.addStringOption((o) => o.setName('decision_time').setDescription(`Time to choose (default ${d})`));

const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription(`${DONUT} DonutSMP giveaways`)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => commonOpts(decisionlessStart(s)))
    .addSubcommand((s) => commonOpts(decisionOpt(timeOpts(s
      .setName('splitsteal').setDescription('Split or Steal: 2 players are picked and secretly choose')
      .addStringOption((o) => o.setName('amount').setDescription('Prize pool: 500k, 1.5m, 2b').setRequired(true))), '1m')))
    .addSubcommand((s) => commonOpts(decisionOpt(timeOpts(s
      .setName('doublekeep').setDescription('Double or Keep: the winner keeps it or doubles it into a new giveaway')
      .addStringOption((o) => o.setName('start_amount').setDescription('Starting prize: 500k, 1m').setRequired(true))
      .addStringOption((o) => o.setName('max_amount').setDescription('Max prize it can double up to: 8m').setRequired(true))), '5m')))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('reroll').setDescription('Reroll unclaimed winners (normal giveaways)').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a running giveaway').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('list').setDescription('List running giveaways')),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription(`${DONUT} Configure the giveaway bot for this server`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) => o.setName('payment_channel').setDescription('Default channel for claim/payment requests')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption((o) => o.setName('manager_role').setDescription('Role allowed to run /giveaway (besides Manage Server)'))
    .addRoleOption((o) => o.setName('ping_role').setDescription('Role pinged by default on new giveaways')),
  new SlashCommandBuilder().setName('forgetme').setDescription('Delete your saved IGN and remove you from running giveaways'),
  new SlashCommandBuilder()
    .setName('ign')
    .setDescription('Set your DonutSMP IGN for giveaways')
    .addStringOption((o) => o.setName('name').setDescription('Your in-game name').setRequired(true)),
];

function decisionlessStart(s) {
  return timeOpts(s.setName('start').setDescription('Start a normal giveaway')
    .addStringOption((o) => o.setName('amount').setDescription('Prize per winner: 500k, 1.5m, 2b').setRequired(true)))
    .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(10));
}

/* ───────────────────────── helpers ───────────────────────── */

const ts = (ms) => Math.floor(ms / 1000);
const amt = (n) => fmtAmount(n);
const msgUrl = (g) => `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
const pickN = (pool, n) => shuffle(pool).slice(0, n);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const claimText = (g) => (g.claimMs > 0 ? fmtDuration(g.claimMs) : 'unlimited');
const nextAmount = (g) => Math.min(g.amount * 2, g.maxAmount);
const claimable = (w) => w.amount > 0 && !w.doubled;
const pendingClaim = (w) => claimable(w) && !w.claimed && !w.expired;
const mkWinner = (g) => ([userId, ign]) => ({
  userId, ign, amount: g.mode === 'splitsteal' ? null : g.amount, claimed: false, paid: false,
});

const guildSettings = (guildId) => (db.guilds[guildId] ??= {});
const canManage = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  || (guildSettings(i.guildId).managerRoleId && i.member.roles.cache.has(guildSettings(i.guildId).managerRoleId));

const NEEDED = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links'], ['ReadMessageHistory', 'Read Message History']];
const missingPerms = (ch, me) => {
  const p = ch.permissionsFor(me);
  return NEEDED.filter(([f]) => !p?.has(PermissionFlagsBits[f])).map(([, n]) => n);
};

async function fetchMsg(g) {
  const ch = await client.channels.fetch(g.channelId);
  return ch.messages.fetch(g.messageId);
}

function resolveGiveaway(guildId, id, statuses) {
  const all = Object.values(db.giveaways).filter((g) => g.guildId === guildId && statuses.includes(g.status));
  if (id) return all.find((g) => g.id === id.trim() || g.messageId === id.trim());
  return all.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/* ───────────────────────── embeds & buttons ───────────────────────── */

function modeTitle(g) {
  if (g.mode === 'splitsteal') return `${DONUT} Split or Steal • ${amt(g.amount)}`;
  if (g.mode === 'doublekeep') return `${DONUT} Double or Keep • ${amt(g.amount)}`;
  return `${DONUT} ${amt(g.amount)}`;
}

function rulesLines(g) {
  if (g.mode === 'splitsteal') {
    return [
      `Two players are picked. Each secretly chooses **Split** or **Steal** (${fmtDuration(g.decisionMs)} to decide, no pick = Split).`,
      `Both Split: **${amt(Math.floor(g.amount / 2))}** each`,
      `One Steals: the stealer takes **${amt(g.amount)}**`,
      'Both Steal: **nobody** wins',
    ];
  }
  if (g.mode === 'doublekeep') {
    return [
      `Round **${g.round}** • Prize now: **${amt(g.amount)}**`,
      `Starts at **${amt(g.startAmount)}** • Max **${amt(g.maxAmount)}**`,
      g.amount >= g.maxAmount
        ? `Max reached: the winner keeps **${amt(g.amount)}**.`
        : `The winner picks **Keep** (claim ${amt(g.amount)}) or **Double** (gives up this prize, and a new giveaway runs for **${amt(nextAmount(g))}**). Doubling stops at the max of **${amt(g.maxAmount)}**.`,
      `${fmtDuration(g.decisionMs)} to decide, no pick = Keep.`,
    ];
  }
  return [`Prize: **${amt(g.amount)}**${g.winnersCount > 1 ? ' each' : ''}`, `Winners: **${g.winnersCount}**`];
}

function runningEmbed(g) {
  const t = ts(g.endsAt);
  return new EmbedBuilder()
    .setColor(COLORS.pink)
    .setTitle(modeTitle(g))
    .setDescription([
      `Click the ${DONUT} button to enter!`,
      ...rulesLines(g),
      `Ends: <t:${t}:R> (<t:${t}:f>)`,
      `Claim time: **${claimText(g)}** after winning`,
      `Hosted by: <@${g.hostId}>`,
      g.requiredRoleId ? `Requires: <@&${g.requiredRoleId}>` : null,
    ].filter((x) => x !== null).join('\n'))
    .setFooter({ text: `Ends at • ID ${g.id}` })
    .setTimestamp(g.endsAt);
}

const runningRow = (g) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:enter:${g.id}`).setLabel(String(Object.keys(g.entries).length)).setEmoji(EMOJI).setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId(`gw:parts:${g.id}`).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary),
);

function decidingEmbed(g) {
  const t = ts(g.decideBy);
  if (g.mode === 'splitsteal') {
    const [a, b] = g.winners;
    const st = (w) => (g.choices?.[w.userId] ? '✅ locked in' : '⏳ choosing');
    return new EmbedBuilder().setColor(COLORS.gold).setTitle(modeTitle(g))
      .setDescription([
        `**${a.ign}** (<@${a.userId}>) vs **${b.ign}** (<@${b.userId}>)`,
        '',
        `${a.ign}: ${st(a)}`,
        `${b.ign}: ${st(b)}`,
        '',
        'Choices are secret until both are locked in.',
        `Both Split: **${amt(Math.floor(g.amount / 2))}** each • One Steals: stealer takes **${amt(g.amount)}** • Both Steal: nobody wins`,
        `Decide <t:${t}:R>. No pick = Split.`,
      ].join('\n'))
      .setFooter({ text: `DonutSMP Giveaways • ID ${g.id}` });
  }
  const w = g.winners[0];
  return new EmbedBuilder().setColor(COLORS.gold).setTitle(modeTitle(g))
    .setDescription([
      `🏆 **${w.ign}** (<@${w.userId}>) won **${amt(g.amount)}**!`,
      '',
      `**Keep**: claim **${amt(g.amount)}**`,
      `**Double**: give up this prize, a new giveaway runs for **${amt(nextAmount(g))}** (max **${amt(g.maxAmount)}**)`,
      '',
      `Only <@${w.userId}> can choose. Decide <t:${t}:R>. No pick = Keep.`,
    ].join('\n'))
    .setFooter({ text: `Round ${g.round} • ID ${g.id}` });
}

const decisionRow = (g) => new ActionRowBuilder().addComponents(
  g.mode === 'splitsteal'
    ? [
      new ButtonBuilder().setCustomId(`gw:split:${g.id}`).setLabel('Split').setEmoji('🤝').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gw:steal:${g.id}`).setLabel('Steal').setEmoji('🗡️').setStyle(ButtonStyle.Danger),
    ]
    : [
      new ButtonBuilder().setCustomId(`gw:keep:${g.id}`).setLabel(`Keep ${amt(g.amount)}`).setEmoji('💰').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gw:double:${g.id}`).setLabel(`Double to ${amt(nextAmount(g))}`).setEmoji('🔁').setStyle(ButtonStyle.Primary),
    ],
);

function winnerLine(g, w) {
  const who = `**${w.ign}** (<@${w.userId}>)`;
  const ch = w.choice ? ` chose **${cap(w.choice)}**` : '';
  if (w.doubled) return `🏆 ${who}${ch}`;
  if (!w.amount) return `${who}${ch} → **nothing**`;
  const st = w.paid ? '💸 paid' : w.claimed ? '✅ claimed' : w.expired ? '⌛ claim expired'
    : w.claimBy ? `⏳ claim <t:${ts(w.claimBy)}:R>` : '⏳ unclaimed';
  return `🏆 ${who}${ch} → **${amt(w.amount)}** — ${st}`;
}

function endedEmbed(g) {
  const lines = g.winners.length
    ? g.winners.map((w) => winnerLine(g, w))
    : [g.mode === 'splitsteal' ? '*Split or Steal needs at least 2 entries, so nobody played.*' : '*No valid entries, nobody won.*'];
  const child = g.childId && db.giveaways[g.childId];
  return new EmbedBuilder()
    .setColor(g.winners.length ? COLORS.gold : COLORS.red)
    .setTitle(modeTitle(g))
    .setDescription([
      '**Giveaway ended**', '', ...lines,
      child ? `\n🔁 Next round: ${msgUrl(child)}` : null,
      '',
      `**Hosted by** <@${g.hostId}>`,
      `**Entries** ${Object.keys(g.entries).length}`,
    ].filter((x) => x !== null).join('\n'))
    .setFooter({ text: `DonutSMP Giveaways • ID ${g.id}` });
}

function endedRow(g) {
  const row = new ActionRowBuilder();
  if (g.winners.some(claimable)) {
    row.addComponents(new ButtonBuilder().setCustomId(`gw:claim:${g.id}`).setLabel('Claim Prize').setEmoji('🎁')
      .setStyle(ButtonStyle.Primary).setDisabled(!g.winners.some(pendingClaim)));
  }
  row.addComponents(new ButtonBuilder().setCustomId(`gw:parts:${g.id}`).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary));
  return row;
}

function mainPayload(g) {
  if (g.status === 'running') return { embeds: [runningEmbed(g)], components: [runningRow(g)] };
  if (g.status === 'deciding') return { embeds: [decidingEmbed(g)], components: [decisionRow(g)] };
  return { embeds: [endedEmbed(g)], components: [endedRow(g)] };
}

async function editMain(g) {
  try { await (await fetchMsg(g)).edit(mainPayload(g)); } catch { /* msg gone */ }
}

const pending = new Map();
function refresh(g) {
  if (pending.has(g.id)) return;
  pending.set(g.id, setTimeout(() => { pending.delete(g.id); if (g.status === 'running') editMain(g); }, 2500));
}

function payEmbed(g, w) {
  return new EmbedBuilder()
    .setColor(w.paid ? COLORS.green : COLORS.pink)
    .setTitle(`${DONUT}  ${w.paid ? 'Payment Completed' : 'Payment Request'}`)
    .setDescription(`Run this in-game:\n\`\`\`/pay ${w.ign} ${amt(w.amount)}\`\`\`Exact amount: \`${w.amount.toLocaleString('en-US')}\``)
    .addFields(
      { name: 'Winner', value: `\`${w.ign}\`\n<@${w.userId}>`, inline: true },
      { name: 'Host', value: `<@${g.hostId}>`, inline: true },
      { name: 'Prize', value: amt(w.amount), inline: true },
      { name: 'Giveaway', value: `[jump](${msgUrl(g)})`, inline: true },
    )
    .setFooter({ text: w.paid ? 'Paid ✅' : 'Host: press the button once you have paid' });
}

const payRow = (g, w) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:paid:${g.id}:${w.userId}`).setLabel('Mark as Paid').setEmoji('✅').setStyle(ButtonStyle.Success),
);

/* ───────────────────────── DMs ───────────────────────── */

function dmEmbed(g, w) {
  const e = new EmbedBuilder().setTitle(`${DONUT} You won ${amt(w.amount)}!`).setFooter({ text: `DonutSMP Giveaways • ID ${g.id}` });
  if (w.paid) return e.setColor(COLORS.green).setDescription(`💸 The host paid **${amt(w.amount)}** to **${w.ign}**. Enjoy!`);
  if (w.claimed) return e.setColor(COLORS.green).setDescription(`✅ Claim sent! The host was pinged to pay **${w.ign}**.`);
  if (w.expired) return e.setColor(COLORS.red).setDescription('⌛ The claim time ran out, so this prize can no longer be claimed.');
  return e.setColor(COLORS.pink).setDescription([
    `You won **${amt(w.amount)}** in a ${g.mode === 'splitsteal' ? 'Split or Steal' : g.mode === 'doublekeep' ? 'Double or Keep' : ''} giveaway!`.replace('  ', ' '),
    'Press **Claim** and confirm your username, and the host is asked to pay you.',
    w.claimBy ? `Claim <t:${ts(w.claimBy)}:R> or it expires.` : 'There is no claim deadline.',
  ].join('\n'));
}

const dmRow = (g, w) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:claim:${g.id}`).setLabel('Claim').setEmoji('🎁').setStyle(ButtonStyle.Success)
    .setDisabled(!!(w.claimed || w.expired || w.paid)),
  new ButtonBuilder().setLabel('Giveaway').setStyle(ButtonStyle.Link).setURL(msgUrl(g)),
);

async function dmWinner(g, w) {
  try {
    const user = await client.users.fetch(w.userId);
    const m = await user.send({ embeds: [dmEmbed(g, w)], components: [dmRow(g, w)] });
    w.dmMessageId = m.id;
    store.save();
    return true;
  } catch { return false; }
}

async function updateDm(g, w) {
  if (!w.dmMessageId) return;
  try {
    const dm = await (await client.users.fetch(w.userId)).createDM();
    await (await dm.messages.fetch(w.dmMessageId)).edit({ embeds: [dmEmbed(g, w)], components: [dmRow(g, w)] });
  } catch { /* closed DMs or deleted */ }
}

/* ───────────────────────── creating giveaways ───────────────────────── */

async function launch(base, channel) {
  const now = Date.now();
  const g = {
    id: randomUUID().slice(0, 8), messageId: null, status: 'running', entries: {}, winners: [], drawn: [], animate: [],
    createdAt: now, endsAt: now + base.durationMs, winnersCount: 1, round: 1, ...base,
  };
  const msg = await channel.send({
    content: g.pingRoleId ? `<@&${g.pingRoleId}>` : undefined,
    embeds: [runningEmbed(g)],
    components: [runningRow(g)],
    allowedMentions: { roles: g.pingRoleId ? [g.pingRoleId] : [] },
  });
  g.messageId = msg.id;
  g.chainId ??= g.id;
  db.giveaways[g.id] = g;
  store.save();
  return { g, msg };
}

/* ───────────────────────── drawing ───────────────────────── */

async function draw(g, { reroll = false, resume = false } = {}) {
  if (busy.has(g.id)) return 'busy';
  busy.add(g.id);
  try {
    const msg = await fetchMsg(g).catch(() => null);
    if (!msg) { g.status = 'cancelled'; store.save(); return 'gone'; }

    if (!resume) {
      const entries = Object.entries(g.entries);
      if (reroll) {
        const kept = g.winners.filter((w) => w.claimed);
        const pool = entries.filter(([u]) => !g.drawn.includes(u));
        if (!pool.length) return 'nopool';
        const chosen = pickN(pool, Math.max(1, g.winnersCount - kept.length)).map(mkWinner(g));
        g.winners = [...kept, ...chosen];
        g.drawn.push(...chosen.map((w) => w.userId));
        g.animate = chosen.map((w) => w.userId);
      } else {
        const need = g.mode === 'splitsteal' ? 2 : g.mode === 'doublekeep' ? 1 : g.winnersCount;
        const chosen = g.mode === 'splitsteal' && entries.length < 2 ? [] : pickN(entries, need).map(mkWinner(g));
        g.winners = chosen;
        g.drawn = chosen.map((w) => w.userId);
        g.animate = g.drawn.slice();
      }
      g.status = 'drawing';
      store.save();

      const names = Object.values(g.entries);
      if (g.animate.length && names.length > 1) {
        const label = g.mode === 'splitsteal' ? 'player' : 'winner';
        const locked = g.winners.filter((w) => !g.animate.includes(w.userId)).map((w) => `🏆 **${w.ign}**`);
        for (let k = 0; k < g.animate.length; k++) {
          const w = g.winners.find((x) => x.userId === g.animate[k]);
          await spin({
            message: msg, prize: amt(g.amount), names, winnerIgn: w.ign, index: k + 1, total: g.animate.length, locked: [...locked], label,
          });
          locked.push(`🏆 **${w.ign}**`);
        }
      }
    }
    await afterDraw(g, msg);
    return 'ok';
  } finally {
    busy.delete(g.id);
  }
}

async function afterDraw(g, msg) {
  if (!g.winners.length) {
    g.status = 'ended';
    g.animate = [];
    store.save();
    await msg.edit(mainPayload(g)).catch(console.error);
    if (g.parentId) await restoreParent(g);
    return;
  }
  if (g.mode === 'splitsteal' || (g.mode === 'doublekeep' && g.amount < g.maxAmount)) return startDeciding(g, msg);
  return finalizeWin(g, msg, { fresh: g.animate.slice() });
}

function defaultAnnounce(g, ids) {
  const who = ids.map((u) => `<@${u}>`).join(' ');
  if (g.mode === 'doublekeep') {
    return `${DONUT} ${who} won the final round and keeps **${amt(g.amount)}** (max reached)!\nPress **Claim Prize** or check your DMs.`;
  }
  return `🎉 Congratulations ${who}! You won **${amt(g.amount)}** ${DONUT}\nPress **Claim Prize** or check your DMs. Claim time: **${claimText(g)}**.`;
}

/** The prize is won: start claim timers, update the message, DM winners, announce in chat. */
async function finalizeWin(g, msg, { fresh, announce } = {}) {
  g.status = 'ended';
  g.animate = [];
  const ids = fresh ?? g.winners.map((w) => w.userId);
  const now = Date.now();
  const targets = g.winners.filter((w) => ids.includes(w.userId) && claimable(w) && !w.claimed);
  for (const w of targets) { w.claimBy = g.claimMs > 0 ? now + g.claimMs : null; w.expired = false; }
  store.save();
  await msg.edit(mainPayload(g)).catch(console.error);

  const failed = [];
  for (const w of targets) if (!(await dmWinner(g, w))) failed.push(w.userId);

  const note = failed.length
    ? `\n⚠️ Couldn't DM ${failed.map((u) => `<@${u}>`).join(' ')}. Use **Claim Prize** on the giveaway message.`
    : '';
  await msg.reply({ content: (announce ?? defaultAnnounce(g, ids)) + note, allowedMentions: { users: [...new Set(ids)] } }).catch(console.error);
}

/* ───────────────────────── decisions (Double or Keep / Split or Steal) ───────────────────────── */

async function startDeciding(g, msg) {
  g.status = 'deciding';
  g.decideBy = Date.now() + g.decisionMs;
  g.choices = {};
  store.save();
  await msg.edit(mainPayload(g)).catch(console.error);
  const ids = g.winners.map((w) => w.userId);
  const text = g.mode === 'splitsteal'
    ? `${DONUT} ${ids.map((u) => `<@${u}>`).join(' ')} you were picked! Secretly choose **Split** or **Steal** <t:${ts(g.decideBy)}:R>.`
    : `${DONUT} <@${ids[0]}> you won **${amt(g.amount)}**! Choose **Keep** or **Double** <t:${ts(g.decideBy)}:R>.`;
  await msg.reply({ content: text, allowedMentions: { users: ids } }).catch(console.error);
  for (const id of ids) {
    client.users.fetch(id).then((u) => u.send(`${DONUT} You were picked in a giveaway! Make your choice here: ${msgUrl(g)}`)).catch(() => {});
  }
}

async function resolveDok(g, choice) {
  if (busy.has(g.id) || g.status !== 'deciding') return 'busy';
  busy.add(g.id);
  try {
    const msg = await fetchMsg(g).catch(() => null);
    if (!msg) { g.status = 'cancelled'; store.save(); return 'gone'; }
    const w = g.winners[0];
    w.choice = choice;
    g.decision = choice;

    if (choice === 'keep') {
      w.amount = g.amount;
      await finalizeWin(g, msg, {
        announce: `${DONUT} <@${w.userId}> has chosen **Keep** and wins **${amt(g.amount)}**!\nPress **Claim Prize** or check your DMs. Claim time: **${claimText(g)}**.`,
      });
      return 'ok';
    }

    w.amount = 0;
    w.doubled = true;
    g.status = 'ended';
    store.save();
    const channel = await client.channels.fetch(g.channelId);
    const { g: child, msg: cmsg } = await launch({
      guildId: g.guildId, channelId: g.channelId, hostId: g.hostId, mode: 'doublekeep',
      amount: nextAmount(g), startAmount: g.startAmount, maxAmount: g.maxAmount, round: g.round + 1,
      chainId: g.chainId, parentId: g.id, durationMs: g.durationMs, claimMs: g.claimMs, decisionMs: g.decisionMs,
      paymentChannelId: g.paymentChannelId, requiredRoleId: g.requiredRoleId, pingRoleId: g.pingRoleId,
    }, channel);
    g.childId = child.id;
    store.save();
    await msg.edit(mainPayload(g)).catch(console.error);
    await msg.reply({
      content: `${DONUT} <@${w.userId}> has chosen **Double**!\nRound ${child.round} is live for **${amt(child.amount)}** (max ${amt(g.maxAmount)}): ${cmsg.url}`,
      allowedMentions: { users: [w.userId] },
    }).catch(console.error);
    return 'ok';
  } finally {
    busy.delete(g.id);
  }
}

async function resolveSos(g) {
  if (busy.has(g.id) || g.status !== 'deciding') return 'busy';
  busy.add(g.id);
  try {
    const msg = await fetchMsg(g).catch(() => null);
    if (!msg) { g.status = 'cancelled'; store.save(); return 'gone'; }
    const [a, b] = g.winners;
    a.choice = g.choices?.[a.userId] ?? 'split';
    b.choice = g.choices?.[b.userId] ?? 'split';
    [a.amount, b.amount] = sosOutcome(g.amount, a.choice, b.choice);
    store.save();

    for (const n of [3, 2, 1]) {
      await msg.edit({
        embeds: [new EmbedBuilder().setColor(COLORS.gold).setTitle(modeTitle(g))
          .setDescription(`**${a.ign}** and **${b.ign}** have locked in…\n\n# ${n}`)],
        components: [],
      }).catch(() => {});
      await sleep(Math.round(1100 * SPEED));
    }

    let result;
    if (a.choice === 'split' && b.choice === 'split') result = `Both split: **${amt(a.amount)}** each!`;
    else if (a.choice === 'steal' && b.choice === 'steal') result = 'Both stole, so **nobody** wins anything. 💀';
    else {
      const thief = a.choice === 'steal' ? a : b;
      result = `<@${thief.userId}> stole **${amt(thief.amount)}**!`;
    }
    await finalizeWin(g, msg, {
      announce: `${DONUT} **Split or Steal results**\n<@${a.userId}> chose **${cap(a.choice)}**\n<@${b.userId}> chose **${cap(b.choice)}**\n${result}`,
    });
    return 'ok';
  } finally {
    busy.delete(g.id);
  }
}

/** A doubled round got no entries: the player who doubled gets their prize back. */
async function restoreParent(child) {
  const p = db.giveaways[child.parentId];
  if (!p || p.decision !== 'double') return;
  const w = p.winners[0];
  w.doubled = false;
  w.amount = p.amount;
  w.choice = 'keep';
  p.decision = 'keep';
  p.childId = null;
  store.save();
  const pm = await fetchMsg(p).catch(() => null);
  if (!pm) return;
  await finalizeWin(p, pm, {
    announce: `${DONUT} Nobody entered round ${child.round}, so <@${w.userId}> keeps **${amt(p.amount)}**!\nPress **Claim Prize** or check your DMs.`,
  });
}

/* ───────────────────────── scheduler ───────────────────────── */

setInterval(() => {
  const now = Date.now();
  for (const g of Object.values(db.giveaways)) {
    if (g.status === 'running' && g.endsAt <= now) draw(g).catch(console.error);
    else if (g.status === 'deciding' && g.decideBy <= now && !busy.has(g.id)) {
      (g.mode === 'splitsteal' ? resolveSos(g) : resolveDok(g, 'keep')).catch(console.error);
    } else if (g.status === 'ended') {
      let changed = false;
      for (const w of g.winners) {
        if (pendingClaim(w) && w.claimBy && w.claimBy <= now) { w.expired = true; changed = true; updateDm(g, w); }
      }
      if (changed) { store.save(); editMain(g); }
    }
  }
}, 3000);

/* ───────────────────────── slash commands ───────────────────────── */

async function prepare(i, defaultDecisionMs) {
  const gs = guildSettings(i.guildId);
  const durationMs = parseDuration(i.options.getString('duration', true));
  if (!durationMs || durationMs < 10_000 || durationMs > 30 * 864e5) {
    await i.editReply('❌ Bad duration. Try `30m`, `1h30m` or `2d` (10s to 30d).');
    return null;
  }
  const claimMs = parseClaimTime(i.options.getString('claim_time', true));
  if (claimMs === null) {
    await i.editReply('❌ Bad claim time. Use `-1` for unlimited, or something like `5m`, `1h`, `2d` (min 10s).');
    return null;
  }
  let decisionMs = defaultDecisionMs;
  const dt = i.options.getString('decision_time');
  if (dt) {
    decisionMs = parseDuration(dt);
    if (!decisionMs || decisionMs < 10_000 || decisionMs > 36e5) {
      await i.editReply('❌ Bad decision time. Use `30s`, `5m` etc. (10s to 1h).');
      return null;
    }
  }
  if (Object.values(db.giveaways).filter((x) => x.guildId === i.guildId && x.status === 'running').length >= 25) {
    await i.editReply('❌ This server already has 25 running giveaways.');
    return null;
  }
  const me = i.guild.members.me;
  const paymentChannelId = i.options.getChannel('payment_channel')?.id ?? gs.paymentChannelId ?? i.channelId;
  const payCh = await client.channels.fetch(paymentChannelId).catch(() => null);
  const problems = [
    ...missingPerms(i.channel, me).map((p) => `${p} in <#${i.channelId}>`),
    ...(payCh && payCh.id !== i.channelId ? missingPerms(payCh, me).map((p) => `${p} in <#${payCh.id}>`) : []),
  ];
  if (problems.length) {
    await i.editReply(`❌ I'm missing permissions: ${problems.join(', ')}`);
    return null;
  }
  return {
    guildId: i.guildId, channelId: i.channelId, hostId: (i.options.getUser('host') ?? i.user).id,
    durationMs, claimMs, decisionMs, paymentChannelId,
    requiredRoleId: i.options.getRole('required_role')?.id ?? null,
    pingRoleId: i.options.getRole('ping_role')?.id ?? gs.pingRoleId ?? null,
    hint: gs.paymentChannelId ? '' : '\n💡 Run `/setup payment_channel:#channel` to set a default.',
  };
}

async function startReply(i, g, msg, hint) {
  await i.editReply(`✅ Giveaway \`${g.id}\` started → ${msg.url}\nClaim requests go to <#${g.paymentChannelId}>${hint}`);
}

const BAD_AMOUNT = '❌ Bad amount. Use numbers like `500k`, `1.5m`, `2b` (k = thousand, m = million, b = billion).';

async function cmdStart(i) {
  await i.deferReply({ flags: EPH });
  const amount = parseAmount(i.options.getString('amount', true));
  if (!amount) return i.editReply(BAD_AMOUNT);
  const base = await prepare(i, null);
  if (!base) return;
  const { hint, ...rest } = base;
  const { g, msg } = await launch({ ...rest, mode: 'standard', amount, winnersCount: i.options.getInteger('winners') ?? 1 }, i.channel);
  await startReply(i, g, msg, hint);
}

async function cmdSplitSteal(i) {
  await i.deferReply({ flags: EPH });
  const amount = parseAmount(i.options.getString('amount', true));
  if (!amount) return i.editReply(BAD_AMOUNT);
  const base = await prepare(i, 60_000);
  if (!base) return;
  const { hint, ...rest } = base;
  const { g, msg } = await launch({ ...rest, mode: 'splitsteal', amount, winnersCount: 2 }, i.channel);
  await startReply(i, g, msg, hint);
}

async function cmdDoubleKeep(i) {
  await i.deferReply({ flags: EPH });
  const start = parseAmount(i.options.getString('start_amount', true));
  const max = parseAmount(i.options.getString('max_amount', true));
  if (!start || !max) return i.editReply(BAD_AMOUNT);
  if (max <= start) return i.editReply('❌ The max has to be higher than the starting amount.');
  const base = await prepare(i, 300_000);
  if (!base) return;
  const { hint, ...rest } = base;
  const { g, msg } = await launch({ ...rest, mode: 'doublekeep', amount: start, startAmount: start, maxAmount: max }, i.channel);
  await startReply(i, g, msg, hint);
}

async function cmdSetup(i) {
  const gs = guildSettings(i.guildId);
  const ch = i.options.getChannel('payment_channel');
  const mgr = i.options.getRole('manager_role');
  const ping = i.options.getRole('ping_role');
  const warn = [];
  if (ch) {
    gs.paymentChannelId = ch.id;
    const miss = missingPerms(ch, i.guild.members.me);
    if (miss.length) warn.push(`⚠️ I'm missing **${miss.join(', ')}** in <#${ch.id}>.`);
  }
  if (mgr) gs.managerRoleId = mgr.id;
  if (ping) gs.pingRoleId = ping.id;
  if (ch || mgr || ping) store.save();
  const e = new EmbedBuilder().setColor(COLORS.pink).setTitle(`${DONUT} Server setup`)
    .addFields(
      { name: 'Payment channel', value: gs.paymentChannelId ? `<#${gs.paymentChannelId}>` : '*not set (uses the giveaway channel)*' },
      { name: 'Manager role', value: gs.managerRoleId ? `<@&${gs.managerRoleId}>` : '*not set (Manage Server only)*' },
      { name: 'Default ping role', value: gs.pingRoleId ? `<@&${gs.pingRoleId}>` : '*not set*' },
    )
    .setFooter({ text: 'Run /setup with options to change these' });
  return i.reply({ content: warn.join('\n') || undefined, embeds: [e], flags: EPH });
}

async function cmdEnd(i) {
  const g = resolveGiveaway(i.guildId, i.options.getString('id'), ['running']);
  if (!g) return i.reply({ content: '❌ No running giveaway found.', flags: EPH });
  await i.reply({ content: `${DONUT} Drawing \`${g.id}\` now…`, flags: EPH });
  draw(g).catch(console.error);
}

async function cmdReroll(i) {
  const g = resolveGiveaway(i.guildId, i.options.getString('id'), ['ended']);
  if (!g) return i.reply({ content: '❌ No ended giveaway found.', flags: EPH });
  if (g.mode && g.mode !== 'standard') return i.reply({ content: '❌ Reroll only works on normal giveaways.', flags: EPH });
  if (!Object.keys(g.entries).some((u) => !g.drawn.includes(u))) {
    return i.reply({ content: '❌ Everyone who entered was already drawn.', flags: EPH });
  }
  await i.reply({ content: `${DONUT} Rerolling \`${g.id}\`…`, flags: EPH });
  draw(g, { reroll: true }).catch(console.error);
}

async function cmdCancel(i) {
  const g = resolveGiveaway(i.guildId, i.options.getString('id'), ['running']);
  if (!g) return i.reply({ content: '❌ No running giveaway found.', flags: EPH });
  g.status = 'cancelled';
  store.save();
  try {
    await (await fetchMsg(g)).edit({
      embeds: [new EmbedBuilder().setColor(COLORS.red).setTitle(modeTitle(g)).setDescription('**This giveaway was cancelled.**')],
      components: [],
    });
  } catch { /* ignore */ }
  await i.reply({ content: `🛑 Cancelled \`${g.id}\`.`, flags: EPH });
}

async function cmdList(i) {
  const rows = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && ['running', 'deciding'].includes(g.status));
  const text = rows.length
    ? rows.map((g) => `\`${g.id}\` • ${g.mode ?? 'standard'} • **${amt(g.amount)}** • ${g.status === 'running' ? `ends <t:${ts(g.endsAt)}:R>` : 'waiting for a choice'} • ${Object.keys(g.entries).length} entries • ${msgUrl(g)}`).join('\n')
    : 'Nothing running.';
  await i.reply({ content: text, flags: EPH });
}

/* ───────────────────────── buttons / modals ───────────────────────── */

function tryEnter(g, userId, ign) {
  const taken = Object.entries(g.entries).find(([u, n]) => u !== userId && n.toLowerCase() === ign.toLowerCase());
  if (taken) return `⚠️ \`${ign}\` is already entered by someone else.`;
  g.entries[userId] = ign;
  store.save();
  refresh(g);
  return null;
}

function ignModal(id, prefill) {
  const input = new TextInputBuilder().setCustomId('ign').setLabel('Your DonutSMP IGN').setStyle(TextInputStyle.Short)
    .setMinLength(3).setMaxLength(17).setRequired(true).setPlaceholder('e.g. Notch');
  if (prefill) input.setValue(prefill);
  return new ModalBuilder().setCustomId(`gw:ign:${id}`).setTitle(`${DONUT} Enter giveaway`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function onEnter(i, g) {
  if (g.status !== 'running' || g.endsAt <= Date.now()) return i.reply({ content: '⌛ This giveaway has ended.', flags: EPH });
  if (g.requiredRoleId && !i.member.roles.cache.has(g.requiredRoleId)) {
    return i.reply({ content: `🔒 You need <@&${g.requiredRoleId}> to enter.`, flags: EPH });
  }
  if (g.entries[i.user.id]) {
    return i.reply({
      content: `You're already in as \`${g.entries[i.user.id]}\` ${DONUT}`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:leave:${g.id}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger))],
      flags: EPH,
    });
  }
  const saved = db.users[i.user.id]?.ign;
  if (!saved) return i.showModal(ignModal(g.id));
  const err = tryEnter(g, i.user.id, saved);
  return i.reply({ content: err ?? `${DONUT} Entered as \`${saved}\`. Wrong IGN? Use \`/ign\` and re-enter. Good luck!`, flags: EPH });
}

function findClaimWinner(i, g) {
  if (g.status !== 'ended') return { err: '❌ Nothing to claim yet.' };
  const w = g.winners.find((x) => x.userId === i.user.id && claimable(x));
  if (!w) return { err: '❌ Only the winner can claim this prize.' };
  if (w.claimed) return { err: '✅ You already claimed. The host has been pinged.' };
  if (w.expired || (w.claimBy && w.claimBy <= Date.now())) {
    if (!w.expired) { w.expired = true; store.save(); editMain(g); updateDm(g, w); }
    return { err: '⌛ The claim time ran out for this prize.' };
  }
  return { w };
}

async function onClaim(i, g) {
  const { w, err } = findClaimWinner(i, g);
  if (err) return i.reply({ content: err, flags: EPH });
  const input = new TextInputBuilder().setCustomId('ign').setLabel('Username to receive the prize').setStyle(TextInputStyle.Short)
    .setMinLength(3).setMaxLength(17).setRequired(true).setValue(w.ign);
  return i.showModal(new ModalBuilder().setCustomId(`gw:claimm:${g.id}`).setTitle(`${DONUT} Claim ${amt(w.amount)}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input)));
}

async function onClaimSubmit(i, g) {
  const { w, err } = findClaimWinner(i, g);
  if (err) return i.reply({ content: err, flags: EPH });
  const ign = i.fields.getTextInputValue('ign').trim();
  if (!IGN_RE.test(ign)) return i.reply({ content: '❌ That is not a valid Minecraft username. Press Claim and try again.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const ch = await client.channels.fetch(g.paymentChannelId).catch(() => null);
  if (!ch) return i.editReply('❌ I cannot access the payment channel. Tell an admin.');
  const oldIgn = w.ign;
  w.ign = ign;
  try {
    const sent = await ch.send({
      content: `<@${g.hostId}> ${DONUT} **${w.ign}** claimed **${amt(w.amount)}**, please pay up!`,
      embeds: [payEmbed(g, w)],
      components: [payRow(g, w)],
      allowedMentions: { users: [g.hostId] },
    });
    w.claimed = true;
    w.requestMessageId = sent.id;
    store.save();
  } catch (e) {
    console.error(e);
    w.ign = oldIgn;
    return i.editReply('❌ Could not post in the payment channel (missing permissions?).');
  }
  await i.editReply(`${DONUT} Claim sent! <@${g.hostId}> was pinged in <#${g.paymentChannelId}> to pay **${w.ign}**.`);
  editMain(g);
  updateDm(g, w);
}

async function onPaid(i, g, userId) {
  const w = g.winners.find((x) => x.userId === userId);
  if (!w) return i.reply({ content: '❌ Unknown winner.', flags: EPH });
  if (i.user.id !== g.hostId && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: '❌ Only the host can mark this as paid.', flags: EPH });
  }
  w.paid = true;
  store.save();
  await i.update({ content: '', embeds: [payEmbed(g, w)], components: [] });
  await i.channel.send({
    content: `${DONUT} <@${w.userId}> your **${amt(w.amount)}** was paid by <@${i.user.id}>. Enjoy!`,
    allowedMentions: { users: [w.userId] },
  }).catch(() => {});
  editMain(g);
  updateDm(g, w);
}

async function onDokChoice(i, g, choice) {
  if (g.mode !== 'doublekeep' || g.status !== 'deciding') return i.reply({ content: '⌛ This choice is already made.', flags: EPH });
  if (i.user.id !== g.winners[0].userId) return i.reply({ content: '❌ Only the winner can choose.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const r = await resolveDok(g, choice);
  await i.editReply(r === 'ok' ? `${DONUT} You chose **${cap(choice)}**.` : '⌛ This choice is already being processed.');
}

async function onSosChoice(i, g, choice) {
  if (g.mode !== 'splitsteal' || g.status !== 'deciding') return i.reply({ content: '⌛ This round is already over.', flags: EPH });
  if (!g.winners.some((w) => w.userId === i.user.id)) return i.reply({ content: '❌ Only the two picked players can choose.', flags: EPH });
  g.choices ??= {};
  if (g.choices[i.user.id]) return i.reply({ content: `🔒 You already locked in **${cap(g.choices[i.user.id])}**.`, flags: EPH });
  g.choices[i.user.id] = choice;
  store.save();
  await i.reply({ content: `🔒 Locked in **${cap(choice)}**. Nobody can see it until both players have chosen.`, flags: EPH });
  if (g.winners.every((w) => g.choices[w.userId])) resolveSos(g).catch(console.error);
  else editMain(g);
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'ign') {
        const name = i.options.getString('name', true).trim();
        if (!IGN_RE.test(name)) return i.reply({ content: '❌ That is not a valid Minecraft IGN.', flags: EPH });
        db.users[i.user.id] = { ign: name };
        store.save();
        return i.reply({ content: `${DONUT} IGN saved as \`${name}\``, flags: EPH });
      }
      if (i.commandName === 'forgetme') {
        delete db.users[i.user.id];
        for (const g of Object.values(db.giveaways)) {
          if (g.status === 'running' && g.entries[i.user.id]) { delete g.entries[i.user.id]; refresh(g); }
        }
        store.save();
        return i.reply({ content: `${DONUT} Your saved IGN was deleted and you were removed from running giveaways.`, flags: EPH });
      }
      if (i.commandName === 'setup') return cmdSetup(i);
      if (!canManage(i)) {
        return i.reply({ content: '🔒 You need **Manage Server** or the giveaway manager role (`/setup manager_role`).', flags: EPH });
      }
      const sub = i.options.getSubcommand();
      return ({
        start: cmdStart, splitsteal: cmdSplitSteal, doublekeep: cmdDoubleKeep,
        end: cmdEnd, reroll: cmdReroll, cancel: cmdCancel, list: cmdList,
      })[sub](i);
    }

    const isBtn = i.isButton();
    const isModal = i.isModalSubmit();
    if (!isBtn && !isModal) return;
    const [ns, action, id, extra] = i.customId.split(':');
    if (ns !== 'gw') return;
    const g = db.giveaways[id];
    if (!g) return i.reply({ content: '❌ That giveaway no longer exists.', flags: EPH });

    if (isModal && action === 'ign') {
      const ign = i.fields.getTextInputValue('ign').trim();
      if (!IGN_RE.test(ign)) return i.reply({ content: '❌ That is not a valid Minecraft IGN (3–16 chars, letters/numbers/_).', flags: EPH });
      if (g.status !== 'running') return i.reply({ content: '⌛ This giveaway has ended.', flags: EPH });
      db.users[i.user.id] = { ign };
      const err = tryEnter(g, i.user.id, ign);
      return i.reply({ content: err ?? `${DONUT} Entered as \`${ign}\`. Good luck!`, flags: EPH });
    }
    if (isModal && action === 'claimm') return onClaimSubmit(i, g);

    if (action === 'enter') return onEnter(i, g);
    if (action === 'claim') return onClaim(i, g);
    if (action === 'paid') return onPaid(i, g, extra);
    if (action === 'keep' || action === 'double') return onDokChoice(i, g, action);
    if (action === 'split' || action === 'steal') return onSosChoice(i, g, action);
    if (action === 'leave') {
      delete g.entries[i.user.id];
      store.save();
      refresh(g);
      return i.update({ content: 'You left the giveaway.', components: [] });
    }
    if (action === 'parts') {
      const list = Object.values(g.entries).map((n) => `\`${n}\``).join(' • ') || '*nobody yet*';
      return i.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.pink).setTitle(`${DONUT} Participants (${Object.keys(g.entries).length})`).setDescription(list.slice(0, 4000))],
        flags: EPH,
      });
    }
  } catch (e) {
    console.error(e);
    const p = { content: 'Something broke 🍩💥', flags: EPH };
    if (i.isRepliable()) (i.deferred || i.replied ? i.followUp(p) : i.reply(p)).catch(() => {});
  }
});

/* ───────────────────────── boot ───────────────────────── */

client.once('clientReady', async () => {
  console.log(`${DONUT} Logged in as ${client.user.tag}`);
  const rest = new REST().setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(client.user.id, GUILD_ID) : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands.map((c) => c.toJSON()) });
  console.log('Slash commands registered.');
  console.log(`Invite: ${client.generateInvite({
    scopes: ['bot', 'applications.commands'],
    permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory],
  })}`);
  client.user.setPresence({ activities: [{ name: `${DONUT} giveaways` }] });
  for (const g of Object.values(db.giveaways)) {
    if (g.status === 'drawing') draw(g, { resume: true }).catch(console.error);
  }
});

client.on('guildDelete', (guild) => {
  delete db.guilds[guild.id];
  for (const [k, g] of Object.entries(db.giveaways)) if (g.guildId === guild.id) delete db.giveaways[k];
  store.save();
});

// keep db.json small: drop finished giveaways after 30 days
setInterval(() => {
  const cutoff = Date.now() - 30 * 864e5;
  for (const [k, g] of Object.entries(db.giveaways)) {
    if ((g.status === 'ended' || g.status === 'cancelled') && g.createdAt < cutoff) delete db.giveaways[k];
  }
  store.save();
}, 6 * 36e5);

process.on('unhandledRejection', (e) => console.error(e));
client.login(TOKEN);
