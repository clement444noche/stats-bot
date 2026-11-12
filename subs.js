// =============================================
//   subs.js — Paie des VAs aux nouveaux subs (export CSV Infloww)
//
//   Le dimanche soir, un admin dépose l'export CSV des tracking links
//   Infloww dans un salon dont le nom contient « subs » (ex. #export-subs).
//   Infloww n'exporte que des totaux depuis la création de chaque lien
//   (son filtre de dates porte sur la date de création du lien) → le bot
//   retrouve dans le même salon l'export de la semaine d'avant et fait
//   la différence : nouveaux subs = total actuel − total précédent.
//   VA = nom du tracking link.
// =============================================

const { EmbedBuilder } = require('discord.js');

// Tarif par nouveau sub, en dollars (variable Railway SUB_PRICE, ex. « 1 » ou « 0.5 »)
const DEFAULT_SUB_PRICE = null; // à renseigner si pas de variable Railway

// Un export déposé moins de 3 jours avant n'est pas « la semaine d'avant »
// (ex. fichier redéposé après correction le même soir)
const MIN_GAP_MS = 3 * 86400000;

function subPriceCents() {
  const raw = (process.env.SUB_PRICE ?? DEFAULT_SUB_PRICE ?? '').toString().trim().replace(',', '.');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function dollars(cents) {
  return cents % 100 === 0
    ? `${cents / 100} $`
    : `${(cents / 100).toFixed(2).replace('.', ',')} $`;
}

// ── Lecture CSV (guillemets, virgule ou point-virgule, BOM) ─────────────────
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = [',', ';', '\t']
    .map(s => [s, firstLine.split(s).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

const norm = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Repère les colonnes : nom du lien, subs, et (si présentes) URL et créatrice
function findColumns(header) {
  const h = header.map(norm);
  const find = (...tests) => {
    for (const test of tests) {
      const i = h.findIndex(test);
      if (i !== -1) return i;
    }
    return -1;
  };
  const isRatio = x => /cvr|rate|conversion|cost|cps|aeps|arps|per /.test(x);
  return {
    subs: find(
      x => /^(total )?(subs|subscribers|subscriptions|new subs|new subscribers)$/.test(x),
      x => /\bsub(s|scriber|scription)/.test(x) && !isRatio(x),
    ),
    name: find(
      x => /^(tracking )?(link )?name$|^nom( du lien)?$|^campaign( name)?$/.test(x),
      x => /name|nom/.test(x) && !/creator|model|account|user/.test(x),
      x => /^(tracking )?link$/.test(x),
    ),
    url: find(x => /url|^link$|^lien$/.test(x) && !/name/.test(x)),
    creator: find(x => /creator|model|account|creatrice/.test(x)),
  };
}

function toInt(s) {
  const n = Number(String(s ?? '').replace(/[\s,]/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

// CSV → Map(clé du lien → { va, creator, subs })
function parseExport(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('fichier vide ou illisible');
  const header = rows[0];
  const col = findColumns(header);
  if (col.subs === -1 || col.name === -1) {
    throw new Error(`colonnes « nom du lien » / « subs » introuvables. Colonnes vues : ${header.join(' | ')}`);
  }

  const links = new Map();
  for (const r of rows.slice(1)) {
    const va = (r[col.name] ?? '').trim();
    if (!va || /^total/i.test(va)) continue; // ligne de total éventuelle
    const subs = toInt(r[col.subs]);
    if (Number.isNaN(subs)) continue;
    const creator = col.creator !== -1 ? (r[col.creator] ?? '').trim() : '';
    const url = col.url !== -1 ? (r[col.url] ?? '').trim() : '';
    // L'URL identifie le lien de façon sûre ; sinon nom + créatrice
    const key = url || `${norm(creator)}|${norm(va)}`;
    const prev = links.get(key);
    links.set(key, { va, creator, subs: (prev?.subs ?? 0) + subs });
  }
  if (!links.size) throw new Error('aucune ligne de lien lue dans le fichier');
  return { links, columns: { subs: header[col.subs], name: header[col.name] } };
}

// ── Nouveaux subs par VA ─────────────────────────────────────────────────────
// previous = null → pas d'export précédent : totaux depuis la création des liens
function computeNewSubs(current, previous) {
  const byVA = new Map();
  const warnings = [];
  for (const [key, link] of current) {
    let fresh;
    if (!previous) fresh = link.subs;
    else if (previous.has(key)) {
      fresh = link.subs - previous.get(key).subs;
      if (fresh < 0) {
        warnings.push(`⚠️ ${link.va} : ${previous.get(key).subs} → ${link.subs} subs (baisse, compté 0)`);
        fresh = 0;
      }
    } else fresh = link.subs; // lien créé cette semaine : tous ses subs sont nouveaux
    const k = norm(link.va);
    const e = byVA.get(k) ?? { name: link.va, subs: 0, links: 0, newLinks: 0 };
    e.subs += fresh;
    e.links++;
    if (previous && !previous.has(key)) e.newLinks++;
    byVA.set(k, e);
  }
  const results = [...byVA.values()].sort((a, b) => b.subs - a.subs || a.name.localeCompare(b.name));
  return { results, warnings };
}

// ── Discord ──────────────────────────────────────────────────────────────────
const csvOf = msg => [...msg.attachments.values()].find(a => /\.csv$/i.test(a.name ?? ''));

async function download(attachment) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`téléchargement du fichier impossible (${res.status})`);
  return res.text();
}

// Export précédent : dernier CSV du salon déposé au moins 3 jours avant
async function findPreviousExport(channel, current) {
  let before = current.id;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const msg of batch.values()) { // du plus récent au plus ancien
      if (msg.author.bot) continue;
      const att = csvOf(msg);
      if (att && current.createdTimestamp - msg.createdTimestamp >= MIN_GAP_MS) return { msg, att };
    }
    before = batch.last().id;
  }
  return null;
}

const frDate = ts => new Date(ts).toLocaleDateString('fr-FR',
  { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Paris' });

async function handleUpload(message, attachment) {
  const current = parseExport(await download(attachment));
  const prev = await findPreviousExport(message.channel, message);
  let previous = null;
  if (prev) {
    try {
      previous = parseExport(await download(prev.att)).links;
    } catch (err) {
      throw new Error(`export précédent (${frDate(prev.msg.createdTimestamp)}) illisible : ${err.message}`);
    }
  }

  const { results, warnings } = computeNewSubs(current.links, previous);
  const price = subPriceCents();
  const totalSubs = results.reduce((s, r) => s + r.subs, 0);

  const lines = results.map(r => {
    const s = r.subs > 1 ? 's' : '';
    let line = prev
      ? `👤 **${r.name}** → ${r.subs} nouveau${s ? 'x' : ''} sub${s}`
      : `👤 **${r.name}** → ${r.subs} sub${s} au total`;
    if (price !== null) line += ` → 💵 **${dollars(r.subs * price)}**`;
    if (r.newLinks) line += ' _(nouveau lien)_';
    return line;
  });

  const title = prev
    ? `🧾 Paie subs — du ${frDate(prev.msg.createdTimestamp)} au ${frDate(message.createdTimestamp)}`
    : `🧾 Subs — totaux depuis la création des liens (${frDate(message.createdTimestamp)})`;

  const notes = [];
  if (!prev) {
    notes.push('ℹ️ Aucun export précédent dans ce salon : ce fichier sert de **référence**. '
      + 'À partir du prochain dépôt, le bot comptera uniquement les nouveaux subs de la semaine.');
  }
  if (price === null) notes.push('⚠️ Tarif par sub non défini (variable Railway `SUB_PRICE`) : montants non calculés.');
  notes.push(...warnings);

  let footer = `Total : ${totalSubs} sub${totalSubs > 1 ? 's' : ''}`;
  if (price !== null) footer += ` • Total paie : ${dollars(totalSubs * price)} (${dollars(price)}/sub)`;
  footer += ` • Colonnes lues : « ${current.columns.name} » / « ${current.columns.subs} »`;

  const description = [...lines, ...(notes.length ? ['', ...notes] : [])].join('\n');
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description.slice(0, 4000) || '_Aucun lien_')
    .setColor(prev ? 0x57F287 : 0xFEE75C)
    .setFooter({ text: footer.slice(0, 2000) })
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// Dépôt d'un .csv par un admin dans un salon dont le nom contient « subs »
function register(client, isAdmin) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!/subs/i.test(message.channel.name ?? '')) return;
    const att = csvOf(message);
    if (!att) return;
    if (!isAdmin(message)) return message.reply('❌ Seul un admin peut déposer l’export des subs.');
    try {
      await handleUpload(message, att);
    } catch (err) {
      console.error('[Subs] Erreur:', err);
      await message.reply(`❌ Export non traité : ${err.message}`);
    }
  });
}

module.exports = { register, parseExport, computeNewSubs, parseCsv };
