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
const pastilles = require('./pastilles');
const onboarding = require('./onboarding');
const subs = require('./subs');

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

// Prime en centimes (évite les arrondis des nombres à virgule), calculée sur
// les clics RETENUS de la semaine du lien (coefficient du palier, voir plus bas)
function primeCents(clicks) {
  const retained = retainedClicks(clicks);
  const tranche = PRIME_TRANCHES.find(t => retained >= t.min);
  return tranche ? tranche.prime * 100 : retained * 2;
}

// Clics retenus d'une semaine complète d'un lien
const retainedClicks = weekClicks => applyCoef(weekClicks, coefOf(weekClicks));

// ── Coefficient par palier (salon #clics et primes de la compta) ────────────
// Coeff (en %) du palier atteint par le rythme de la semaine en cours (par
// lien), appliqué à tous ses clics — même résultat final que la simulation Excel
const CLICS_COEFS = [
  { min: 5000, coef: 60 },
  { min: 4400, coef: 70 },
  { min: 3800, coef: 75 },
  { min: 2600, coef: 85 },
  { min: 2000, coef: 70 },
  { min: 1331, coef: 85 },
  { min: 1001, coef: 80 },
  { min: 601, coef: 85 },
  { min: 471, coef: 90 },
];

const coefOf = weekClicks => CLICS_COEFS.find(t => weekClicks >= t.min)?.coef ?? 100;
const applyCoef = (clicks, coef) => Math.floor(clicks * coef / 100);

function dollars(cents) {
  return cents % 100 === 0
    ? `${cents / 100} $`
    : `${(cents / 100).toFixed(2).replace('.', ',')} $`;
}

const plural = n => `${n} clic${n !== 1 ? 's' : ''}`;

// ── Clics par lien → clics par VA ───────────────────────────────────────────
// entries : [{ va, clicks }] avec clicks = null si erreur pour ce lien.
// Champs optionnels (rapport #clics) : retained, week, weekRetained.
function groupByVA(entries) {
  // Liens regroupés par VA (un VA peut avoir plusieurs liens)
  const byVA = new Map();
  for (const { va, clicks, reason, ...extra } of entries) {
    const name = va ?? '❓ Sans VA';
    const entry = byVA.get(name)
      ?? { name, links: [], errors: 0, reasons: new Set(), retained: 0, week: 0, weekRetained: 0 };
    if (clicks === null) {
      entry.errors++;
      if (reason) entry.reasons.add(reason);
    } else {
      entry.links.push(clicks);
      entry.retained += extra.retained ?? 0;
      entry.week += extra.week ?? 0;
      entry.weekRetained += extra.weekRetained ?? 0;
    }
    byVA.set(name, entry);
  }

  // Un seul lien en erreur suffit à afficher le VA en erreur : un chiffre
  // partiel passerait inaperçu (et fausserait la prime)
  const results = [...byVA.values()].map(e => ({
    name: e.name,
    links: e.links,
    reasons: [...e.reasons],
    clicks: e.errors ? null : e.links.reduce((s, c) => s + c, 0),
    prime: e.errors ? null : e.links.reduce((s, c) => s + primeCents(c), 0),
    retained: e.retained,
    week: e.week,
    weekRetained: e.weekRetained,
  }));

  // Tri par clics décroissants (les erreurs en bas)
  results.sort((a, b) => {
    if (a.clicks === null) return 1;
    if (b.clicks === null) return -1;
    return b.clicks - a.clicks;
  });
  return results;
}

async function getChannel(client, channelId, title) {
  // Erreurs levées : affichées par la commande manuelle, loguées par le cron
  if (!channelId) {
    throw new Error(`${title} : variable du salon non définie sur Railway.`);
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error(`${title} : salon ${channelId} introuvable (le bot y a-t-il accès ?).`);
  }
  return channel;
}

// ── Clics par VA → message Discord ───────────────────────────────────────────
// withPrimes : prime calculée lien par lien puis additionnée par VA.
// withRetained : clics retenus de la veille + cumul de la semaine (#clics).
// Renvoie les clics par VA (utilisés pour les pastilles).
async function postReport(client, channelId, title, entries,
  { withPrimes = false, withRetained = false } = {}) {
  const channel = await getChannel(client, channelId, title);
  const results = groupByVA(entries);

  const ok = results.filter(r => r.clicks !== null);
  const errors = results.length - ok.length;
  const teamTotal = ok.reduce((sum, r) => sum + r.clicks, 0);
  const primesTotal = ok.reduce((sum, r) => sum + r.prime, 0);

  const lines = results.map(r => {
    if (r.clicks === null) {
      return `👤 **${r.name}** → ❌ erreur${r.reasons.length ? ` _(${r.reasons.join(', ')})_` : ''}`;
    }
    let line = `👤 **${r.name}** → ${plural(r.clicks)}`;
    if (withRetained) {
      line += ` (${r.retained} retenus) • semaine : ${r.week} (${r.weekRetained} retenus)`;
    }
    if (withPrimes) {
      const retained = r.links.reduce((s, c) => s + retainedClicks(c), 0);
      if (retained !== r.clicks) line += ` (${retained} retenus)`;
      line += ` → 💵 **${dollars(r.prime)}**`;
      if (r.links.length > 1) {
        line += ` _(${r.links.map(c => `${c} → ${retainedClicks(c)} → ${dollars(primeCents(c))}`).join(' + ')})_`;
      }
    }
    return line;
  });

  let footer = `Total équipe : ${plural(teamTotal)}`;
  if (withPrimes) {
    const retainedTotal = ok.reduce((sum, r) => sum + r.links.reduce((s, c) => s + retainedClicks(c), 0), 0);
    footer += ` (${retainedTotal} retenus) • Total primes : ${dollars(primesTotal)}`
      + ' • Prime calculée sur les clics retenus';
  }
  if (withRetained) {
    const retainedTotal = ok.reduce((sum, r) => sum + r.retained, 0);
    footer += ` (${retainedTotal} retenus) • Retenus = coefficient selon ton rythme de la semaine`
      + ' (fixé définitivement le dimanche)';
  }
  if (errors) footer += ` • ⚠️ ${errors} VA en erreur, relancer la commande`;

  // Discord limite la description d'un embed à 4096 caractères : au-delà,
  // la liste est coupée en plusieurs messages (titre sur le 1er, total sur le dernier)
  const chunks = [];
  let current = '';
  for (const line of lines.length ? lines : ['_Aucun lien actif_']) {
    if (current && current.length + line.length + 1 > 4000) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  chunks.push(current);

  for (const [i, chunk] of chunks.entries()) {
    const embed = new EmbedBuilder()
      .setDescription(chunk)
      .setColor(errors ? 0xED4245 : 0x57F287);
    if (i === 0) embed.setTitle(chunks.length > 1 ? `${title} (1/${chunks.length})` : title);
    else embed.setTitle(`Suite (${i + 1}/${chunks.length})`);
    if (i === chunks.length - 1) embed.setFooter({ text: footer }).setTimestamp();
    await channel.send({ embeds: [embed] });
  }
  console.log(`[${title}] Rapport envoyé — ${footer}`);
  return results;
}

// Raison courte d'une erreur GAML, affichée dans le rapport
function errorReason(err) {
  const msg = String(err?.message ?? err);
  if (/GAML 429/.test(msg)) return 'limite de requêtes';
  const status = msg.match(/GAML (\d{3})/);
  if (status) return `GetAllMyLinks ${status[1]}`;
  if (/visites le/.test(msg)) return 'trop de visites';
  if (/fetch failed|ECONN|ETIMEDOUT|socket/i.test(msg)) return 'connexion';
  return msg.slice(0, 40);
}

// Clics de chaque lien, avec jusqu'à 2 nouvelles passes sur les liens en
// erreur (après 1 min de pause : limite GAML partagée avec le SaaS, panne passagère)
const RETRY_PASSES = 2;
const RETRY_PAUSE_MS = 60000;

async function collectClicks(links, getClicks, tag) {
  const results = new Map();
  let pending = links;
  for (let pass = 0; pass <= RETRY_PASSES && pending.length; pass++) {
    if (pass > 0) {
      console.warn(`[${tag}] ${pending.length} lien(s) en erreur, nouvel essai dans 1 min (passe ${pass + 1})`);
      await new Promise(r => setTimeout(r, RETRY_PAUSE_MS));
    }
    const failed = [];
    for (const link of pending) {
      try {
        results.set(link.id, { va: link.va, clicks: await getClicks(link) });
      } catch (err) {
        console.error(`[${tag}] Erreur pour ${link.va} (${link.label}):`, err.message);
        results.set(link.id, { va: link.va, clicks: null, reason: errorReason(err) });
        failed.push(link);
      }
    }
    pending = failed;
  }
  return links.map(l => results.get(l.id));
}

// ── Rapport GetAllMyLinks (VAs Insta) → salon #clics ─────────────────────────
async function sendGamlReport(client) {
  const links = await gaml.getLinks();
  const raw = await collectClicks(links, l => gaml.getYesterdayAndWeekClicks(l.id), 'GAML');
  // Coeff choisi lien par lien avec le RYTHME de la semaine en cours (cumul
  // ramené à 7 jours) : stable toute la semaine pour un VA régulier, et égal
  // au coeff du vrai total le dimanche (rapport du lundi = simulation Excel)
  const entries = raw.map(e => {
    if (e.clicks === null) return e;
    const { day, week, days } = e.clicks;
    const coef = coefOf(Math.round(week / days * 7));
    return {
      va: e.va, clicks: day,
      retained: applyCoef(day, coef), week, weekRetained: applyCoef(week, coef),
    };
  });
  await postReport(client, process.env.REPORT_CHANNEL_ID,
    `📊 Rapport Insta (🇺🇸🇬🇧🇨🇦🇦🇺🇳🇿🇮🇪) — Hier (${yesterdayLabel()})`, entries, { withRetained: true });
}

// ── Rapport compta hebdo Insta → salon compta (lundi 00h10) ─────────────────
function frDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function getLastWeekEntries() {
  const week = gaml.lastWeek();
  const links = await gaml.getLinks();
  const entries = await collectClicks(links, l => gaml.getLastWeekClicks(l.id, week), 'Compta');
  return { week, entries };
}

const comptaTitle = week =>
  `💰 Compta Insta (🇺🇸🇬🇧🇨🇦🇦🇺🇳🇿🇮🇪) — Semaine du lundi ${frDate(week.from)} au dimanche ${frDate(week.to)}`;

async function sendComptaReport(client) {
  const { week, entries } = await getLastWeekEntries();
  const results = await postReport(client, process.env.COMPTA_CHANNEL_ID,
    comptaTitle(week), entries, { withPrimes: true });
  await sendPastilles(client, results, week.from)
    .catch(err => console.error('[Pastilles] Erreur:', err));
}

// Aperçu de la compta dans le salon de la commande (pastilles non touchées)
async function sendComptaPreview(client, channelId) {
  const { week, entries } = await getLastWeekEntries();
  await postReport(client, channelId, `🧪 Aperçu — ${comptaTitle(week)}`, entries, { withPrimes: true });
}

// ── Pastilles des salons 1:1 VA (après la compta) → récap dans le salon compta
async function sendPastilles(client, results, monday, { dryRun = false } = {}) {
  const channel = await getChannel(client, process.env.COMPTA_CHANNEL_ID, 'Pastilles');
  try {
    const { lines, problems, redStreaks, redExits } =
      await pastilles.updatePastilles(channel, results, monday, { dryRun });
    const body = [
      ...(lines.length ? lines : ['_Aucune pastille à changer_']),
      ...(redStreaks.length
        ? ['', '🚨 **En rouge depuis 2 semaines ou plus** _(clics de cette semaine ← semaines d\'avant)_ :', ...redStreaks]
        : []),
      ...(redExits.length ? ['', '✅ **Sortis du rouge :**', ...redExits] : []),
      ...(problems.length ? ['', ...problems] : []),
    ].join('\n');
    const embed = new EmbedBuilder()
      .setTitle(dryRun ? '🧪 Pastilles — simulation (rien n\'a été modifié)' : '🎨 Pastilles des salons VA mises à jour')
      .setDescription(body.slice(0, 4000))
      .setColor(problems.length ? 0xFEE75C : 0x57F287)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    await channel.send(`❌ Pastilles non mises à jour : \`${err.message}\``);
    throw err;
  }
}

// Commandes !pastilles / !pastilles-simu : recalcule la semaine sans reposter la compta
async function runPastilles(client, dryRun) {
  const { week, entries } = await getLastWeekEntries();
  await sendPastilles(client, groupByVA(entries), week.from, { dryRun });
}

// ── Rapport GetMySocial (VAs Twitter) → salon Twitter ───────────────────────
async function sendGmsReport(client) {
  const links = await gms.getLinks();
  // Uniquement les clics venant des US, du UK, d'Australie et du Canada
  const clicks = await gms.getYesterdayTargetClicks(links.map(l => l.id));
  // null = erreur GetMySocial pour ce lien (affichée « ❌ erreur »)
  const entries = links.map(l => ({ va: l.va, clicks: clicks.get(l.id) ?? null }));
  await postReport(client, process.env.GMS_REPORT_CHANNEL_ID,
    `🐦 Rapport Twitter (🇺🇸🇬🇧🇨🇦🇦🇺🇳🇿🇮🇪) — Hier (${yesterdayLabel()})`, entries);
}

// ── Point du jour Twitter (12h, 17h, 22h) : clics depuis minuit ─────────────
async function sendGmsTodayReport(client) {
  const links = await gms.getLinks();
  const clicks = await gms.getTodayTargetClicks(links.map(l => l.id));
  const entries = links.map(l => ({ va: l.va, clicks: clicks.get(l.id) ?? null }));
  const now = new Date();
  const day = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
    .replace(':', 'h');
  await postReport(client, process.env.GMS_REPORT_CHANNEL_ID,
    `🐦 Clics Twitter du jour (🇺🇸🇬🇧🇨🇦🇦🇺🇳🇿🇮🇪) — Aujourd'hui (${day}) à ${time}`, entries);
}

// ── Client Discord ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // onboarding : détecter le rôle « VA Insta »
  ],
});

onboarding.register(client);
subs.register(client, isAdmin); // export CSV Infloww déposé dans un salon « subs »

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📡 Serveurs : ${client.guilds.cache.size}`);

  // Membres en cache : sans ça, Discord n'envoie pas l'ajout de rôle
  // des membres jamais vus depuis le démarrage
  for (const guild of client.guilds.cache.values()) {
    guild.members.fetch()
      .then(m => console.log(`👥 ${guild.name} : ${m.size} membres en cache (onboarding « ${onboarding.ROLE_NAME} »)`))
      .catch(err => console.error('[Onboarding] Membres illisibles (Server Members Intent activé ?) :', err.message));
  }

  // ── Cron : rapports quotidiens à 8h heure de Paris ──────────────────────
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Déclenchement des rapports quotidiens...');
    await sendGamlReport(client).catch(err => console.error('[Cron] Erreur rapport GAML:', err));
    await sendGmsReport(client).catch(err => console.error('[Cron] Erreur rapport GMS:', err));
  }, {
    timezone: 'Europe/Paris',
  });

  console.log('⏰ Rapports quotidiens programmés à 8h (Paris)');

  // ── Cron : point du jour Twitter à 12h, 17h et 22h heure de Paris ───────
  cron.schedule('0 12,17,22 * * *', () => {
    console.log('[Cron] Déclenchement du point du jour Twitter...');
    sendGmsTodayReport(client).catch(err => console.error('[Cron] Erreur point du jour Twitter:', err));
  }, {
    timezone: 'Europe/Paris',
  });

  console.log('⏰ Point du jour Twitter programmé à 12h, 17h et 22h (Paris)');

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
  '!twitter-jour': client => sendGmsTodayReport(client),
  '!compta': client => sendComptaReport(client),
  '!compta-apercu': (client, message) => sendComptaPreview(client, message.channel.id),
  '!pastilles': client => runPastilles(client, false),
  '!pastilles-simu': client => runPastilles(client, true),
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

      const COLS = ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'];
      const row = (date, total, c, target) =>
        `${date} | ${String(total).padStart(6)} | ${String(c.US).padStart(4)} | `
        + COLS.slice(1).map(k => String(c[k]).padStart(3)).join(' | ') + ` | ${target}`;
      const totals = Object.fromEntries(COLS.map(k => [k, sum(d => d.byCountry[k])]));

      const out = `${name} — lien ${link.label} — semaine du ${frDate(week.from)} au ${frDate(week.to)}\n\n`
        + `jour       | visites |   US |  UK |  CA |  AU |  NZ |  IE | clics pays\n`
        + days.map(d => row(d.date, d.total, d.byCountry, d.target)).join('\n')
        + `\n${row('TOTAL     ', sum(d => d.total), totals, clicks)}`
        + `\n\nPrime de ce lien : ${clicks} clics × ${coefOf(clicks)} % `
        + `= ${retainedClicks(clicks)} retenus → ${dollars(prime)}`;
      await message.channel.send('```\n' + out.slice(0, 1900) + '\n```');
    }
    if (links.length > 1) await message.channel.send(`💵 **Prime totale de ${name} : ${dollars(primeTotal)}**`);
  } catch (err) {
    console.error('[!compta-verif] Erreur:', err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── !onboarding-apercu : affiche le message de bienvenue ici, sans rien créer
// ── !onboarding @VA [@Manager] : lance l'onboarding à la main (salon + message)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const text = message.content.trim();
  if (!/^!onboarding(-apercu)?/.test(text)) return;
  if (!isAdmin(message)) return message.reply({ content: '❌ Réservé aux admins.' });

  try {
    if (text.startsWith('!onboarding-apercu')) {
      const target = message.mentions.members.first() ?? message.member;
      return await message.channel.send({
        content: onboarding.buildMessage(message.guild, target, message.member),
        allowedMentions: { parse: [] }, // aperçu : personne n'est notifié
      });
    }
    // !onboarding @VA [@Manager] : mentions dans l'ordre du message
    const ids = [...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
    const target = ids[0] && message.mentions.members.get(ids[0]);
    if (!target) return message.reply('Mentionne le VA (et son manager si ce n’est pas toi), par exemple : `!onboarding @James @Carl`');
    const manager = (ids[1] && message.mentions.members.get(ids[1])) || message.member;
    const { channel, created } = await onboarding.onboard(target, { manager });
    await message.reply(`✅ Message envoyé dans <#${channel.id}>${created ? ' (salon créé)' : ' (salon existant)'}.`);
  } catch (err) {
    console.error('[!onboarding] Erreur:', err);
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
    await COMMANDS[command](client, message);
  } catch (err) {
    console.error(`[${command}] Erreur:`, err);
    await message.reply(`❌ Erreur : \`${err.message}\``);
  }
});

// ── Lancement ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
