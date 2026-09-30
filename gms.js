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
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
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

// Paramètres communs : la journée d'hier, heure de Paris
function yesterdayParams() {
  const d = yesterdayDate();
  return { start_date: d, end_date: d, timezone: TIMEZONE };
}

// Clics d'hier pour une liste de liens → Map(linkId → clics)
function getYesterdayClicks(linkIds) {
  return getClicks(linkIds, yesterdayParams());
}

// Clics sur une période { start_date, end_date, timezone } → Map(linkId → clics)
async function getClicks(linkIds, period) {
  const result = new Map();
  for (let i = 0; i < linkIds.length; i += 50) {
    const batch = linkIds.slice(i, i + 50);
    const data = await callTool('get_link_metrics', {
      link_ids: batch, ...period, limit: 100,
    });
    for (const row of itemsOf(data)) {
      const id = row.key ?? row.link_id ?? row.id ?? row.link?.id;
      const clicks = clicksOf(row);
      if (id && clicks !== null) result.set(id, clicks);
    }
  }
  return result;
}

module.exports = {
  connect, listTools, callTool, getLinks, getYesterdayClicks, getClicks,
  yesterdayParams, daysAgo, TIMEZONE,
};
