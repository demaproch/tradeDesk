// ============================================================
// Validation des paramètres modifiables via le dashboard
// Chaque paramètre a : type, bornes, et une fonction d'application
// sur l'objet CONFIG. Les valeurs invalides sont rejetées avec un
// message d'erreur explicite (aucune mutation partielle).
// ============================================================

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

/** Schéma des paramètres éditables : key -> validateur */
const PARAM_SCHEMA = {
  timeframe:        { type: 'enum', values: TIMEFRAMES },
  cycleMs:          { type: 'int',   min: 5_000,        max: 600_000,    label: 'Intervalle du cycle (ms)' },
  lookbackCandles:  { type: 'int',   min: 2,            max: 100,        label: 'Bougies (variation)' },
  minMovePct:       { type: 'float', min: 0.01,         max: 50,         label: 'Variation min (%)' },
  rsiPeriod:        { type: 'int',   min: 2,            max: 100,        label: 'Période RSI' },
  rsiLongMin:       { type: 'float', min: 0,            max: 100,        label: 'RSI min LONG' },
  rsiShortMax:      { type: 'float', min: 0,            max: 100,        label: 'RSI max SHORT' },
  riskPct:          { type: 'float', min: 0.1,          max: 100,        label: 'Risque par trade (%)' },
  leverage:         { type: 'float', min: 1,            max: 12,         label: 'Levier (x)' },
  takeProfitPct:    { type: 'float', min: 0.05,         max: 100,        label: 'Take Profit (%)' },
  stopLossPct:      { type: 'float', min: 0.05,         max: 100,        label: 'Stop Loss (%)' },
  cooldownMs:       { type: 'int',   min: 0,            max: 24 * 3600_000, label: 'Cooldown (ms)' },
};

// Garde-fou de cohérence : rsiShortMax < rsiLongMin
function checkCoherence(cfg) {
  if (cfg.rsiShortMax >= cfg.rsiLongMin) {
    return 'Cohérence invalide : RSI max SHORT doit être strictement inférieur à RSI min LONG.';
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

module.exports = { PARAM_SCHEMA, TIMEFRAMES, validatePatch, checkCoherence, editableKeys };
