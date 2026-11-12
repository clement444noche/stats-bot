// =============================================
//   onboarding.js — Accueil automatique des nouveaux VAs
//   Quand un manager donne le rôle « VA Insta » à quelqu'un :
//   1. le bot crée son salon 1:1 « 🏁nom-JJ-MM » dans la catégorie
//      « Canaux 1:1 VA (<manager>) » (format géré par les pastilles)
//   2. il y poste le message de bienvenue (manager, CEO, salons à lire)
// =============================================

const {
  ChannelType, AuditLogEvent, PermissionsBitField, OverwriteType,
} = require('discord.js');

const ROLE_NAME = process.env.ONBOARDING_ROLE_NAME || 'VA Insta';
const AGENCY = process.env.AGENCY_NAME || 'Aura Hub';
// « Canaux 1:1 VA (Carl) », « Canaux 1:1 (Hermes) » (pas Twitter ni Manageur)
const CATEGORY_PATTERN = /^canaux 1:1 (va )?\(/i;
const managerOf = cat => cat.name.match(/\(([^)]*)\)/)?.[1] ?? '';
const FLAG = '🏁';
const TRIAL_DAYS = 7;

// Salons cités dans le message, dans l'ordre (clé = nom normalisé)
const GUIDE_CHANNELS = [
  { key: 'sop', label: 'sop', desc: 'le fonctionnement de l\'agence et les consignes à respecter' },
  { key: 'formation', label: 'formation', desc: 'la formation pour bien démarrer' },
  { key: 'remuneration', label: 'remuneration', desc: 'notre système de rémunération' },
  { key: 'preuvedepaiement', label: 'preuve-de-paiement', desc: 'les preuves de paiement des VAs' },
  { key: 'infosurgentes', label: 'infos-urgentes', desc: 'les annonces importantes, à surveiller régulièrement' },
];

const CEO_NAMES = ['nathan', 'clem'];

// « Mialitíana » → « mialitiana »
function normalize(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Nom de salon Discord : « Jean Paul ! » → « jean-paul »
function slug(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'va';
}

// Partie « nom » d'un salon 1:1 (sans emojis ni date ni annotation)
function channelBase(name) {
  return name.replace(/^[^\p{L}\p{N}]*/u, '');
}

function trialEndLabel() {
  const d = new Date(Date.now() + TRIAL_DAYS * 86400000);
  const [day, month] = d.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'numeric', timeZone: 'Europe/Paris',
  }).split('/');
  return `${Number(day)}-${Number(month)}`;
}

// Salon texte dont le nom (sans emojis) vaut la clé, sinon commence par elle
function findGuideChannel(guild, key) {
  const texts = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
  return texts.find(c => normalize(c.name) === key)
    ?? texts.find(c => normalize(c.name).startsWith(key))
    ?? null;
}

function findCeos(guild) {
  const ids = (process.env.CEO_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length) return ids.map(id => `<@${id}>`);
  return CEO_NAMES.map(n => {
    const m = guild.members.cache.find(mem =>
      !mem.user.bot && [mem.displayName, mem.user.username, mem.user.globalName]
        .some(x => normalize(x) === n));
    return m ? `<@${m.id}>` : `@${n[0].toUpperCase()}${n.slice(1)}`;
  });
}

// Qui a donné le rôle ? (journal d'audit, il faut la permission
// « Voir les logs du serveur »). null si introuvable.
async function findManager(member, role) {
  try {
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 });
    const entry = logs.entries.find(e =>
      e.target?.id === member.id
      && Date.now() - e.createdTimestamp < 60_000
      && e.changes.some(c => c.key === '$add' && c.new?.some(r => r.id === role.id)));
    if (!entry?.executor || entry.executor.bot) return null;
    return await member.guild.members.fetch(entry.executor.id).catch(() => null);
  } catch (err) {
    console.warn('[Onboarding] Journal d\'audit illisible :', err.message);
    return null;
  }
}

// Catégorie du manager (« Canaux 1:1 VA (Carl) ») ; null si aucune
function pickCategory(guild, manager) {
  if (!manager) return null;
  // Pseudo du manager + son rôle « Manager VA Insta Carl » → « carl »
  const fromRoles = manager.roles.cache
    .map(r => r.name.match(/^manager va insta (.+)$/i)?.[1]).filter(Boolean);
  const names = [manager.displayName, manager.user.username, manager.user.globalName, ...fromRoles]
    .map(normalize).filter(n => n.length >= 3);
  return guild.channels.cache.find(c => {
    if (c.type !== ChannelType.GuildCategory || !CATEGORY_PATTERN.test(c.name)) return false;
    const n = normalize(managerOf(c));
    return n.length >= 3 && names.some(x => x.includes(n) || n.includes(x));
  }) ?? null;
}

// Prévient les managers quand le bot ne sait pas où créer le salon
async function alertManagers(guild, text) {
  const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && normalize(c.name) === 'chatcommunmanager');
  if (ch) await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

// Salon 1:1 déjà existant pour ce VA (nom ou accès perso)
function findExistingChannel(guild, member) {
  const name = slug(member.displayName);
  return guild.channels.cache.find(c => {
    if (c.type !== ChannelType.GuildText || !c.parent || !CATEGORY_PATTERN.test(c.parent.name)) return false;
    if (c.permissionOverwrites.cache.has(member.id)) return true;
    const base = channelBase(c.name);
    return base === name || base.startsWith(`${name}-`);
  }) ?? null;
}

function buildMessage(guild, member, manager) {
  const [ceo1, ceo2] = findCeos(guild);
  const guides = GUIDE_CHANNELS.map(g => {
    const ch = findGuideChannel(guild, g.key);
    return `• ${ch ? `<#${ch.id}>` : `#${g.label}`} — ${g.desc}`;
  });

  const managerLine = manager
    ? `Moi c'est <@${manager.id}>, ton manager 🫡 Je suis là pour t'accompagner afin que tu puisses bien performer et progresser au sein de l'agence.`
    : 'Ton manager va te rejoindre ici très vite : il est là pour t\'accompagner afin que tu puisses bien performer et progresser au sein de l\'agence.';

  return [
    `Hey <@${member.id}> 👋`,
    '',
    `Tout d'abord, bienvenue chez **${AGENCY}** ! 🤝`,
    '',
    managerLine,
    `${ceo1} et ${ceo2} sont les CEO de l'agence.`,
    'On est tous là pour t\'aider : au moindre souci, dis-le nous simplement.',
    '',
    '📚 **Avant de commencer, prends le temps de lire :**',
    ...guides,
    '',
    '🚀 **La suite**',
    'Une fois que tu as tout lu, fais-moi signe ici ✅ et on passera ensemble à la création de tes comptes.',
    '',
    '❓ **Une question ?** N\'hésite surtout pas à venir m\'en parler, je suis là pour t\'aider 💪',
    '',
    'Bienvenue dans l\'équipe et bonne intégration ! 🔥',
  ].join('\n');
}

// Crée (ou retrouve) le salon 1:1 et y poste le message
async function onboard(member, { manager = undefined } = {}) {
  const guild = member.guild;
  const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
  if (manager === undefined) manager = role ? await findManager(member, role) : null;

  let channel = findExistingChannel(guild, member);
  let created = false;

  if (!channel) {
    const category = pickCategory(guild, manager);
    if (!category) {
      const who = manager ? `**${manager.displayName}** n'a pas de catégorie « Canaux 1:1 » à son nom`
        : "je n'ai pas trouvé qui a donné le rôle";
      await alertManagers(guild, `⚠️ Rôle « ${ROLE_NAME} » donné à <@${member.id}>, mais ${who}. `
        + `Un admin peut lancer \`!onboarding @${member.displayName} @Manager\` pour créer son salon et envoyer le message.`);
      throw new Error(manager ? `pas de catégorie 1:1 pour ${manager.displayName}` : 'manager introuvable');
    }

    // Sans permissionOverwrites, Discord synchronise le salon avec la
    // catégorie (mêmes accès managers/CEO) ; il est ajouté en bas
    const reason = `Onboarding de ${member.user.tag} (rôle ${ROLE_NAME})`;
    channel = await guild.channels.create({
      name: `${FLAG}${slug(member.displayName)}-${trialEndLabel()}`,
      type: ChannelType.GuildText,
      parent: category.id,
      reason,
    });
    created = true;

    // Accès du VA : uniquement des permissions que le bot possède lui-même
    // (Discord refuse qu'un bot accorde une permission qu'il n'a pas)
    const F = PermissionsBitField.Flags;
    const botPerms = guild.members.me.permissions;
    const wanted = [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.EmbedLinks, F.AttachFiles, F.AddReactions];
    const allow = Object.fromEntries(wanted.filter(p => botPerms.has(p))
      .map(p => [Object.keys(F).find(k => F[k] === p), true]));
    await channel.permissionOverwrites.create(member.id, allow, { reason, type: OverwriteType.Member });
  }

  await channel.send({
    content: buildMessage(guild, member, manager),
    allowedMentions: { parse: ['users'] },
  });
  return { channel, created, manager };
}

// Évite un double envoi si Discord émet deux événements rapprochés
const inProgress = new Set();

function register(client) {
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const role = newMember.guild.roles.cache.find(r => r.name === ROLE_NAME);
    if (!role) return;
    if (oldMember.roles.cache.has(role.id) || !newMember.roles.cache.has(role.id)) return;
    if (inProgress.has(newMember.id)) return;

    inProgress.add(newMember.id);
    try {
      const { channel, created, manager } = await onboard(newMember);
      console.log(`[Onboarding] ${newMember.user.tag} → #${channel.name}`
        + `${created ? ' (créé)' : ' (existant)'}, manager : ${manager?.displayName ?? 'inconnu'}`);
    } catch (err) {
      console.error(`[Onboarding] Erreur pour ${newMember.user.tag} :`, err);
    } finally {
      setTimeout(() => inProgress.delete(newMember.id), 30_000);
    }
  });
}

module.exports = { register, onboard, buildMessage, ROLE_NAME };
