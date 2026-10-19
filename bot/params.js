// ============================================================
// Validation des paramètres modifiables via le dashboard
// Chaque paramètre a : type, bornes, et une fonction d'application
// sur l'objet CONFIG. Les valeurs invalides sont rejetées avec un
// message d'erreur explicite (aucune mutation partielle).
// ============================================================

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

/** Groupes affichés dans le panneau « Paramètres » du dashboard */
const PARAM_GROUPS = [
  { id: 'markets',    title: 'Marché & paires', icon: '🪙' },
  { id: 'signal',     title: 'Signal d\'entrée', icon: '📡' },
  { id: 'money',      title: 'Money management', icon: '💰' },
  { id: 'exits',      title: 'Sorties TP / SL', icon: '🎯' },
  { id: 'filters',    title: 'Filtres avancés', icon: '🧪' },
  { id: 'execution',  title: 'Exécution & cadence', icon: '⚙️' },
  { id: 'mode',       title: 'Mode de trading (paper / réel)', icon: '🔐' },
];

/** Le levier maximum autorisé dépend du mode : 12x en paper, bridé à 5x en réel. */
const MAX_LEVERAGE_PAPER = 12;
const MAX_LEVERAGE_REAL = 5;

/**
 * Schéma des paramètres éditables : key -> validateur + métadonnées UI.
 * `ui` : groupe, ordre ('core' = toujours visible, 'advanced' = replié),
 *        unité affichée et aide contextuelle.
 */
const PARAM_SCHEMA = {
  symbols:          { type: 'symbols', label: 'Paires à trader', unit: '', group: 'markets', order: 'core', help: 'Cases activées = paires surveillées et tradées par le bot. Les positions ouvertes restent gérées même si la paire est décochée.' },
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
  trailingPct:      { type: 'float', min: 0,            max: 50,         label: 'Trailing stop', unit: '%', step: 0.1, group: 'exits', order: 'core', help: '0 = désactivé. Le stop suit le meilleur mouvement atteint, à cette distance en retrait. Ne remonte jamais sous le SL initial.' },
  breakEvenPct:     { type: 'float', min: 0,            max: 50,         label: 'Break-even dès', unit: '%', step: 0.1, group: 'exits', order: 'core', help: '0 = désactivé. Dès que le gain a atteint ce %, le stop est remonté au prix d\'entrée (plus de perte possible hors frais).' },
  emaTrendFilter:   { type: 'int',   min: 0,            max: 400,        label: 'Filtre tendance EMA', unit: '', step: 5, group: 'filters', order: 'core', help: '0 = désactivé. LONG autorisé seulement si clôture > EMA(N) du timeframe supérieur ; SHORT seulement si < EMA(N).' },
  trendTimeframe:   { type: 'enum', values: ['15m', '30m', '1h', '4h'], label: 'TF filtre tendance', group: 'filters', order: 'core', help: 'Timeframe sur lequel l\'EMA de filtrage est calculée (multi-timeframe).' },
  maxTotalExposurePct: { type: 'float', min: 20,        max: 1000,       label: 'Exposition totale max', unit: '%', step: 10, group: 'filters', order: 'core', help: 'Plafond de notionnel cumulé toutes positions (% du capital). Limite la surexposition corrélée (BTC+ETH+SOL montent et baissent ensemble).' },
  tradingHoursUTC:  { type: 'string', pattern: /^$|^\d{1,2}-\d{1,2}$/, label: 'Heures de trade (UTC)', group: 'filters', order: 'advanced', help: 'Vide = toujours. Ex. \"13-21\" : ouvre des trades uniquement entre 13 h et 21 h UTC. Les sorties TP/SL restent actives 24/7.' },
  observeOnly:      { type: 'bool', label: 'Mode observation', group: 'mode', order: 'core', help: 'Le bot calcule et journalise les signaux sans JAMAIS ouvrir de position (paper ni réel). Idéal pour valider une config avant de trader.' },
  useExchangeStops: { type: 'bool', label: 'Stops côté exchange', group: 'mode', order: 'core', help: 'Mode réel : place de vrais ordres STOP_MARKET / TAKE_PROFIT_MARKET sur l\'exchange. La position reste protégée même si le bot ou le PC meurt.' },
  cycleMs:          { type: 'int',   min: 5_000,        max: 600_000,    label: 'Intervalle du cycle', unit: 'ms', step: 1000, group: 'execution', order: 'advanced', help: 'Fréquence d\'analyse des paires.' },
  cooldownMs:       { type: 'int',   min: 0,            max: 24 * 3600_000, label: 'Cooldown', unit: 'ms', step: 30_000, group: 'execution', order: 'advanced', help: 'Délai minimum entre deux trades sur un même symbole.' },
  feePct:           { type: 'float', min: 0,            max: 1,           label: 'Frais par jambe', unit: '%', step: 0.01, group: 'execution', order: 'core', help: 'Frais taker estimés appliqués à l\'entrée ET à la sortie de chaque trade (0 = ignore les frais).' },
  tradingMode:      { type: 'enum', values: ['paper', 'real'], label: 'Mode de trading', group: 'mode', order: 'core', help: '"Paper" = simulation sur prix réels. "Réel" = ordres envoyés sur l\'exchange avec les clés API du coffre (levier bridé à 5x, risque plafonné à 25 %).' },
  initialCapital:   { type: 'float', min: 10,           max: 1_000_000,   label: 'Capital simulé', unit: '$', step: 10, group: 'money', order: 'advanced', help: 'Capital de départ de la simulation (reset du carnet paper). Sans effet en mode réel.' },
};

/** Paires proposées au dashboard : univers connu + paires actuellement actives */
const KNOWN_SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'AVAX/USDT:USDT', 'SUI/USDT:USDT',
  'BNB/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'LINK/USDT:USDT', 'APT/USDT:USDT',
  'ARB/USDT:USDT', 'OP/USDT:USDT', 'NEAR/USDT:USDT', 'TIA/USDT:USDT', 'SEI/USDT:USDT',
];
function symbolUniverse(currentSymbols) {
  return [...new Set([...(currentSymbols || []), ...KNOWN_SYMBOLS])];
}

/** Symbole Binance perpetual USDT correspondant à une paire (ex. BTC/USDT:USDT -> BTCUSDT). */
function perpSymbol(sym) {
  return String(sym).split(':')[0].replace('/', '');
}

/** Vérifie que le marché existe sur l'exchange chargé ; sinon erreur explicite. */
async function validateSymbolOnExchange(exchange, sym) {
  try {
    await exchange.loadMarkets();
    if (exchange.markets && exchange.markets[sym]) return null;
    // tentative de normalisation via ccxt
    try {
      const m = exchange.market(sym);
      if (m && m.symbol) return null;
    } catch (_) { /* inconnu */ }
    return `Marché inconnu sur ${exchange.id} : « ${sym} »`;
  } catch (e) {
    // impossible de vérifier (réseau…) : on n'ajoute pas un marché non vérifié pour autant
    return `Vérification du marché « ${sym} » impossible (${e.message}). Réessaie quand la connexion est rétablie.`;
  }
}

/**
 * Valide une liste de paires (tableau ou chaîne séparée par des virgules).
 * @returns {{ok:boolean, error?:string, value?:string[]}}
 */
function normalizeSymbols(raw) {
  let list = raw;
  if (typeof raw === 'string') list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(list)) return { ok: false, error: 'Paires : format invalide.' };
  const seen = new Set();
  const out = [];
  for (let s of list) {
    s = String(s).trim().toUpperCase();
    if (!s) continue;
    if (!/:USDT$/.test(s)) s += ':USDT'; // accepte "BTC/USDT" -> "BTC/USDT:USDT"
    if (!/^[A-Z0-9]+\/USDT:USDT$/.test(s)) {
      return { ok: false, error: `Paire invalide : « ${s} » (format attendu BASE/USDT:USDT, ex. BTC/USDT:USDT)` };
    }
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  if (out.length === 0) return { ok: false, error: 'Au moins une paire doit être sélectionnée.' };
  if (out.length > 20) return { ok: false, error: 'Maximum 20 paires (garde-fous : requêtes API et clarté du dashboard).' };
  return { ok: true, value: out };
}

// Garde-fous de cohérence entre paramètres croisés
function checkCoherence(cfg) {
  if (cfg.rsiShortMax >= cfg.rsiLongMin) {
    return 'Cohérence invalide : RSI seuil SHORT doit être strictement inférieur au RSI seuil LONG.';
  }
  if (cfg.timeframe === '1m' && cfg.cycleMs < 20_000) {
    return 'En timeframe 1m, le cycle ne peut pas être inférieur à 20 000 ms (les bougies se forment chaque minute).';
  }
  if (cfg.trailingPct > 0 && cfg.trailingPct >= cfg.takeProfitPct) {
    return `Trailing stop (${cfg.trailingPct}%) invalide : doit être strictement inférieur au Take Profit (${cfg.takeProfitPct}%), sinon le TP ne serait jamais atteignable.`;
  }
  if (cfg.breakEvenPct > 0 && cfg.breakEvenPct >= cfg.takeProfitPct) {
    return `Break-even dès ${cfg.breakEvenPct}% invalide : doit être inférieur au Take Profit (${cfg.takeProfitPct}%).`;
  }
  // Mode réel : garde-fous renforcés (levier et risque plafonnés)
  const maxLev = cfg.tradingMode === 'real' ? MAX_LEVERAGE_REAL : MAX_LEVERAGE_PAPER;
  if (cfg.leverage > maxLev) {
    return `Levier ${cfg.leverage}x refusé en mode ${cfg.tradingMode === 'real' ? 'RÉEL' : 'paper'} : maximum autorisé ${maxLev}x.`;
  }
  if (cfg.tradingMode === 'real' && cfg.riskPct > 25) {
    return 'Mode RÉEL : risque par trade plafonné à 25 % du capital (garde-fou anti-ruine).';
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

    if (spec.type === 'bool') {
      const b = raw === true || raw === 'true' || raw === 1 || raw === '1';
      const nb = raw === false || raw === 'false' || raw === 0 || raw === '0';
      if (!b && !nb) { errors.push(`${spec.label || key} : valeur booléenne attendue`); continue; }
      changes[key] = b;
      continue;
    }

    if (spec.type === 'string') {
      const s = String(raw).trim();
      if (spec.pattern && !spec.pattern.test(s)) {
        errors.push(`${spec.label || key} : format invalide (ex. « 13-21 » ou vide)`);
        continue;
      }
      changes[key] = s;
      continue;
    }

    if (spec.type === 'symbols') {
      const norm = normalizeSymbols(raw);
      if (!norm.ok) { errors.push(norm.error); continue; }
      changes[key] = norm.value;
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

module.exports = { PARAM_SCHEMA, PARAM_GROUPS, TIMEFRAMES, KNOWN_SYMBOLS, MAX_LEVERAGE_PAPER, MAX_LEVERAGE_REAL, validatePatch, checkCoherence, editableKeys, normalizeSymbols, symbolUniverse, perpSymbol, validateSymbolOnExchange };
