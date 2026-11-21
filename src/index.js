import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, PermissionFlagsBits,
  ChannelType, MessageFlags, REST, Routes, InteractionContextType,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { GUILD_ID, TOKEN, DONUT, EMOJI, COLORS } from './config.js';
import * as store from './store.js';
import { parseDuration, shuffle, isMoney, IGN_RE } from './util.js';
import { spin } from './roulette.js';
import { startServer, startKeepAlive } from './server.js';

const EPH = MessageFlags.Ephemeral;
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
store.load();
const db = store.db;

// Health endpoint for Render/hosting panels (and to keep a free instance awake).
startServer(() => ({ bot: client.isReady() ? client.user.tag : null, giveaways: Object.keys(db.giveaways).length }));
startKeepAlive();
const busy = new Set();

/* ───────────────────────── commands ───────────────────────── */

const idOpt = (o) => o.setName('id').setDescription('Giveaway ID (defaults to the latest)');

const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription(`${DONUT} DonutSMP giveaways`)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('e.g. 5m, 500k, Elytra').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 30m, 1h30m, 2d').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(10))
      .addUserOption((o) => o.setName('host').setDescription('Who pays the prize (default: you)'))
      .addChannelOption((o) => o.setName('payment_channel').setDescription('Where claim requests are posted')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addRoleOption((o) => o.setName('required_role').setDescription('Role needed to enter'))
      .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping')))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('reroll').setDescription('Reroll unclaimed winners').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a giveaway').addStringOption(idOpt))
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

/* ───────────────────────── helpers ───────────────────────── */

const ts = (ms) => Math.floor(ms / 1000);
const msgUrl = (g) => `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
const statusIcon = (w) => (w.paid ? '💸 paid' : w.claimed ? '✅ claimed' : '⏳ unclaimed');
const pickN = (pool, n) => shuffle(pool).slice(0, n);
const mkWinner = ([userId, ign]) => ({ userId, ign, claimed: false, paid: false });

async function fetchMsg(g) {
  const ch = await client.channels.fetch(g.channelId);
  return ch.messages.fetch(g.messageId);
}

function resolveGiveaway(guildId, id, statuses) {
  const all = Object.values(db.giveaways).filter((g) => g.guildId === guildId && statuses.includes(g.status));
  if (id) return all.find((g) => g.id === id.trim() || g.messageId === id.trim());
  return all.sort((a, b) => b.createdAt - a.createdAt)[0];
}

const guildSettings = (guildId) => (db.guilds[guildId] ??= {});
const canManage = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  || (guildSettings(i.guildId).managerRoleId && i.member.roles.cache.has(guildSettings(i.guildId).managerRoleId));

const NEEDED = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links'], ['ReadMessageHistory', 'Read Message History']];
const missingPerms = (ch, me) => {
  const p = ch.permissionsFor(me);
  return NEEDED.filter(([f]) => !p?.has(PermissionFlagsBits[f])).map(([, n]) => n);
};

/* ───────────────────────── embeds & buttons ───────────────────────── */

function runningEmbed(g) {
  const t = ts(g.endsAt);
  return new EmbedBuilder()
    .setColor(COLORS.pink)
    .setTitle(`${DONUT} ${g.prize}`)
    .setDescription([
      `Click the ${DONUT} button to enter!`,
      `Winners: **${g.winnersCount}**`,
      `Ends: <t:${t}:R> (<t:${t}:f>)`,
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

function endedEmbed(g) {
  const lines = g.winners.length
    ? g.winners.map((w) => `🏆 **${w.ign}** (<@${w.userId}>) — ${statusIcon(w)}`)
    : ['*No valid entries — nobody won.*'];
  return new EmbedBuilder()
    .setColor(g.winners.length ? COLORS.gold : COLORS.red)
    .setTitle(`${DONUT}  ${g.prize}  ${DONUT}`)
    .setDescription([
      '**Giveaway ended**', '', ...lines, '',
      `**Hosted by** <@${g.hostId}>`,
      `**Entries** ${Object.keys(g.entries).length}`,
    ].join('\n'))
    .setFooter({ text: `DonutSMP Giveaways • ID ${g.id}` });
}

const endedRow = (g) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:claim:${g.id}`).setLabel('Claim Prize').setEmoji('🎁').setStyle(ButtonStyle.Primary)
    .setDisabled(!g.winners.some((w) => !w.claimed)),
  new ButtonBuilder().setCustomId(`gw:parts:${g.id}`).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary),
);

async function updateEnded(g) {
  try { await (await fetchMsg(g)).edit({ embeds: [endedEmbed(g)], components: [endedRow(g)] }); } catch { /* msg gone */ }
}

const pending = new Map();
function refresh(g) {
  if (pending.has(g.id)) return;
  pending.set(g.id, setTimeout(async () => {
    pending.delete(g.id);
    if (g.status !== 'running') return;
    try { await (await fetchMsg(g)).edit({ embeds: [runningEmbed(g)], components: [runningRow(g)] }); } catch { /* ignore */ }
  }, 2500));
}

function payEmbed(g, w) {
  const how = isMoney(g.prize)
    ? `Run this in-game:\n\`\`\`/pay ${w.ign} ${g.prize.replace(/^\$/, '')}\`\`\``
    : `Hand **${g.prize}** to \`${w.ign}\` in-game.`;
  return new EmbedBuilder()
    .setColor(w.paid ? COLORS.green : COLORS.pink)
    .setTitle(`${DONUT}  ${w.paid ? 'Payment Completed' : 'Payment Request'}`)
    .setDescription(how)
    .addFields(
      { name: 'Winner', value: `\`${w.ign}\`\n<@${w.userId}>`, inline: true },
      { name: 'Host', value: `<@${g.hostId}>`, inline: true },
      { name: 'Prize', value: g.prize, inline: true },
      { name: 'Giveaway', value: `[jump](${msgUrl(g)})`, inline: true },
    )
    .setFooter({ text: w.paid ? 'Paid ✅' : 'Host: press the button once you have paid' });
}

const payRow = (g, w) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:paid:${g.id}:${w.userId}`).setLabel('Mark as Paid').setEmoji('✅').setStyle(ButtonStyle.Success),
);

/* ───────────────────────── drawing ───────────────────────── */

async function draw(g, { reroll = false, resume = false } = {}) {
  if (busy.has(g.id)) return 'busy';
  busy.add(g.id);
  try {
    const msg = await fetchMsg(g).catch(() => null);
    if (!msg) { g.status = 'cancelled'; store.save(); return 'gone'; }

    if (!resume) {
      if (reroll) {
        const kept = g.winners.filter((w) => w.claimed);
        const pool = Object.entries(g.entries).filter(([u]) => !g.drawn.includes(u));
        if (!pool.length) return 'nopool';
        const chosen = pickN(pool, Math.max(1, g.winnersCount - kept.length)).map(mkWinner);
        g.winners = [...kept, ...chosen];
        g.drawn.push(...chosen.map((w) => w.userId));
        g.animate = chosen.map((w) => w.userId);
      } else {
        const chosen = pickN(Object.entries(g.entries), g.winnersCount).map(mkWinner);
        g.winners = chosen;
        g.drawn = chosen.map((w) => w.userId);
        g.animate = g.drawn.slice();
      }
      g.status = 'drawing';
      store.save();
    }

    const names = Object.values(g.entries);
    if (!resume && g.animate.length && names.length > 1) {
      const locked = g.winners.filter((w) => !g.animate.includes(w.userId))
        .map((w) => `🏆 **${w.ign}**`);
      for (let k = 0; k < g.animate.length; k++) {
        const w = g.winners.find((x) => x.userId === g.animate[k]);
        await spin({ message: msg, prize: g.prize, names, winnerIgn: w.ign, index: k + 1, total: g.animate.length, locked: [...locked] });
        locked.push(`🏆 **${w.ign}**`);
      }
    }

    const fresh = g.animate.slice();
    g.status = 'ended';
    g.animate = [];
    store.save();
    await msg.edit({ embeds: [endedEmbed(g)], components: [endedRow(g)] }).catch(console.error);
    if (fresh.length) {
      await msg.reply({
        content: `🎉 Congratulations ${fresh.map((u) => `<@${u}>`).join(' ')}! You won **${g.prize}** ${DONUT}\nPress **Claim Prize** and the host will be asked to pay you.`,
        allowedMentions: { users: fresh },
      }).catch(console.error);
    }
    return 'ok';
  } finally {
    busy.delete(g.id);
  }
}

setInterval(() => {
  for (const g of Object.values(db.giveaways)) {
    if (g.status === 'running' && g.endsAt <= Date.now()) draw(g).catch(console.error);
  }
}, 3000);

/* ───────────────────────── slash commands ───────────────────────── */

async function cmdStart(i) {
  await i.deferReply({ flags: EPH });
  const prize = i.options.getString('prize', true).slice(0, 100);
  const ms = parseDuration(i.options.getString('duration', true));
  if (!ms || ms < 10_000 || ms > 30 * 864e5) {
    return i.editReply('❌ Bad duration. Try `30m`, `1h30m` or `2d` (10s – 30d).');
  }
  const gs = guildSettings(i.guildId);
  if (Object.values(db.giveaways).filter((x) => x.guildId === i.guildId && x.status === 'running').length >= 25) {
    return i.editReply('❌ This server already has 25 running giveaways.');
  }
  const me = i.guild.members.me;
  const payId = i.options.getChannel('payment_channel')?.id ?? gs.paymentChannelId ?? i.channelId;
  const payCh = await client.channels.fetch(payId).catch(() => null);
  const problems = [
    ...missingPerms(i.channel, me).map((p) => `${p} in <#${i.channelId}>`),
    ...(payCh && payCh.id !== i.channelId ? missingPerms(payCh, me).map((p) => `${p} in <#${payCh.id}>`) : []),
  ];
  if (problems.length) return i.editReply(`❌ I'm missing permissions: ${problems.join(', ')}`);
  const host = i.options.getUser('host') ?? i.user;
  const ping = i.options.getRole('ping_role') ?? (gs.pingRoleId ? { id: gs.pingRoleId } : null);
  const g = {
    id: randomUUID().slice(0, 8),
    guildId: i.guildId,
    channelId: i.channelId,
    messageId: null,
    hostId: host.id,
    prize,
    winnersCount: i.options.getInteger('winners') ?? 1,
    endsAt: Date.now() + ms,
    createdAt: Date.now(),
    status: 'running',
    entries: {},
    winners: [],
    drawn: [],
    animate: [],
    paymentChannelId: payId,
    requiredRoleId: i.options.getRole('required_role')?.id ?? null,
  };
  const msg = await i.channel.send({
    content: ping ? `<@&${ping.id}>` : undefined,
    embeds: [runningEmbed(g)],
    components: [runningRow(g)],
    allowedMentions: { roles: ping ? [ping.id] : [] },
  });
  g.messageId = msg.id;
  db.giveaways[g.id] = g;
  store.save();
  await i.editReply(`✅ Giveaway \`${g.id}\` started → ${msg.url}\nClaim requests go to <#${g.paymentChannelId}>${gs.paymentChannelId ? '' : '\n💡 Run `/setup payment_channel:#channel` to set a default.'}`);
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
  if (!g.entries || !Object.keys(g.entries).length) return i.reply({ content: '❌ That giveaway had no entries.', flags: EPH });
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
      embeds: [new EmbedBuilder().setColor(COLORS.red).setTitle(`${DONUT}  ${g.prize}`).setDescription('**This giveaway was cancelled.**')],
      components: [],
    });
  } catch { /* ignore */ }
  await i.reply({ content: `🛑 Cancelled \`${g.id}\`.`, flags: EPH });
}

async function cmdList(i) {
  const rows = Object.values(db.giveaways).filter((g) => g.guildId === i.guildId && g.status === 'running');
  const text = rows.length
    ? rows.map((g) => `\`${g.id}\` • **${g.prize}** • ends <t:${ts(g.endsAt)}:R> • ${Object.keys(g.entries).length} entries • ${msgUrl(g)}`).join('\n')
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
  const w = g.winners.find((x) => x.userId === i.user.id);
  if (!w) return { err: '❌ You are not a winner of this giveaway.' };
  if (w.claimed) return { err: '✅ You already claimed. The host has been pinged.' };
  return { w };
}

async function onClaim(i, g) {
  const { w, err } = findClaimWinner(i, g);
  if (err) return i.reply({ content: err, flags: EPH });
  const input = new TextInputBuilder().setCustomId('ign').setLabel('Username to receive the prize').setStyle(TextInputStyle.Short)
    .setMinLength(3).setMaxLength(17).setRequired(true).setValue(w.ign);
  return i.showModal(new ModalBuilder().setCustomId(`gw:claimm:${g.id}`).setTitle(`${DONUT} Claim ${g.prize}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input)));
}

async function onClaimSubmit(i, g) {
  const { w, err } = findClaimWinner(i, g);
  if (err) return i.reply({ content: err, flags: EPH });
  const ign = i.fields.getTextInputValue('ign').trim();
  if (!IGN_RE.test(ign)) return i.reply({ content: '❌ That is not a valid Minecraft username. Press Claim Prize and try again.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const ch = await client.channels.fetch(g.paymentChannelId).catch(() => null);
  if (!ch) return i.editReply('❌ I cannot access the payment channel. Tell an admin.');
  const oldIgn = w.ign;
  w.ign = ign;
  try {
    const sent = await ch.send({
      content: `<@${g.hostId}> ${DONUT} **${w.ign}** claimed **${g.prize}**, please pay up!`,
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
  updateEnded(g);
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
    content: `${DONUT} <@${w.userId}> your **${g.prize}** was paid by <@${i.user.id}>. Enjoy!`,
    allowedMentions: { users: [w.userId] },
  }).catch(() => {});
  updateEnded(g);
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
      return ({ start: cmdStart, end: cmdEnd, reroll: cmdReroll, cancel: cmdCancel, list: cmdList })[sub](i);
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

// keep db.json small: drop finished giveaways after 30 days
setInterval(() => {
  const cutoff = Date.now() - 30 * 864e5;
  for (const [k, g] of Object.entries(db.giveaways)) {
    if ((g.status === 'ended' || g.status === 'cancelled') && g.createdAt < cutoff) delete db.giveaways[k];
  }
  store.save();
}, 6 * 36e5);

client.on('guildDelete', (guild) => {
  delete db.guilds[guild.id];
  for (const [k, g] of Object.entries(db.giveaways)) if (g.guildId === guild.id) delete db.giveaways[k];
  store.save();
});

process.on('unhandledRejection', (e) => console.error(e));

// Hosting panels stop the process with SIGTERM: save pending changes before exiting.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { store.flush(); } catch (e) { console.error(e); }
    client.destroy();
    process.exit(0);
  });
}

client.login(TOKEN);
