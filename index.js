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

// ── Grille des primes hebdo (par lien, bornes incluses) ─────────────────────
// 0–330 clics : 0,02 $/clic ; au-delà, montant fixe par tranche
const PRIME_TRANCHES = [
  { min: 5000, prime: 275 },
  { min: 4400, prime: 230 },
  { min: 3800, prime: 190 },
  { min: 3200, prime: 155 },
  { min: 2600, prime: 130 },
  { min: 2000, prime: 110 },
  { min: 1331, prime: 85 },
  { min: 1001, prime: 65 },
  { min: 871, prime: 45 },
  { min: 731, prime: 30 },
  { min: 601, prime: 20 },
  { min: 471, prime: 10 },
  { min: 331, prime: 7 },
];

// Prime en centimes (évite les arrondis des nombres à virgule)
function primeCents(clicks) {
  const tranche = PRIME_TRANCHES.find(t => clicks >= t.min);
  return tranche ? tranche.prime * 100 : clicks * 2;
}

function dollars(cents) {
  return cents % 100 === 0
    ? `${cents / 100} $`
    : `${(cents / 100).toFixed(2).replace('.', ',')} $`;
}

const plural = n => `${n} clic${n !== 1 ? 's' : ''}`;

// ── Clics par VA → message Discord ───────────────────────────────────────────
// entries : [{ va, clicks }] avec clicks = null si erreur pour ce lien.
// withPrimes : prime calculée lien par lien puis additionnée par VA.
async function postReport(client, channelId, title, entries, { withPrimes = false } = {}) {
  // Erreurs levées : affichées par la commande manuelle, loguées par le cron
  if (!channelId) {
    throw new Error(`${title} : variable du salon non définie sur Railway.`);
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error(`${title} : salon ${channelId} introuvable (le bot y a-t-il accès ?).`);
  }

  // Liens regroupés par VA (un VA peut avoir plusieurs liens)
  const byVA = new Map();
  for (const { va, clicks } of entries) {
    const name = va ?? '❓ Sans VA';
    const entry = byVA.get(name) ?? { name, links: [], errors: 0 };
    if (clicks === null) entry.errors++;
    else entry.links.push(clicks);
    byVA.set(name, entry);
  }

  // Un seul lien en erreur suffit à afficher le VA en erreur : un chiffre
  // partiel passerait inaperçu (et fausserait la prime)
  const results = [...byVA.values()].map(e => ({
    name: e.name,
    links: e.links,
    clicks: e.errors ? null : e.links.reduce((s, c) => s + c, 0),
    prime: e.errors ? null : e.links.reduce((s, c) => s + primeCents(c), 0),
  }));

  // Tri par clics décroissants (les erreurs en bas)
  results.sort((a, b) => {
    if (a.clicks === null) return 1;
    if (b.clicks === null) return -1;
    return b.clicks - a.clicks;
  });

  const ok = results.filter(r => r.clicks !== null);
  const errors = results.length - ok.length;
  const teamTotal = ok.reduce((sum, r) => sum + r.clicks, 0);
  const primesTotal = ok.reduce((sum, r) => sum + r.prime, 0);

  const lines = results.map(r => {
    if (r.clicks === null) return `👤 **${r.name}** → ❌ erreur`;
    let line = `👤 **${r.name}** → ${plural(r.clicks)}`;
    if (withPrimes) {
      line += ` → 💵 **${dollars(r.prime)}**`;
      if (r.links.length > 1) {
        line += ` _(${r.links.map(c => `${c} → ${dollars(primeCents(c))}`).join(' + ')})_`;
      }
    }
    return line;
  });

  let footer = `Total équipe : ${plural(teamTotal)}`;
  if (withPrimes) footer += ` • Total primes : ${dollars(primesTotal)}`;
  if (errors) footer += ` • ⚠️ ${errors} VA en erreur, relancer la commande`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n') || '_Aucun lien actif_')
    .setColor(errors ? 0xED4245 : 0x57F287)
    .setFooter({ text: footer })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`[${title}] Rapport envoyé — ${footer}`);
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
  await postReport(client, process.env.REPORT_CHANNEL_ID,
    `📊 Rapport Insta (🇺🇸🇬🇧🇦🇺🇨🇦) — Hier (${yesterdayLabel()})`, entries);
}

// ── Rapport compta hebdo Insta → salon compta (lundi 00h10) ─────────────────
function frDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function sendComptaReport(client) {
  const week = gaml.lastWeek();
  const links = await gaml.getLinks();
  const entries = [];
  for (const link of links) {
    try {
      entries.push({ va: link.va, clicks: await gaml.getLastWeekClicks(link.id, week) });
    } catch (err) {
      console.error(`[Compta] Erreur pour ${link.va} (${link.label}):`, err.message);
      entries.push({ va: link.va, clicks: null });
    }
  }
  await postReport(client, process.env.COMPTA_CHANNEL_ID,
    `💰 Compta Insta (🇺🇸🇬🇧🇦🇺🇨🇦) — Semaine du lundi ${frDate(week.from)} au dimanche ${frDate(week.to)}`,
    entries, { withPrimes: true });
}

// ── Rapport GetMySocial (VAs Twitter) → salon Twitter ───────────────────────
async function sendGmsReport(client) {
  const links = await gms.getLinks();
  // Uniquement les clics venant des US, du UK, d'Australie et du Canada
  const clicks = await gms.getYesterdayTargetClicks(links.map(l => l.id));
  // null = erreur GetMySocial pour ce lien (affichée « ❌ erreur »)
  const entries = links.map(l => ({ va: l.va, clicks: clicks.get(l.id) ?? null }));
  await postReport(client, process.env.GMS_REPORT_CHANNEL_ID,
    `🐦 Rapport Twitter (🇺🇸🇬🇧🇦🇺🇨🇦) — Hier (${yesterdayLabel()})`, entries);
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

  // ── Cron : compta hebdo Insta le lundi à 00h10 heure de Paris ───────────
  cron.schedule('10 0 * * 1', () => {
    console.log('[Cron] Déclenchement du rapport compta hebdo...');
    sendComptaReport(client).catch(err => console.error('[Cron] Erreur rapport compta:', err));
  }, {
    timezone: 'Europe/Paris',
  });

  console.log('⏰ Rapport compta programmé le lundi à 00h10 (Paris)');
});

// ── Commandes admin : !rapport (Insta), !rapport-twitter, !compta ───────────
function isAdmin(message) {
  return message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
}

const COMMANDS = {
  '!rapport': client => sendGamlReport(client),
  '!rapport-twitter': client => sendGmsReport(client),
  '!compta': client => sendComptaReport(client),
};

// ── !compta-verif <VA> : détail de la compta d'un VA, jour par jour ─────────
// Pour répondre à une contestation : visites, clics par pays et prime par lien
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const text = message.content.trim();
  if (!/^!compta-verif\b/.test(text)) return;
  if (!isAdmin(message)) return message.reply({ content: '❌ Réservé aux admins.' });

  const name = text.replace(/^!compta-verif/, '').trim();
  if (!name) return message.reply('Écris le nom du VA après la commande, par exemple : `!compta-verif Mickael`');

  try {
    const links = (await gaml.getLinks()).filter(l => (l.va ?? '').toLowerCase() === name.toLowerCase());
    if (!links.length) return message.reply(`❌ Aucun lien actif avec la note « ${name} ».`);

    const week = gaml.lastWeek();
    await message.reply(`⏳ Vérification de ${name} (${links.length} lien${links.length > 1 ? 's' : ''}, ≈ ${links.length * 10} s)...`);

    let primeTotal = 0;
    for (const link of links) {
      const days = await gaml.getLastWeekDetail(link.id, week);
      const sum = f => days.reduce((s, d) => s + f(d), 0);
      const clicks = sum(d => d.target);
      const prime = primeCents(clicks);
      primeTotal += prime;

      const row = (date, total, c, target) =>
        `${date} | ${String(total).padStart(6)} | ${String(c.US).padStart(4)} | ${String(c.UK).padStart(3)} | ${String(c.CA).padStart(3)} | ${String(c.AU).padStart(3)} | ${target}`;
      const totals = { US: sum(d => d.byCountry.US), UK: sum(d => d.byCountry.UK), CA: sum(d => d.byCountry.CA), AU: sum(d => d.byCountry.AU) };

      const out = `${name} — lien ${link.label} — semaine du ${frDate(week.from)} au ${frDate(week.to)}\n\n`
        + `jour       | visites |   US |  UK |  CA |  AU | clics retenus\n`
        + days.map(d => row(d.date, d.total, d.byCountry, d.target)).join('\n')
        + `\n${row('TOTAL     ', sum(d => d.total), totals, clicks)}`
        + `\n\nPrime de ce lien : ${clicks} clics → ${dollars(prime)}`;
      await message.channel.send('```\n' + out.slice(0, 1900) + '\n```');
    }
    if (links.length > 1) await message.channel.send(`💵 **Prime totale de ${name} : ${dollars(primeTotal)}**`);
  } catch (err) {
    console.error('[!compta-verif] Erreur:', err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

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
