// =============================================
//   index.js — Bot Discord : rapports quotidiens des clics
//   GetAllMyLinks (VAs Insta) et GetMySocial (VAs Twitter)
// =============================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, PermissionsBitField,
} = require('discord.js');
const cron = require('node-cron');
const gaml = require('./gaml');
const gms = require('./gms');

// ── Label "Hier (29 sept.)" en heure de Paris ────────────────────────────────
function yesterdayLabel() {
  const d = new Date(Date.now() - 86400000);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
}

// ── Clics par VA → message Discord ───────────────────────────────────────────
// entries : [{ va, clicks }] avec clicks = null si erreur pour ce lien
async function postReport(client, channelId, title, entries) {
  if (!channelId) {
    console.warn(`[${title}] Salon non défini, rapport annulé.`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[${title}] Salon introuvable :`, channelId);
    return;
  }

  // Clics additionnés par VA (un VA peut avoir plusieurs liens)
  const byVA = new Map();
  for (const { va, clicks } of entries) {
    const name = va ?? '❓ Sans VA';
    const entry = byVA.get(name) ?? { name, clicks: 0, errors: 0 };
    if (clicks === null) entry.errors++;
    else entry.clicks += clicks;
    byVA.set(name, entry);
  }

  const results = [...byVA.values()].map(e => ({
    name: e.name,
    // Tous les liens du VA en erreur → erreur ; sinon on garde ce qui a répondu
    clicks: e.errors && e.clicks === 0 ? null : e.clicks,
  }));

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
    .setTitle(`${title} — Hier (${yesterdayLabel()})`)
    .setDescription(lines.join('\n') || '_Aucun lien actif_')
    .setColor(0x57F287)
    .setFooter({ text: `Total équipe : ${teamTotal} clics` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`[${title}] Rapport envoyé — ${teamTotal} clics équipe`);
}

// ── Rapport GetAllMyLinks (VAs Insta) → salon #clics ─────────────────────────
async function sendGamlReport(client) {
  const links = await gaml.getLinks();
  const entries = [];
  for (const link of links) {
    try {
      entries.push({ va: link.va, clicks: await gaml.getYesterdayClicks(link.id) });
    } catch (err) {
      console.error(`[GAML] Erreur pour ${link.va} (${link.label}):`, err.message);
      entries.push({ va: link.va, clicks: null });
    }
  }
  await postReport(client, process.env.REPORT_CHANNEL_ID, '📊 Rapport quotidien', entries);
}

// ── Rapport GetMySocial (VAs Twitter) → salon Twitter ───────────────────────
async function sendGmsReport(client) {
  const links = await gms.getLinks();
  // Uniquement les clics venant des US, du UK, d'Australie et du Canada
  const clicks = await gms.getYesterdayTargetClicks(links.map(l => l.id));
  // null = erreur GetMySocial pour ce lien (affichée « ❌ erreur »)
  const entries = links.map(l => ({ va: l.va, clicks: clicks.get(l.id) ?? null }));
  await postReport(client, process.env.GMS_REPORT_CHANNEL_ID, '🐦 Rapport Twitter (🇺🇸🇬🇧🇦🇺🇨🇦)', entries);
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

  // ── Cron : rapports quotidiens à 8h heure de Paris ──────────────────────
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Déclenchement des rapports quotidiens...');
    await sendGamlReport(client).catch(err => console.error('[Cron] Erreur rapport GAML:', err));
    await sendGmsReport(client).catch(err => console.error('[Cron] Erreur rapport GMS:', err));
  }, {
    timezone: 'Europe/Paris',
  });

  console.log('⏰ Rapports quotidiens programmés à 8h (Paris)');
});

// ── Commandes admin : !rapport (Insta), !rapport-twitter ────────────────────
function isAdmin(message) {
  return message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
}

const COMMANDS = {
  '!rapport': client => sendGamlReport(client),
  '!rapport-twitter': client => sendGmsReport(client),
};

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const command = message.content.trim();
  if (!COMMANDS[command]) return;
  if (!isAdmin(message)) {
    return message.reply({ content: '❌ Réservé aux admins.' });
  }

  try {
    await message.reply('⏳ Génération du rapport...');
    await COMMANDS[command](client);
  } catch (err) {
    console.error(`[${command}] Erreur:`, err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
