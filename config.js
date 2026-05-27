// =============================================
//   config.js — Paramètres métier à adapter
// =============================================

module.exports = {

  // --- Cycle de paiement ---
  cycle: {
    startDate: '2026-05-02',   // Date de début du 1er cycle (format YYYY-MM-DD)
    cycleDays: 14,             // Durée d'un cycle en jours
    paymentDelayDays: 1,       // Paiement N jours après la fin du cycle
  },

  // --- Seuil de paiement ---
  payment: {
    thresholdClicks: 500,      // Nombre de clics payables pour débloquer le paiement
    amountOnThreshold: 20,     // Montant en $ débloqué quand le seuil est atteint
  },

  // --- Pays Tier-1 (= "bons clics") ---
  // Tous les autres codes pays seront comptés comme "mauvais clics"
  tier1Countries: [
    'US', 'CA', 'GB', 'AU', 'NZ',                          // Anglosphere
    'FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT',        // Europe occidentale
    'PT', 'IE', 'LU', 'DK', 'SE', 'NO', 'FI',              // Europe nordique
    'JP', 'SG', 'HK',                                        // Asie premium
  ],

  // --- Labels qualité ---
  // Basé sur le % de bons clics
  qualityLabels: [
    { min: 90, label: 'excellent 💎' },
    { min: 75, label: 'bon 🌟' },
    { min: 50, label: 'moyen ⚡' },
    { min: 0,  label: 'faible ⚠️' },
  ],
};
