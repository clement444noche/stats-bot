// =============================================
//   index.js — Bot Discord : rapport quotidien des clics GAML
// =============================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, PermissionsBitField,
} = require('discord.js');
const cron = require('node-cron');
const { getLinks, getYesterdayClicks } = require('./gaml');

// ── Label "Hier (29 sept.)" en heure de Paris ────────────────────────────────
function yesterdayLabel() {
  const d = new Date(Date.now() - 86400000);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
}

// ── Rapport quotidien automatique ────────────────────────────────────────────
async function sendDailyReport(client) {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Daily Report] REPORT_CHANNEL_ID non défini, rapport annulé.');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error('[Daily Report] Salon introuvable :', channelId);
    return;
  }

  const links = await getLinks();
  const results = [];

  for (const link of links) {
    try {
      const clicks = await getYesterdayClicks(link.id);
      results.push({ name: link.name, clicks });
    } catch (err) {
      console.error(`[Daily Report] Erreur pour ${link.name}:`, err.message);
      results.push({ name: link.name, clicks: null });
    }
  }

  // Tri par clics décroissants (les erreurs en bas)
  results.sort((a, b) => {
    if (a.clicks === null) return 1;
    if (b.clicks === null) return -1;
    return b.clicks - a.clicks;
  });

  const teamTotal = results.reduce((sum, r) => sum + (r.clicks ?? 0), 0);

  const lines = results.map(r => {
    if (r.clicks === null) return `👤 **${r.name}** → ❌ erreur`;
    return `👤 **${r.name}** → ${r.clicks} clic${r.clicks !== 1 ? 's' : ''}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📊 Rapport quotidien — Hier (${yesterdayLabel()})`)
    .setDescription(lines.join('\n') || '_Aucun lien actif_')
    .setColor(0x57F287)
    .setFooter({ text: `Total équipe : ${teamTotal} clics` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`[Daily Report] Rapport envoyé — ${teamTotal} clics équipe`);
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
  console.log(`📡 Serveurs : ${client.guilds.cache.size}`);

  // ── Cron : rapport quotidien à 8h heure de Paris ────────────────────────
  cron.schedule('0 8 * * *', () => {
    console.log('[Cron] Déclenchement du rapport quotidien...');
    sendDailyReport(client).catch(err =>
      console.error('[Cron] Erreur rapport quotidien:', err)
    );
  }, {
    timezone: 'Europe/Paris',
  });

  console.log('⏰ Rapport quotidien programmé à 8h (Paris)');
});

// ── Commande !rapport (admin uniquement, test manuel) ───────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content !== '!rapport') return;
  if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply({ content: '❌ Réservé aux admins.' });
  }

  await message.reply('⏳ Génération du rapport...');
  try {
    await sendDailyReport(client);
  } catch (err) {
    console.error('[!rapport] Erreur:', err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
