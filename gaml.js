// =============================================
//   gaml.js — Wrapper API GetAllMyLinks
// =============================================

const BASE_URL = 'https://getallmylinks.com/api/v1';

// Requête générique vers l'API GAML
async function fetchGAML(endpoint, params) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) url.searchParams.set(key, val);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'X-Api-Key': process.env.GAML_API_KEY,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GAML API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// Calcul du cycle courant
function getCurrentCycle(cycleConfig) {
  const { startDate, cycleDays, paymentDelayDays } = cycleConfig;
  const origin = new Date(startDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Avancer jusqu'au cycle qui contient aujourd'hui
  let cycleStart = new Date(origin);
  while (true) {
    const cycleEnd = new Date(cycleStart);
    cycleEnd.setDate(cycleEnd.getDate() + cycleDays - 1);
    if (cycleEnd >= today) {
      const payment = new Date(cycleEnd);
      payment.setDate(payment.getDate() + paymentDelayDays);
      const dayInCycle = Math.floor((today - cycleStart) / 86400000) + 1;
      return {
        start: fmt(cycleStart),
        end: fmt(cycleEnd),
        paymentDate: fmt(payment),
        dayInCycle,
        totalDays: cycleDays,
      };
    }
    cycleStart.setDate(cycleStart.getDate() + cycleDays);
  }
}

// Formate une date en YYYY-MM-DD
function fmt(d) {
  return d.toISOString().split('T')[0];
}

// Construit les paramètres de range pour l'API
function buildRangeParams(range, cycleConfig) {
  const today = new Date();

  if (range === 'cycle') {
    const cycle = getCurrentCycle(cycleConfig);
    return { range: 'custom', date_from: cycle.start, date_to: cycle.end };
  }
  if (range === 'today') return { range: 'today' };
  if (range === 'yesterday') return { range: 'yesterday' };
  if (range === '7days') return { range: '7days' };
  if (range === '14days') {
    const from = new Date(today);
    from.setDate(from.getDate() - 13);
    return { range: 'custom', date_from: fmt(from), date_to: fmt(today) };
  }
  return { range: '30days' };
}

// Récupère toutes les stats nécessaires pour l'embed
async function getStats(linkId, range, cycleConfig) {
  const rangeParams = buildRangeParams(range, cycleConfig);
  const params = { link_id: linkId, hide_bots: true, ...rangeParams };

  const [countries] = await Promise.all([
    fetchGAML('/analytics/countries', params),
  ]);

  return { countries, cycle: range === 'cycle' ? getCurrentCycle(cycleConfig) : null };
}

module.exports = { getStats, getCurrentCycle, buildRangeParams };
