// =============================================
//   gaml.js — Wrapper API GetAllMyLinks
// =============================================

const BASE_URL = 'https://getallmylinks.com/api/v1';
const TIMEZONE = 'Europe/Paris';

// Clé nettoyée (espaces, retours à la ligne, guillemets collés par erreur)
function apiKey() {
  return (process.env.GAML_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
}

// Diagnostic de la clé sans jamais l'afficher
function keyDiagnostic() {
  const raw = process.env.GAML_API_KEY || '';
  const key = apiKey();
  return [
    `longueur ${key.length}`,
    key.startsWith('gaml_') ? 'commence par gaml_' : 'ne commence PAS par gaml_',
    raw !== raw.trim() ? 'espaces/retours à la ligne retirés' : null,
    /^\s*["']|["']\s*$/.test(raw) ? 'guillemets retirés' : null,
  ].filter(Boolean).join(', ');
}

// Limite GAML : 60 requêtes/minute par clé → une requête toutes les 1,1 s max
const MIN_INTERVAL_MS = 1100;
const MAX_RETRIES = 3;
let nextSlot = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function fetchGAML(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    res = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': apiKey(),
        'Accept': 'application/json',
      },
    });
    if (res.status !== 429 || attempt >= MAX_RETRIES) break;

    // Limite atteinte : on attend le délai indiqué par GAML puis on réessaie
    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    const waitMs = Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, 60000) : 15000;
    console.warn(`[GAML] Limite atteinte, nouvel essai dans ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }

  if (!res.ok) {
    const text = await res.text();
    const diag = res.status === 401 ? ` [clé : ${keyDiagnostic()}]` : '';
    throw new Error(`GAML ${res.status}: ${text.slice(0, 200)}${diag}`);
  }

  return res.json();
}

// Tous les liens actifs du compte. Le VA est dans la note du lien
// (ex. note « Junior »), comme dans le SaaS ; null si pas de note.
async function getLinks() {
  const links = await fetchGAML('/links', { enabled: true });
  return links.map(link => ({
    id: link.id,
    va: link.note?.trim() || null,
    label: link.name || link.url,
  }));
}

// Pays retenus : US, UK, Australie, Canada, Nouvelle-Zélande, Irlande
// (code ISO ou nom complet selon la réponse)
const TARGET_COUNTRIES = new Set([
  'US', 'GB', 'UK', 'AU', 'CA', 'NZ', 'IE',
  'UNITED STATES', 'UNITED STATES OF AMERICA', 'UNITED KINGDOM', 'AUSTRALIA', 'CANADA',
  'NEW ZEALAND', 'IRELAND',
]);

function isTargetCountry(row) {
  return [row.country_code, row.countryCode, row.code, row.country]
    .some(v => v && TARGET_COUNTRIES.has(String(v).trim().toUpperCase()));
}

// Pays cible d'une visite, ramené à US / UK / CA / AU (null si autre pays)
const COUNTRY_SHORT = {
  'US': 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US',
  'GB': 'UK', 'UK': 'UK', 'UNITED KINGDOM': 'UK',
  'CA': 'CA', 'CANADA': 'CA',
  'AU': 'AU', 'AUSTRALIA': 'AU',
  'NZ': 'NZ', 'NEW ZEALAND': 'NZ',
  'IE': 'IE', 'IRELAND': 'IE',
};

function targetCountryOf(row) {
  for (const v of [row.country_code, row.countryCode, row.code, row.country]) {
    const short = v && COUNTRY_SHORT[String(v).trim().toUpperCase()];
    if (short) return short;
  }
  return null;
}

// /analytics/countries ne renvoie que le top 10 des pays (un pays cible hors
// top 10 serait perdu) : on compte donc les visites une à une via /traffic.
// Plafond de /analytics/traffic par appel : au-delà, des visites manqueraient
const TRAFFIC_CAP = 10000;

// Clics exacts d'un lien sur UNE journée (heure de Paris), uniquement
// US/UK/AU/CA : on compte visite par visite, sans la limite du top 10 des pays
async function getDayTargetClicks(linkId, date) {
  const visits = await fetchGAML('/analytics/traffic', {
    link_id: linkId,
    range: 'custom',
    date_from: date,
    date_to: date,
    timezone: TIMEZONE,
    hide_bots: true,
  });
  if (visits.length >= TRAFFIC_CAP) {
    throw new Error(`plus de ${TRAFFIC_CAP} visites le ${date}, comptage incomplet`);
  }
  const byCountry = { US: 0, UK: 0, CA: 0, AU: 0, NZ: 0, IE: 0 };
  for (const v of visits) {
    const c = targetCountryOf(v);
    if (c) byCountry[c]++;
  }
  return {
    total: visits.length,
    target: visits.filter(isTargetCountry).length,
    byCountry,
  };
}

// Date YYYY-MM-DD décalée de n jours (calcul sur la date seule, sans heure)
function shiftDate(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

async function getYesterdayClicks(linkId) {
  return (await getDayTargetClicks(linkId, shiftDate(todayParis(), -1))).target;
}

// Semaine précédente complète, du lundi au dimanche inclus, heure de Paris
function lastWeek() {
  const today = todayParis();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = dimanche
  const thisMonday = shiftDate(today, -((dow + 6) % 7));
  return { from: shiftDate(thisMonday, -7), to: shiftDate(thisMonday, -1) };
}

// Clics exacts de la semaine : une journée à la fois (date_to inclus par GAML)
async function getLastWeekClicks(linkId, week = lastWeek()) {
  let sum = 0;
  for (let date = week.from; date <= week.to; date = shiftDate(date, 1)) {
    sum += (await getDayTargetClicks(linkId, date)).target;
  }
  return sum;
}

// Détail jour par jour de la semaine (pour !compta-verif)
async function getLastWeekDetail(linkId, week = lastWeek()) {
  const days = [];
  for (let date = week.from; date <= week.to; date = shiftDate(date, 1)) {
    days.push({ date, ...(await getDayTargetClicks(linkId, date)) });
  }
  return days;
}

module.exports = { getLinks, getYesterdayClicks, getLastWeekClicks, getLastWeekDetail, lastWeek };
