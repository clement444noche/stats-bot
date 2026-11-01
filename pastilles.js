// =============================================
//   pastilles.js — Pastilles de performance des salons 1:1 VA
//   🟢 > 200 clics/semaine, 🟡 50–200, 🔴 < 50 (clics de la compta hebdo)
//   🚪 = VA en cours de renvoi (géré par Nathan) → jamais touché
//   🏁 = VA dans ses 7 premiers jours, salon « 🏁nom-JJ-MM » (JJ-MM = fin
//        de la période) → passe en couleur le 1er lundi après cette date
// =============================================

const { ChannelType } = require('discord.js');

// Catégories concernées : « Canaux 1:1 VA (Carl) », etc.
const CATEGORY_PATTERN = /^canaux 1:1 va/i;

const GREEN = '🟢';
const YELLOW = '🟡';
const RED = '🔴';
const DOOR = '🚪';
const FLAG = '🏁';

// Ordre des groupes dans la catégorie
const GROUP_ORDER = [GREEN, YELLOW, RED, null, DOOR, FLAG];

function colorFor(clicks) {
  if (clicks > 200) return GREEN;
  if (clicks >= 50) return YELLOW;
  return RED;
}

// « Mialitiana », « mialitiana », « Mialitíana » → « mialitiana »
function normalize(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Découpe un nom de salon : préfixe d'emojis + nom du VA (+ date si drapeau)
function parseChannelName(name) {
  const match = name.match(/^([^\p{L}\p{N}]*)(.*)$/u);
  const prefix = match[1];
  let base = match[2];
  let endDate = null;

  if (prefix.includes(FLAG)) {
    const date = base.match(/^(.*?)-(\d{1,2})-(\d{1,2})$/);
    if (date) {
      base = date[1];
      endDate = { day: Number(date[2]), month: Number(date[3]) };
    }
  }

  let marker = null;
  if (prefix.includes(DOOR)) marker = DOOR;
  else if (prefix.includes(FLAG)) marker = FLAG;
  else {
    // Dernière pastille du préfixe (« 🟡-🟢ben » → 🟢)
    const colors = [...prefix.matchAll(/🟢|🟡|🔴/gu)].map(m => m[0]);
    marker = colors.at(-1) ?? null;
  }

  return { base, marker, endDate };
}

// Date de fin du drapeau en YYYY-MM-DD : l'année la plus proche d'aujourd'hui
// (un « 02-01 » vu fin décembre est en janvier de l'année suivante)
function flagEndIso({ day, month }, today) {
  const year = Number(today.slice(0, 4));
  const candidates = [year - 1, year, year + 1].map(y =>
    `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  const dist = iso => Math.abs(new Date(`${iso}T00:00:00Z`) - new Date(`${today}T00:00:00Z`));
  return candidates.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

// Sépare le nom du VA d'une annotation ajoutée à la main, gardée telle quelle :
// « killiano-last-chance-1-11 » → { name: 'killiano', suffix: '-last-chance-1-11' }
// (le plus long début de nom qui correspond à un VA de la compta)
function splitVA(base, clicksByVA) {
  const parts = base.split('-');
  for (let n = parts.length; n > 0; n--) {
    const name = parts.slice(0, n).join('-');
    if (clicksByVA.has(normalize(name))) {
      return { name, suffix: base.slice(name.length) };
    }
  }
  return { name: base, suffix: '' };
}

// Calcule les nouveaux noms et l'ordre des salons, sans rien modifier.
// channels : [{ id, name, position }] ; clicksByVA : Map(nom normalisé → clics | null)
// today : YYYY-MM-DD (heure de Paris)
function planPastilles(channels, clicksByVA, today) {
  const plan = channels.map(ch => {
    const parsed = parseChannelName(ch.name);
    const { marker, endDate } = parsed;
    const { name: base, suffix } = splitVA(parsed.base, clicksByVA);
    const key = normalize(base);
    const has = clicksByVA.has(key);
    const clicks = has ? clicksByVA.get(key) : null;
    const item = { ...ch, base, newName: ch.name, clicks, marker, status: 'inchangé' };

    if (marker === DOOR) {
      item.status = 'porte';
    } else if (marker === FLAG && !endDate) {
      item.status = 'drapeau sans date';
    } else if (marker === FLAG && flagEndIso(endDate, today) >= today) {
      item.status = 'période d\'essai';
    } else if (!has) {
      item.status = 'introuvable';
    } else if (clicks === null) {
      item.status = 'erreur';
    } else {
      const color = colorFor(clicks);
      // Déjà 🔴 la semaine dernière (pastille avant mise à jour)
      item.wasRed = marker === RED;
      item.newName = `${color}${base}${suffix}`;
      item.marker = color;
      item.status = item.newName !== ch.name ? 'modifié' : 'inchangé';
    }
    return item;
  });

  // Groupes 🟢 🟡 🔴 (clics décroissants), puis le reste, 🚪 et 🏁
  const group = item => {
    const i = GROUP_ORDER.indexOf(item.marker);
    return i === -1 ? GROUP_ORDER.indexOf(null) : i;
  };
  const ordered = [...plan].sort((a, b) =>
    group(a) - group(b)
    || (b.clicks ?? -1) - (a.clicks ?? -1)
    || a.position - b.position);

  return { plan, ordered };
}

function todayParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function shiftDate(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Historique : clics par VA des anciennes comptas postées par le bot ──────
// Renvoie Map(lundi YYYY-MM-DD → Map(nom normalisé → clics | null))
const HISTORY_PAGES = 5; // 5 × 100 messages ≈ plusieurs mois de comptas

function parseComptaEmbed(embed) {
  const week = embed.title?.match(/Compta Insta.*Semaine du lundi (\d{2})\/(\d{2})\/(\d{4})/);
  if (!week || !embed.description) return null;
  const clicks = new Map();
  for (const line of embed.description.split('\n')) {
    const m = line.match(/^👤 \*\*(.+?)\*\* → (?:(\d+) clics?|❌)/);
    if (m) clicks.set(normalize(m[1]), m[2] === undefined ? null : Number(m[2]));
  }
  return { monday: `${week[3]}-${week[2]}-${week[1]}`, clicks };
}

async function readComptaHistory(channel, botId) {
  const history = new Map();
  let before;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    if (!messages.size) break;
    // Du plus récent au plus ancien : la 1re compta vue pour une semaine est
    // la dernière postée (un !compta relancé remplace la précédente)
    for (const msg of messages.values()) {
      if (msg.author.id !== botId) continue;
      for (const embed of msg.embeds) {
        const parsed = parseComptaEmbed(embed);
        if (parsed && !history.has(parsed.monday)) history.set(parsed.monday, parsed.clicks);
      }
    }
    before = messages.last().id;
  }
  return history;
}

// Semaines rouges consécutives d'un VA en remontant depuis `monday` :
// [clics de cette semaine, de la précédente, ...] tant que < 50.
// S'arrête sur une semaine absente, une erreur ou ≥ 50 clics.
function redWeeks(history, key, monday) {
  const weeks = [];
  for (let m = monday; history.get(m)?.has(key); m = shiftDate(m, -7)) {
    const clicks = history.get(m).get(key);
    if (clicks === null || colorFor(clicks) !== RED) break;
    weeks.push(clicks);
  }
  return weeks;
}

// Applique les pastilles sur le serveur du salon compta, puis renvoie un récap.
// results : [{ name, clicks }] (clics de la semaine par VA, null si erreur)
// channel : salon compta (pour l'historique) ; monday : lundi de la semaine comptée
async function updatePastilles(channel, results, monday, { dryRun = false } = {}) {
  const guild = channel.guild;
  const clicksByVA = new Map(results.map(r => [normalize(r.name), r.clicks]));
  const today = todayParis();

  // Historique des comptas + semaine en cours (prioritaire sur le message posté)
  const history = await readComptaHistory(channel, channel.client.user.id);
  history.set(monday, clicksByVA);

  await guild.channels.fetch();
  const categories = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildCategory && CATEGORY_PATTERN.test(c.name));
  if (!categories.size) throw new Error('Pastilles : aucune catégorie « Canaux 1:1 VA » trouvée.');

  const lines = [];
  const problems = [];
  const redStreaks = [];
  const redExits = [];

  for (const category of categories.values()) {
    const channels = guild.channels.cache
      .filter(c => c.parentId === category.id && c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name, position: c.rawPosition }));
    const { plan, ordered } = planPastilles(channels, clicksByVA, today);

    for (const item of plan) {
      const key = normalize(item.base);
      if (item.wasRed && item.marker === RED) {
        // Pastille 🔴 deux lundis de suite → alerte, avec le détail des semaines
        const weeks = redWeeks(history, key, monday);
        const count = weeks.length >= 2 ? `${weeks.length} semaines` : '2 semaines ou plus (historique incomplet)';
        redStreaks.push(`${item.newName} — **${count}** _(${weeks.join(' ← ') || item.clicks} clics)_`);
      } else if (item.wasRed && item.status === 'modifié') {
        // Sorti du rouge : prévenir seulement s'il était en alerte (≥ 2 semaines)
        const weeks = redWeeks(history, key, shiftDate(monday, -7));
        if (weeks.length >= 2) {
          redExits.push(`${item.newName} — ${item.clicks} clics après **${weeks.length} semaines** en rouge`);
        }
      }
      if (item.status === 'modifié') {
        if (!dryRun) {
          try {
            await guild.channels.cache.get(item.id).setName(item.newName, 'Pastilles hebdo');
          } catch (err) {
            problems.push(`❌ ${item.name} : renommage impossible (\`${err.message}\`)`);
            continue;
          }
        }
        lines.push(`${item.name} → **${item.newName}** (${item.clicks} clics)`);
      } else if (item.status === 'introuvable') {
        problems.push(`❓ ${item.name} : aucun VA « ${item.base} » dans la compta`);
      } else if (item.status === 'erreur') {
        problems.push(`⚠️ ${item.name} : clics en erreur, pastille gardée`);
      } else if (item.status === 'drapeau sans date') {
        problems.push(`🏁 ${item.name} : date de fin illisible (format attendu nom-JJ-MM)`);
      }
    }

    // Tri : un seul appel Discord pour toute la catégorie
    const minPos = Math.min(...channels.map(c => c.position));
    const current = [...channels].sort((a, b) => a.position - b.position);
    const moved = ordered.some((item, i) => item.id !== current[i].id);
    if (moved && !dryRun) {
      try {
        await guild.channels.setPositions(ordered.map((item, i) => ({ channel: item.id, position: minPos + i })));
      } catch (err) {
        problems.push(`❌ ${category.name} : tri impossible (\`${err.message}\`)`);
      }
    }
    if (moved) lines.push(`↕️ ${category.name} : salons triés 🟢 → 🟡 → 🔴`);
  }

  return { lines, problems, redStreaks, redExits };
}

module.exports = {
  updatePastilles, planPastilles, parseChannelName, colorFor, normalize, flagEndIso,
  parseComptaEmbed, redWeeks,
};
