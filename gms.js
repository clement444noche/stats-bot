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

module.exports = { connect, listTools, callTool };
