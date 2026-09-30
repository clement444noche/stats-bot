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

async function fetchGAML(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'X-Api-Key': apiKey(),
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const diag = res.status === 401 ? ` [clé : ${keyDiagnostic()}]` : '';
    throw new Error(`GAML ${res.status}: ${text.slice(0, 200)}${diag}`);
  }

  return res.json();
}

// Tous les liens actifs du compte, avec le nom du VA
// (nom du lien, sinon nom du groupe, sinon URL)
async function getLinks() {
  const links = await fetchGAML('/links', { enabled: true });
  return links.map(link => ({
    id: link.id,
    name: link.name || link.group?.name || link.url,
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
