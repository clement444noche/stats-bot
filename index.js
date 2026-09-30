// =============================================
//   index.js — Bot Discord : rapport quotidien des clics GAML
// =============================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, PermissionsBitField,
} = require('discord.js');
const cron = require('node-cron');
const { getLinks, getYesterdayClicks } = require('./gaml');
const gms = require('./gms');

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

  // Clics additionnés par VA (un VA peut avoir plusieurs liens)
  const byVA = new Map();
  for (const link of links) {
    const name = link.va ?? '❓ Sans VA';
    const entry = byVA.get(name) ?? { name, clicks: 0, errors: 0 };
    try {
      entry.clicks += await getYesterdayClicks(link.id);
    } catch (err) {
      console.error(`[Daily Report] Erreur pour ${name} (${link.label}):`, err.message);
      entry.errors++;
    }
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

// ── Commande !gms-test (admin, temporaire) : explore l'API GetMySocial ──────
function codeBlocks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push('```\n' + text.slice(i, i + 1900) + '\n```');
  return chunks;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content !== '!gms-test') return;
  if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply({ content: '❌ Réservé aux admins.' });
  }

  try {
    const tools = await gms.listTools();
    const toolsText = tools.map(t =>
      `${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(', ')})`
    ).join('\n');

    let sample = '';
    const listTool = tools.find(t => /list.*link|links.*list|search.*link/i.test(t.name));
    if (listTool) {
      const data = await gms.callTool(listTool.name, {});
      const items = Array.isArray(data) ? data : (data?.links ?? data?.items ?? data?.data ?? data);
      const first = Array.isArray(items) ? items.slice(0, 2) : items;
      sample = `\n\n--- ${listTool.name} (exemple) ---\n` + JSON.stringify(first, null, 1);
    }

    for (const chunk of codeBlocks(`Outils GetMySocial :\n${toolsText}${sample}`).slice(0, 5)) {
      await message.channel.send(chunk);
    }
  } catch (err) {
    console.error('[!gms-test] Erreur:', err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
