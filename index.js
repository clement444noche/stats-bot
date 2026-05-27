// =============================================
//   index.js — Bot Discord Stats GAML
// =============================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, Events, PermissionsBitField,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const config = require('./config');
const { getStats } = require('./gaml');

// ── Chargement des VAs ──────────────────────────────────────────────────────
function getVAs() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'vas.json'), 'utf8'));
}

// ── Helpers visuels ─────────────────────────────────────────────────────────
const FLAG = code =>
  [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');

function qualityLabel(pct) {
  for (const { min, label } of config.qualityLabels) {
    if (pct >= min) return label;
  }
  return 'faible ⚠️';
}

function rangeLabel(range) {
  return { cycle: 'Cycle', today: "Aujourd'hui", yesterday: 'Hier', '7days': '7 jours', '14days': '14 jours' }[range] ?? range;
}

function formatDate(isoStr) {
  const [y, m, d] = isoStr.split('-');
  return `${d}/${m}/${y}`;
}

// ── Construction de l'embed ─────────────────────────────────────────────────
function buildEmbed(data, vaName, range) {
  const { countries, cycle } = data;

  // Calcul bons/mauvais clics depuis les pays
  let totalClicks = 0, goodClicks = 0;
  const countryRows = [];

  for (const row of countries) {
    const count  = row.totalVisits ?? row.count ?? 0;
    const code   = (row.country ?? row.countryCode ?? '').toUpperCase();
    const isGood = config.tier1Countries.includes(code);
    totalClicks += count;
    if (isGood) goodClicks += count;
    if (code) countryRows.push({ code, count, isGood });
  }

  const badClicks  = totalClicks - goodClicks;
  const goodPct    = totalClicks ? Math.round((goodClicks / totalClicks) * 100) : 0;
  const badPct     = totalClicks ? 100 - goodPct : 0;
  const quality    = qualityLabel(goodPct);

  // Seuil de paiement
  const { thresholdClicks, amountOnThreshold } = config.payment;
  const remaining  = Math.max(0, thresholdClicks - goodClicks);
  const amount     = goodClicks >= thresholdClicks ? amountOnThreshold : 0;

  // Tri pays par count desc, top 6
  countryRows.sort((a, b) => b.count - a.count);
  const topCountries = countryRows.slice(0, 6);

  // Titre & date
  let title = `📊 Stats — ${rangeLabel(range)}`;
  let dateStr = '';
  let paymentLine = '';

  if (cycle) {
    title = '📊 Stats du cycle en cours';
    dateStr = `📅 ${formatDate(cycle.start)} → ${formatDate(cycle.end)} (${cycle.dayInCycle}/${cycle.totalDays}j)\n`;
    paymentLine = `\n📅 **Paiement prévu :** ${formatDate(cycle.paymentDate)} (le lendemain du dernier jour du cycle)`;
  }

  // Description
  const paysBlock = topCountries.length
    ? topCountries.map(r => {
        const pct = totalClicks ? Math.round((r.count / totalClicks) * 100) : 0;
        return `${FLAG(r.code)} ${r.code} – ${r.count} (${pct}%) ${r.isGood ? '🟢' : '🔴'}`;
      }).join('\n')
    : '_Aucune donnée_';

  const description = [
    dateStr,
    `• **Bons clics :** ${goodClicks} (${goodPct}%)`,
    `• **Mauvais clics :** ${badClicks} (${badPct}%)`,
    `• **Qualité :** ${quality} (${goodPct}% bons)`,
    '',
    '🌍 **Classement pays :**',
    paysBlock,
    '',
    `💰 **Clics payables :** ${goodClicks}`,
    `💵 **Montant actuel :** ${amount}$`,
    remaining > 0
      ? `📈 **Encore ${remaining} clics payables pour débloquer ${amountOnThreshold}$**`
      : `✅ **Seuil atteint ! Paiement de ${amountOnThreshold}$ débloqué**`,
    paymentLine,
  ].filter(l => l !== undefined).join('\n');

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(goodPct >= 90 ? 0x5865F2 : goodPct >= 75 ? 0x57F287 : goodPct >= 50 ? 0xFEE75C : 0xED4245)
    .setFooter({ text: `VA : ${vaName}` })
    .setTimestamp();
}

// ── Construction des boutons ─────────────────────────────────────────────────
function buildButtons(activeRange) {
  const ranges = ['cycle', 'today', 'yesterday', '7days', '14days'];
  const labels = { cycle: 'Cycle', today: "Aujourd'hui", yesterday: 'Hier', '7days': '7 jours', '14days': '14 jours' };

  const row1 = new ActionRowBuilder().addComponents(
    ...['cycle', 'today', 'yesterday'].map(r =>
      new ButtonBuilder()
        .setCustomId(`range_${r}`)
        .setLabel(labels[r])
        .setStyle(r === activeRange ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  const row2 = new ActionRowBuilder().addComponents(
    ...['7days', '14days'].map(r =>
      new ButtonBuilder()
        .setCustomId(`range_${r}`)
        .setLabel(labels[r])
        .setStyle(r === activeRange ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ),
    new ButtonBuilder()
      .setCustomId('send_dm')
      .setLabel('📩 Envoyer en DM')
      .setStyle(ButtonStyle.Success)
  );

  return [row1, row2];
}

// ── Affichage des stats ──────────────────────────────────────────────────────
async function showStats(interaction, va, range, editReply = false) {
  try {
    const data = await getStats(va.linkId, range, config.cycle);
    const embed = buildEmbed(data, va.name, range);
    const rows  = buildButtons(range);
    const payload = { embeds: [embed], components: rows };

    if (editReply) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (err) {
    console.error('[GAML Error]', err);
    const msg = `❌ Erreur lors de la récupération des stats :\n\`${err.message}\``;
    if (editReply) {
      await interaction.editReply({ content: msg, embeds: [], components: [] });
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
}

// ── Client Discord ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📡 Salons accessibles : ${client.guilds.cache.size} serveur(s)`);
});

// ── Commande !setup (admin uniquement) ──────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content !== '!setup') return;
  if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('consult_clicks')
      .setLabel('Consulter mes clics')
      .setStyle(ButtonStyle.Primary)
  );

  await message.channel.send({
    content: '**Bienvenue dans le salon de consultation des clics.**\nClique sur le bouton ci-dessous pour ouvrir ton panneau perso.',
    components: [row],
  });

  await message.delete().catch(() => {});
});

// ── Interactions (boutons) ───────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const userId = interaction.user.id;
  const vas    = getVAs();
  const va     = vas[userId];

  if (!va) {
    return interaction.reply({
      content: '❌ Tu n\'es pas enregistré comme VA. Contacte un admin.',
      ephemeral: true,
    });
  }

  const { customId } = interaction;

  // ── Bouton principal "Consulter mes clics"
  if (customId === 'consult_clicks') {
    await interaction.deferReply({ ephemeral: true });
    return showStats(interaction, va, 'cycle', true);
  }

  // ── Boutons de range (cycle, today, yesterday, 7days, 14days)
  if (customId.startsWith('range_')) {
    const range = customId.replace('range_', '');
    await interaction.deferReply({ ephemeral: true });
    return showStats(interaction, va, range, true);
  }

  // ── Bouton "Envoyer en DM"
  if (customId === 'send_dm') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data  = await getStats(va.linkId, 'cycle', config.cycle);
      const embed = buildEmbed(data, va.name, 'cycle');
      await interaction.user.send({ embeds: [embed] });
      await interaction.editReply({ content: '✅ Stats envoyées en DM !', embeds: [], components: [] });
    } catch (err) {
      await interaction.editReply({ content: `❌ Impossible d'envoyer le DM : \`${err.message}\`` });
    }
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
