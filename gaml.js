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

// Nombre de clics (visites, bots exclus) d'un lien pour la veille, heure de Paris
async function getYesterdayClicks(linkId) {
  const countries = await fetchGAML('/analytics/countries', {
    link_id: linkId,
    range: 'yesterday',
    timezone: TIMEZONE,
    hide_bots: true,
  });
  return countries.reduce((sum, row) => sum + (row.count ?? 0), 0);
}

module.exports = { getLinks, getYesterdayClicks };
