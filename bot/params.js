// ============================================================
// Validation des paramètres modifiables via le dashboard
// Chaque paramètre a : type, bornes, et une fonction d'application
// sur l'objet CONFIG. Les valeurs invalides sont rejetées avec un
// message d'erreur explicite (aucune mutation partielle).
// ============================================================

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

/** Groupes affichés dans le panneau « Paramètres » du dashboard */
const PARAM_GROUPS = [
  { id: 'signal',     title: 'Signal d\'entrée', icon: '📡' },
  { id: 'money',      title: 'Money management', icon: '💰' },
  { id: 'exits',      title: 'Sorties TP / SL', icon: '🎯' },
  { id: 'execution',  title: 'Exécution & cadence', icon: '⚙️' },
];

/**
 * Schéma des paramètres éditables : key -> validateur + métadonnées UI.
 * `ui` : groupe, ordre ('core' = toujours visible, 'advanced' = replié),
 *        unité affichée et aide contextuelle.
 */
const PARAM_SCHEMA = {
  timeframe:        { type: 'enum', values: TIMEFRAMES, label: 'Timeframe', group: 'execution', order: 'core', help: 'Intervalle des bougies analysées.' },
  minMovePct:       { type: 'float', min: 0.01,         max: 50,         label: 'Variation minimale', unit: '%', step: 0.05, group: 'signal', order: 'core', help: 'Mouvement de prix requis sur les N dernières bougies (momentum).' },
  rsiLongMin:       { type: 'float', min: 0,            max: 100,        label: 'RSI — seuil LONG', unit: '', step: 0.5, group: 'signal', order: 'core', help: 'LONG ouvert si RSI strictement au-dessus de ce seuil.' },
  rsiShortMax:      { type: 'float', min: 0,            max: 100,        label: 'RSI — seuil SHORT', unit: '', step: 0.5, group: 'signal', order: 'core', help: 'SHORT ouvert si RSI strictement en dessous de ce seuil.' },
  lookbackCandles:  { type: 'int',   min: 2,            max: 100,        label: 'Bougies (variation)', unit: '', step: 1, group: 'signal', order: 'advanced', help: 'Nombre de bougies sur lesquelles la variation est mesurée.' },
  rsiPeriod:        { type: 'int',   min: 2,            max: 100,        label: 'Période RSI', unit: '', step: 1, group: 'signal', order: 'advanced', help: 'Période de calcul du RSI (Wilder).' },
  riskPct:          { type: 'float', min: 0.1,          max: 100,        label: 'Risque par trade', unit: '%', step: 0.5, group: 'money', order: 'core', help: 'Fraction du capital engagée en marge sur chaque position.' },
  leverage:         { type: 'float', min: 1,            max: 12,         label: 'Levier', unit: 'x', step: 1, group: 'money', order: 'core', help: 'Plafonné à 12x (maxLeverage). Exposition = marge × levier.' },
  takeProfitPct:    { type: 'float', min: 0.05,         max: 100,        label: 'Take Profit', unit: '%', step: 0.1, group: 'exits', order: 'core', help: 'Fermeture automatique quand le mouvement du prix atteint +TP (dans le sens de la position).' },
  stopLossPct:      { type: 'float', min: 0.05,         max: 100,        label: 'Stop Loss', unit: '%', step: 0.1, group: 'exits', order: 'core', help: 'Fermeture automatique quand le mouvement du prix atteint −SL.' },
  cycleMs:          { type: 'int',   min: 5_000,        max: 600_000,    label: 'Intervalle du cycle', unit: 'ms', step: 1000, group: 'execution', order: 'advanced', help: 'Fréquence d\'analyse des paires.' },
  cooldownMs:       { type: 'int',   min: 0,            max: 24 * 3600_000, label: 'Cooldown', unit: 'ms', step: 30_000, group: 'execution', order: 'advanced', help: 'Délai minimum entre deux trades sur un même symbole.' },
};

// Garde-fous de cohérence entre paramètres croisés
function checkCoherence(cfg) {
  if (cfg.rsiShortMax >= cfg.rsiLongMin) {
    return 'Cohérence invalide : RSI seuil SHORT doit être strictement inférieur au RSI seuil LONG.';
  }
  if (cfg.timeframe === '1m' && cfg.cycleMs < 20_000) {
    return 'En timeframe 1m, le cycle ne peut pas être inférieur à 20 000 ms (les bougies se forment chaque minute).';
  }
  return null;
}

/**
 * Valide un patch { key: value }.
 * @returns {{ ok:boolean, error?:string, changes?:object }}
 *   changes = paires clé/valeur validées (converties au bon type).
 */
function validatePatch(patch, currentCfg) {
  const errors = [];
  const changes = {};

  for (const [key, raw] of Object.entries(patch)) {
    const spec = PARAM_SCHEMA[key];
    if (!spec) {
      errors.push(`Paramètre inconnu : « ${key} »`);
      continue;
    }
    if (raw === undefined || raw === null || raw === '') {
      errors.push(`${spec.label || key} : valeur vide`);
      continue;
    }

    if (spec.type === 'enum') {
      if (!spec.values.includes(raw)) {
        errors.push(`${spec.label || key} : valeur « ${raw} » non autorisée (${spec.values.join(', ')})`);
        continue;
      }
      changes[key] = raw;
      continue;
    }

    const num = Number(raw);
    if (!Number.isFinite(num)) {
      errors.push(`${spec.label || key} : « ${raw} » n'est pas un nombre`);
      continue;
    }
    if (spec.type === 'int' && !Number.isInteger(num)) {
      errors.push(`${spec.label || key} : doit être un entier`);
      continue;
    }
    if (num < spec.min || num > spec.max) {
      errors.push(`${spec.label || key} : hors bornes [${spec.min} … ${spec.max}]`);
      continue;
    }
    changes[key] = num;
  }

  // Cohérence croisée sur l'état fusionné (courant + nouveau)
  if (errors.length === 0 && Object.keys(changes).length > 0) {
    const merged = { ...currentCfg, ...changes };
    const co = checkCoherence(merged);
    if (co) errors.push(co);
  }

  if (errors.length > 0) return { ok: false, error: errors.join(' | ') };
  return { ok: true, changes };
}

/** Liste des clés éditables (pour exposer le schéma au dashboard) */
function editableKeys() {
  return Object.keys(PARAM_SCHEMA);
}

module.exports = { PARAM_SCHEMA, PARAM_GROUPS, TIMEFRAMES, validatePatch, checkCoherence, editableKeys };
