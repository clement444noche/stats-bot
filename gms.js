// =============================================
//   gms.js — Client GetMySocial (via son serveur MCP HTTP)
// =============================================

const MCP_URL = 'https://mcp.getmysocial.com/mcp';

// Clé nettoyée (espaces, retours à la ligne, guillemets collés par erreur)
function apiKey() {
  return (process.env.GMS_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
}

let sessionId = null;
let nextId = 1;

// Réponse JSON directe ou flux SSE ("data: {...}")
async function readRpc(res) {
  const text = await res.text();
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines.reverse()) {
      try { return JSON.parse(line.slice(5).trim()); } catch {}
    }
    throw new Error(`GMS : réponse SSE illisible : ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function post(body) {
  const headers = {
    'Authorization': `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok && res.status !== 202) {
    const text = await res.text();
    throw new Error(`GMS ${res.status}: ${text.slice(0, 200)}`);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  return res;
}

async function rpc(method, params = {}) {
  const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
  const msg = await readRpc(res);
  if (msg?.error) throw new Error(`GMS ${method}: ${msg.error.message}`);
  return msg?.result;
}

async function connect() {
  if (!apiKey()) throw new Error('GMS_API_KEY non défini sur Railway.');
  sessionId = null;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'track-clics', version: '1.0.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function listTools() {
  await connect();
  const result = await rpc('tools/list');
  return result?.tools ?? [];
}

// Appelle un outil et renvoie son contenu (JSON si possible, sinon texte)
async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  // Erreur renvoyée par l'outil : on la remonte au lieu de la prendre pour des données
  if (result?.isError) throw new Error(`GMS ${name} : ${text.slice(0, 200)}`);
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

const TIMEZONE = 'Europe/Paris';

// Date d'hier (YYYY-MM-DD) en heure de Paris
function yesterdayDate() {
  return new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Liste d'éléments quelle que soit l'enveloppe de la réponse
function itemsOf(data) {
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.links ?? data?.items ?? data?.results ?? data?.metrics ?? [];
}

function nextCursorOf(data) {
  if (Array.isArray(data)) return null;
  if (data?.has_more === false) return null;
  return data?.next_cursor ?? data?.cursor ?? data?.pagination?.next_cursor ?? null;
}

// Tous les liens actifs. Le VA est le display_name du lien (ex. « Vianney »),
// name_user étant le nom du modèle (ex. « Lola »).
async function getLinks() {
  await connect();
  const links = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const data = await callTool('list_links', { limit: 100, ...(cursor ? { cursor } : {}) });
    links.push(...itemsOf(data));
    cursor = nextCursorOf(data);
    if (!cursor) break;
  }
  return links
    .filter(l => !l.status || l.status === 'active')
    .map(l => ({
      id: l.id,
      va: l.display_name?.trim() || l.notes?.trim() || null,
      label: l.shortcode || l.id,
    }));
}

// Premier champ numérique qui porte les clics d'une ligne de métriques.
// Liens directs : chaque visite (pageviews) = un clic vers la destination,
// comme les visites comptées côté GetAllMyLinks.
const CLICK_FIELDS = ['pageviews', 'clicks', 'total_clicks', 'visits', 'total_visits', 'views'];
function clicksOf(row) {
  for (const f of CLICK_FIELDS) {
    const v = row?.[f] ?? row?.metrics?.[f] ?? row?.totals?.[f];
    if (typeof v === 'number') return v;
  }
  return null;
}

// Date (YYYY-MM-DD) il y a N jours, heure de Paris
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Période du rapport : « hier » au sens de GetMySocial, heure de Paris
function yesterdayParams() {
  return { timeframe: 'yesterday', timezone: TIMEZONE };
}

// Clics d'hier pour une liste de liens → Map(linkId → clics)
function getYesterdayClicks(linkIds) {
  return getClicks(linkIds, yesterdayParams());
}

// Clics sur une période → Map(linkId → clics ou null si erreur).
// Un appel par lien : demander plusieurs liens d'un coup ne renvoie rien d'exploitable.
async function getClicks(linkIds, period) {
  const result = new Map();
  for (const linkId of linkIds) {
    try {
      const data = await callTool('get_link_metrics', { link_ids: [linkId], ...period });
      const row = itemsOf(data).find(r => (r.key ?? r.link_id ?? r.id) === linkId);
      // Pas de ligne pour ce lien sur la période = aucune visite
      result.set(linkId, row ? (clicksOf(row) ?? 0) : 0);
    } catch (err) {
      console.error(`[GMS] Erreur stats pour ${linkId}:`, err.message);
      result.set(linkId, null);
    }
  }
  return result;
}

// Pays retenus pour le rapport Twitter (codes ISO ; « UK » toléré pour GB)
const TARGET_COUNTRIES = ['US', 'GB', 'UK', 'AU', 'CA'];

// GMS renvoie { country: "United States of America", country_code: "US", count }
function countryOf(row) {
  return String(row.country_code ?? row.code ?? row.key ?? row.country ?? '').toUpperCase();
}

// Clics d'un lien sur la période, limités aux pays ciblés (null si erreur)
async function getCountryClicks(linkId, period) {
  const data = await callTool('get_top_countries', { link_ids: [linkId], ...period, limit: 100 });
  return itemsOf(data)
    .filter(row => TARGET_COUNTRIES.includes(countryOf(row)))
    .reduce((sum, row) => sum + (clicksOf(row) ?? row.count ?? row.value ?? 0), 0);
}

// Clics d'hier US/UK/AU/CA pour une liste de liens → Map(linkId → clics ou null)
async function getYesterdayTargetClicks(linkIds) {
  const result = new Map();
  for (const linkId of linkIds) {
    try {
      result.set(linkId, await getCountryClicks(linkId, yesterdayParams()));
    } catch (err) {
      console.error(`[GMS] Erreur pays pour ${linkId}:`, err.message);
      result.set(linkId, null);
    }
  }
  return result;
}

module.exports = {
  connect, listTools, callTool, getLinks, getYesterdayClicks, getClicks,
  getYesterdayTargetClicks, yesterdayParams, daysAgo, TIMEZONE,
};
