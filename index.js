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
  const clicks = await gms.getYesterdayClicks(links.map(l => l.id));
  // Un lien absent des métriques n'a eu aucune visite hier
  const entries = links.map(l => ({ va: l.va, clicks: clicks.get(l.id) ?? 0 }));
  await postReport(client, process.env.GMS_REPORT_CHANNEL_ID, '🐦 Rapport Twitter', entries);
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

// ── Commandes admin : !rapport (Insta), !rapport-twitter, !gms-test ─────────
function isAdmin(message) {
  return message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
}

function codeBlocks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push('```\n' + text.slice(i, i + 1900) + '\n```');
  return chunks;
}

// Temporaire : clics d'hier lien par lien, pour comparer au tableau de bord GMS
async function gmsTest(message) {
  const links = await gms.getLinks();
  const clicks = await gms.getYesterdayClicks(links.map(l => l.id));

  const rows = links
    .map(l => ({ ...l, clicks: clicks.get(l.id) }))
    .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1));
  const found = rows.filter(r => r.clicks !== undefined).length;

  const out = `LIENS ACTIFS : ${links.length} — stats trouvées pour ${found}\n`
    + `PÉRIODE : ${JSON.stringify(gms.yesterdayParams())}\n\n`
    + rows.map(r => `${r.va ?? '❓ Sans VA'} (${r.label}) = ${r.clicks ?? 'absent'}`).join('\n');

  for (const chunk of codeBlocks(out).slice(0, 4)) {
    await message.channel.send(chunk);
  }
}

const COMMANDS = {
  '!rapport': client => sendGamlReport(client),
  '!rapport-twitter': client => sendGmsReport(client),
};

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const command = message.content.trim();
  if (!COMMANDS[command] && command !== '!gms-test') return;
  if (!isAdmin(message)) {
    return message.reply({ content: '❌ Réservé aux admins.' });
  }

  try {
    if (command === '!gms-test') return await gmsTest(message);
    await message.reply('⏳ Génération du rapport...');
    await COMMANDS[command](client);
  } catch (err) {
    console.error(`[${command}] Erreur:`, err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
