// ============================================================
// Bot principal : boucle de stratégie + dashboard web (Express + WS)
//
//   node bot.js              -> paper trading avec prix réels Binance
//   node bot.js --demo       -> données simulées (fonctionne sans internet)
//
// Points clés (corrections "bot qui ne fait que perdre") :
//   1. Les signaux sont calculés UNIQUEMENT sur des clôtures dures de
//      bougies closes (la dernière bougie de l'API, en cours de formation,
//      est écartée). Fini les entrées au milieu d'une bougie qui se
//      retournent immédiatement contre nous.
//   2. Un trade n'est ouvert qu'une fois par nouvelle bougie close
//      (détection sur le timestamp de la dernière clôture), pas à chaque
//      cycle de 5 s sur la même bougie.
//   3. TP/SL évalués sur les clôtures, exécutés AUX PRIX EXACTS du TP/SL.
//   4. Frais taker estimés (feePct par jambe) déduits du PnL réalisé.
//
// momBot — Dashboard : http://localhost:3000
// ============================================================

const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const ccxt = require('ccxt');
const CONFIG = require('./config');
const { rsi, priceChangePct } = require('./indicators');
const TradingEngine = require('./engine');
const { TF_MS, closedCandles, aggregate } = require('./candles');
const { PARAM_SCHEMA, PARAM_GROUPS, TIMEFRAMES, validatePatch, editableKeys, symbolUniverse, perpSymbol, validateSymbolOnExchange, MAX_LEVERAGE_PAPER, MAX_LEVERAGE_REAL } = require('./params');
const { AuthManager } = require('./auth');
const { SecretStore } = require('./secrets');

// Persistance des paramètres modifiés via le dashboard (survivants aux redémarrages)
const PARAMS_FILE = path.join(__dirname, 'params.overrides.json');
const DEFAULTS = {};
for (const k of editableKeys()) DEFAULTS[k] = CONFIG[k];

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (editableKeys().includes(k)) CONFIG[k] = v;
    }
    console.log(`💾 Overrides de paramètres chargés (${Object.keys(raw).length} clé(s)).`);
  } catch { /* premier lancement : rien à charger */ }
}

function saveOverrides() {
  const out = {};
  for (const k of editableKeys()) out[k] = CONFIG[k];
  try { fs.writeFileSync(PARAMS_FILE, JSON.stringify(out, null, 2)); }
  catch (e) { console.warn('⚠️ Sauvegarde des paramètres impossible :', e.message); }
}

const DEMO = process.argv.includes('--demo');

/** Prix de départ déterministe en mode démo pour une paire hors liste connue. */
function hashPrice(sym) {
  let h = 0;
  for (const ch of String(sym)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Math.pow(10, 1 + (h % 5)); // 10 … 100 000
}

// ---------- Source de données (prix réels ou démo) ----------

class MarketData {
  constructor(cfg) {
    this.cfg = cfg;
    this.exchange = null;
    this.demoState = new Map(); // symbol -> { price, candles }
  }

  async init() {
    if (DEMO) {
      // prix de base réalistes par symbole pour le mode démo
      const bases = { 'BTC/USDT:USDT': 65000, 'ETH/USDT:USDT': 3200, 'SOL/USDT:USDT': 150, 'AVAX/USDT:USDT': 35, 'SUI/USDT:USDT': 1.2 };
      for (const sym of this.cfg.symbols) {
        let p = bases[sym] ?? hashPrice(sym);
        const candles = [];
        for (let i = 0; i < this.cfg.candlesLimit; i++) {
          p *= 1 + (Math.random() - 0.5) * 0.004;
          candles.push({ close: p });
        }
        this.demoState.set(sym, { price: p, candles, drift: (Math.random() - 0.5) * 0.002 });
      }
      console.log('🧪 Mode DÉMO : marché simulé (pas besoin d\'internet).');
      return;
    }
    const ExClass = ccxt[CONFIG.exchange];
    this.exchange = new ExClass({ enableRateLimit: true });
    // Sélection du marché : perpetuals USDT (pour pouvoir SHORTER) ou spot en fallback
    try {
      if (CONFIG.marketType === 'future' && typeof this.exchange.setSandboxMode !== 'function') {
        if (this.exchange.options) this.exchange.options.defaultType = 'swap'; // binance linear futures
        await this.exchange.loadMarkets();
      } else {
        await this.exchange.loadMarkets();
      }
    } catch (e) {
      this.engine_warn = e.message;
      console.warn('⚠️  loadMarkets a échoué, repli sur les valeurs par défaut :', e.message);
    }
    console.log(`🌐 Mode LIVE DATA : prix réels depuis ${CONFIG.exchange} (${CONFIG.marketType}).`);
  }

  /** S'assure que l'exchange est chargé et que `sym` est un marché connu ; renvoie null ou un message d'erreur. */
  async ensureSymbol(sym) {
    if (DEMO) {
      if (!this.demoState.has(sym)) {
        let p = hashPrice(sym);
        const candles = [];
        for (let i = 0; i < this.cfg.candlesLimit; i++) {
          p *= 1 + (Math.random() - 0.5) * 0.004;
          candles.push({ close: p });
        }
        this.demoState.set(sym, { price: p, candles, drift: (Math.random() - 0.5) * 0.002 });
      }
      return null;
    }
    return validateSymbolOnExchange(this.exchange, sym);
  }

  /** Timeframe de récupération : 1m si le timeframe cible n'existe pas nativement (ex. 3m), agrégé ensuite. */
  baseTimeframe() {
    const tf = this.cfg.timeframe;
    if (tf !== '3m' || DEMO) return tf;
    return '1m';
  }

  /** Renvoie les bougies CLOSES du timeframe cible [{time?, open?, high?, low?, close}] */
  async fetchCandles(symbol) {
    if (DEMO) {
      const st = this.demoState.get(symbol);
      // petite marche aléatoire avec drift occasionnel pour générer des signaux
      if (Math.random() < 0.05) st.drift = (Math.random() - 0.5) * 0.006; // changement de tendance
      st.price *= 1 + st.drift + (Math.random() - 0.5) * 0.003;
      st.candles.push({ close: st.price });
      if (st.candles.length > this.cfg.candlesLimit) st.candles.shift();
      // en démo, la dernière "bougie" est considérée comme fermée à chaque cycle
      return st.candles.slice(-this.cfg.candlesLimit);
    }
    const baseTf = this.baseTimeframe();
    const ohlcv = await this.exchange.fetchOHLCV(
      symbol,
      baseTf,
      undefined,
      this.cfg.candlesLimit
    );
    let candles = ohlcv.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
    // agrège si nécessaire (ex. 1m -> 3m) ; sinon retire la bougie en cours de formation
    if (baseTf !== this.cfg.timeframe) {
      candles = aggregate(candles, TF_MS[baseTf], TF_MS[this.cfg.timeframe]);
    } else {
      candles = closedCandles(candles);
    }
    return candles;
  }
}

// ---------- Courtage réel (ordres envoyés sur l'exchange) ----------

/**
 * Enveloppe ccxt pour trader réellement. Les clés API ne sont jamais stockées
 * ici : elles sont fournies par le coffre (SecretStore) au moment de la
 * création de l'exchange et transmises uniquement à ccxt.
 *
 * Ordres utilisés : MARKET + reduceOnly (clôtures). Les TP/SL restent gérés
 * par le bot (polling sur clôtures) — voir README « Limitations ».
 */
class LiveBroker {
  constructor(cfg, secrets, engine) {
    this.cfg = cfg;
    this.secrets = secrets;
    this.engine = engine;
    this.exchange = null;
    this._qtyPrec = new Map(); // symbol -> décimales de quantité (amount_to_precision)
  }

  get active() { return !!this.exchange; }

  /** Attache les hooks réels au moteur (openPosition/closePosition les appellent). */
  attachHooks() {
    this.cfg.onOpen = (p) => this.placeEntry(p);
    this.cfg.onClose = (p) => this.placeExit(p);
  }

  detachHooks() {
    delete this.cfg.onOpen;
    delete this.cfg.onClose;
    this.engine.log('INFO', 'Courtage réel désactivé (retour en paper).');
  }

  /** Crée l'exchange authentifié avec les clés du coffre. Échec => message explicite. */
  async connect() {
    try {
      return await this.secrets.withApiKey(({ apiKey, apiSecret }) => this._create(apiKey, apiSecret));
    } catch (e) {
      throw new Error(`Impossible d'utiliser les clés API : ${e.message}`);
    }
  }

  async _create(apiKey, apiSecret) {
    const ExClass = ccxt[this.cfg.exchange];
    if (!ExClass) throw new Error(`Exchange « ${this.cfg.exchange} » non supporté par ccxt.`);
    const ex = new ExClass({ apiKey, secret: apiSecret, enableRateLimit: true });
    if (this.cfg.marketType === 'future' && ex.options) ex.options.defaultType = 'swap';
    await ex.loadMarkets();
    // Vérification de l'accès privé (un simple balance ping)
    await ex.fetchBalance();
    this.exchange = ex;
    this._qtyPrec.clear();
    return ex;
  }

  /** Arrête proprement (utilisé avant reconnexion / passage en paper). */
  disconnect() { this.exchange = null; }

  amountToPrecision(symbol, qty) {
    if (!this._qtyPrec.has(symbol)) {
      const m = this.exchange.market(symbol);
      this._qtyPrec.set(symbol, m.precision?.amount ?? 8);
    }
    const p = this._qtyPrec.get(symbol);
    const f = Math.pow(10, -p);
    return Math.floor(qty / f) * f;
  }

  /** Entrée : MARKET dans le sens de la position, après réglage du levier. */
  async placeEntry({ symbol, side, qty, leverage }) {
    if (!this.exchange) throw new Error('Exchange non connecté.');
    const ccySide = side === 'LONG' ? 'buy' : 'sell';
    try {
      if (typeof this.exchange.setDefaultLeverage === 'function') {
        await this.exchange.setDefaultLeverage(leverage, symbol);
      }
    } catch (e) {
      this.engine.log('WARN', `Levier ${leverage}x refusé par l'exchange sur ${symbol} (${e.message}) — ordre envoyé quand même.`);
    }
    const amount = this.amountToPrecision(symbol, qty);
    if (!(amount > 0)) throw new Error(`Quantité arrondie à 0 sur ${symbol} (trop petite pour le pas de lot).`);
    const order = await this.exchange.createOrder(symbol, 'market', ccySide, amount);
    const fill = order.average || (order.info && (parseFloat(order.info.avgPrice) || parseFloat(order.info.ap))) || 0;
    this.engine.log('TRADE', `🔴 ORDRE RÉEL exécuté : ${side} ${symbol} qty=${amount} @ ~${fill ? fill.toFixed(4) : 'n/d'} (id=${order.id})`);
    return { id: order.id, entryPrice: fill > 0 ? fill : undefined };
  }

  /** Sortie : MARKET opposé + reduceOnly (ne peut jamais retourner la position). */
  async placeExit({ symbol, side, qty, reason }) {
    if (!this.exchange) throw new Error('Exchange non connecté.');
    const ccySide = side === 'LONG' ? 'sell' : 'buy';
    const amount = this.amountToPrecision(symbol, qty);
    if (!(amount > 0)) throw new Error(`Quantité arrondie à 0 sur ${symbol}.`);
    const params = {};
    if (this.cfg.marketType === 'future' && typeof this.exchange.createOrder === 'function') {
      params.reduceOnly = true;
    }
    const order = await this.exchange.createOrder(symbol, 'market', ccySide, amount, undefined, params);
    this.engine.log('TRADE', `🔴 ORDRE RÉEL de clôture (${reason}) : ${ccySide} ${symbol} qty=${amount} (id=${order.id})`);
    return { id: order.id };
  }

  /** Petit ping authentifié utilisé par le bouton « Tester la connexion » du dashboard. */
  async testConnection() {
    const bal = await this.exchange.fetchBalance();
    const total = Object.values(bal.total || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return { ok: true, assets: Object.keys(bal.total || {}).length, usdApprox: Number(total.toFixed(2)) };
  }
}

// ---------- Stratégie ----------

class MomentumBot {
  constructor(cfg, engine, market) {
    this.cfg = cfg;
    this.engine = engine;
    this.market = market;
    this.timer = null;
    this.running = false;
    this.paused = false;     // pause via le dashboard (le timer tourne, les cycles sont ignorés)
    this.prices = {};        // symbol -> dernier prix de CLÔTURE connue (mark-to-market)
    this.signals = {};       // symbol -> dernière lecture d'indicateurs (dashboard)
    this.lastCandleTime = new Map(); // symbol -> timestamp de la dernière bougie close traitée
    this.onChange = () => {}; // callback push vers le dashboard
  }

  /**
   * Le graphique doit TOUJOURS suivre l'évolution réelle : on repart d'une série
   * vide à chaque (re)start. Évite les paliers trompeurs quand des trades ont été
   * fermés alors que le bot était arrêté/en pause (les points manquent et la
   * reconstruction « trades-only » écrasait l'historique avec un seul point).
   */
  resetEquitySeries() {
    this.engine.equityHistory = [];
    this.engine.startEquity = this.engine.capital;
  }

  start() {
    if (this.running) return;
    this.resetEquitySeries();
    this.running = true;
    this.paused = false;
    this.engine.log('INFO', `Bot démarré | timeframe=${this.cfg.timeframe} | cycle=${this.cfg.cycleMs / 1000}s | capital=${this.engine.capital.toFixed(2)}$ | frais=${this.cfg.feePct}%/jambe`);
    this.runCycle(); // premier cycle immédiat
    this.restartTimer();
  }

  stop() {
    this.running = false;
    this.paused = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.log('INFO', 'Bot arrêté.');
    this.onChange();
  }

  setPaused(p) {
    this.paused = p;
    this.engine.log('INFO', p ? '⏸ Bot en pause.' : '▶ Bot repris.');
    this.onChange();
  }

  restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) this.timer = setInterval(() => this.runCycle(), this.cfg.cycleMs);
  }

  /**
   * Applique un patch de paramètres validé (via params.js).
   * Le timer est redémarré si cycleMs change ; TP/SL des positions ouvertes sont recalculés.
   * Les paires doivent être vérifiées AVANT appel (async) : ici application synchrone.
   * @returns {{ok:boolean, error?:string, applied?:object}}
   */
  applyParams(patch) {
    const res = validatePatch(patch, this.cfg);
    if (!res.ok) return res;
    const tfChanged = 'timeframe' in res.changes && res.changes.timeframe !== this.cfg.timeframe;
    const symbolsChanged = Array.isArray(res.changes.symbols);
    for (const [k, v] of Object.entries(res.changes)) this.cfg[k] = v;
    saveOverrides();
    if ('cycleMs' in res.changes) this.restartTimer();
    // Les nouvelles valeurs TP/SL s'appliquent aussi aux positions déjà ouvertes
    for (const pos of this.engine.positions.values()) {
      pos.tpPct = this.cfg.takeProfitPct;
      pos.slPct = this.cfg.stopLossPct;
    }
    // Changement de timeframe : on repart sur un état propre (pas de mélange de séries)
    if (tfChanged) {
      this.lastCandleTime.clear();
      this.engine.rebuildEquityHistory();
      this.engine.log('INFO', `Timeframe changé -> ${this.cfg.timeframe} (série d'équité reconstruite)`);
    } else if (symbolsChanged) {
      // Nettoyage des lectures fantômes des paires retirées ; les positions ouvertes
      // restent gérées (TP/SL) jusqu'à leur fermeture, même si la paire est décochée.
      for (const sym of Object.keys(this.signals)) {
        if (!this.cfg.symbols.includes(sym)) delete this.signals[sym];
      }
      this.engine.log('INFO', `Paires mises à jour (${this.cfg.symbols.length}) : ${this.cfg.symbols.join(', ')}`);
    } else {
      this.engine.log('INFO', `Paramètres mis à jour : ${Object.entries(res.changes).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ')}`);
    }
    this.onChange();
    return { ok: true, applied: res.changes };
  }

  /**
   * Version asynchrone : valide le patch puis vérifie chaque nouvelle paire sur l'exchange
   * avant application (refus explicite si un marché est inconnu).
   * Le changement de mode paper<->réel passe par ici (broker fourni).
   */
  async applyParamsAsync(patch, broker = null) {
    const res = validatePatch(patch, this.cfg);
    if (!res.ok) return res;
    if (Array.isArray(res.changes.symbols)) {
      const current = new Set(this.cfg.symbols);
      for (const sym of res.changes.symbols) {
        if (current.has(sym)) continue; // déjà utilisé, déjà vérifié
        const err = await this.market.ensureSymbol(sym);
        if (err) return { ok: false, error: `Paire refusée : ${err}` };
      }
    }
    // ----- Passage en mode RÉEL : exige coffre débloqué + connexion exchange OK -----
    if (res.changes.tradingMode === 'real') {
      if (!broker || !broker.secrets.unlocked) {
        return { ok: false, error: 'Mode réel refusé : clés API absentes ou coffre verrouillé. Renseigne-les dans « Clés API & sécurité ».' };
      }
      try {
        await broker.connect();
      } catch (e) {
        return { ok: false, error: `Connexion à l'exchange impossible : ${e.message}` };
      }
      broker.attachHooks();
      this.cfg.maxLeverage = MAX_LEVERAGE_REAL; // levier bridé côté moteur aussi
      this.engine.log('INFO', '🔴 MODE RÉEL ACTIVÉ — les ordres seront envoyés sur l\'exchange.');
    } else if ('tradingMode' in res.changes && res.changes.tradingMode === 'paper') {
      if (broker) { broker.detachHooks(); broker.disconnect(); }
      this.cfg.maxLeverage = MAX_LEVERAGE_PAPER;
      if (this.cfg.leverage > MAX_LEVERAGE_PAPER) this.cfg.leverage = DEFAULTS.leverage ?? 10;
      this.engine.log('INFO', '🧪 Mode PAPER réactivé (simulation).');
    }
    const applied = this.applyParams(res.changes);
    // Capital simulé modifié : reset du carnet uniquement en mode paper
    if (applied.ok && 'initialCapital' in res.changes && this.cfg.tradingMode !== 'real') {
      this.engine.resetBook(this.cfg.initialCapital);
      this.lastCandleTime.clear();
      this.engine.log('INFO', `📓 Carnet paper réinitialisé : capital=${this.cfg.initialCapital}$ (historique effacé).`);
    }
    return applied;
  }

  async resetParams(broker = null) {
    const patch = {};
    for (const k of editableKeys()) if (DEFAULTS[k] !== this.cfg[k]) patch[k] = DEFAULTS[k];
    if (!Object.keys(patch).length) return { ok: true, applied: {} };
    if ('tradingMode' in patch) return this.applyParamsAsync(patch, broker);
    return this.applyParams(patch);
  }

  async runCycle() {
    if (!this.running || this.paused) return;
    try {
      const symbols = [...new Set([...this.cfg.symbols, ...this.engine.positions.keys()])];
      for (const symbol of symbols) {
        await this.processSymbol(symbol);
      }
      // Point d'équité : cash réalisé + PnL latent uniquement (jamais la marge).
      const eq = this.engine.equity(this.prices);
      const last = this.engine.equityHistory[this.engine.equityHistory.length - 1];
      if (!last || Math.abs(last.equity - eq) > 0.005) {
        this.engine.recordEquity(this.prices);
      } else if (this.engine.equityHistory.length < 2) {
        // Rien n'a bougé (flat) : au moins un second point pour que le graphique
        // puisse s'écheller et tracer dès le premier cycle.
        this.engine.equityHistory.push({ t: Date.now(), equity: eq });
      }
      this.onChange();
    } catch (e) {
      this.engine.log('ERROR', `Erreur de cycle : ${e.message}`);
    }
  }

  /** Fermeture manuelle (dashboard) : ferme au prix courant et enregistre le point d'équité. */
  async closeManually(symbol) {
    const pos = this.engine.positions.get(symbol);
    if (!pos) return null;
    const price = this.prices[symbol] ?? pos.entryPrice;
    const trade = await this.engine.closePosition(symbol, price, 'MANUAL');
    this.engine.recordEquity(this.prices);
    return trade;
  }

  async closeAllManually() {
    for (const sym of [...this.engine.positions.keys()]) await this.closeManually(sym);
  }

  async processSymbol(symbol) {
    let candles;
    try {
      candles = await this.market.fetchCandles(symbol);
    } catch (e) {
      this.engine.log('WARN', `${symbol} : récupération bougies impossible (${e.message})`);
      return;
    }
    if (!candles || candles.length < this.cfg.lookbackCandles + 1) return;

    const closes = candles.map((c) => c.close);
    const closePrice = closes[closes.length - 1]; // clôture dure de la dernière bougie CLOSE
    this.prices[symbol] = closePrice;
    const tracked = this.cfg.symbols.includes(symbol);

    // ----- 1) Gestion de sortie prioritaire : TP / SL sur la clôture -----
    const pos = this.engine.positions.get(symbol);
    if (pos) {
      const exit = this.engine.checkExit(pos, closePrice);
      if (exit) {
        // exécuté AU PRIX EXACT du TP/SL (comme un ordre conditionnel réel),
        // pas à la clôture qui peut avoir slippé plus loin
        await this.engine.closePosition(symbol, exit.price, exit.kind);
      }
    }

    // ----- 2) Détection du signal d'entrée (une fois par nouvelle bougie close) -----
    const candleTime = candles[candles.length - 1].time;
    const prevTime = this.lastCandleTime.get(symbol);
    const isNewCandle = candleTime == null ? true : candleTime !== prevTime;
    if (candleTime != null) this.lastCandleTime.set(symbol, candleTime);

    const changePct = priceChangePct(candles, this.cfg.lookbackCandles);
    const r = rsi(closes, this.cfg.rsiPeriod);
    if (tracked) this.signals[symbol] = { changePct, rsi: r, price: closePrice, candleTime: candleTime ?? null };

    if (!tracked) return;                // paire décochée : gestion de sortie uniquement
    if (!isNewCandle) return;            // même bougie déjà traitée : pas de re-entry
    if (changePct == null || r == null) return;
    if (this.engine.positions.has(symbol)) return; // déjà une position sur ce symbole
    if (!this.engine.canOpen(symbol)) return;      // cooldown en cours

    const longSignal = changePct > this.cfg.minMovePct && r > this.cfg.rsiLongMin;
    const shortSignal = changePct < -this.cfg.minMovePct && r < this.cfg.rsiShortMax;

    if (longSignal) {
      await this.engine.openPosition(symbol, 'LONG', closePrice, { changePct, rsi: r });
    } else if (shortSignal) {
      await this.engine.openPosition(symbol, 'SHORT', closePrice, { changePct, rsi: r });
    }
  }
}

// ---------- Dashboard ----------

async function main() {
  loadOverrides();

  // ---------- Sécurité : authentification du dashboard + coffre à clés API ----------
  const auth = new AuthManager(path.join(__dirname, 'auth.json'), process.env.MOMBOT_PASSWORD || null);
  if (auth.generated) {
    console.log('🔑 Aucun mot de passe configuré : un mot de passe a été GÉNÉRÉ pour ce premier lancement :');
    console.log(`   ${auth.firstPassword}`);
    console.log('   (stocké haché dans auth.json — utilise-le pour te connecter ; ou définis MOMBOT_PASSWORD)');
  }
  const secrets = new SecretStore(path.join(__dirname, 'secrets.json'));
  const envKey = process.env.MOMBOT_API_KEY, envSecret = process.env.MOMBOT_API_SECRET;
  const envMaster = process.env.MOMBOT_MASTER;
  if (envKey && envSecret && !secrets.configured) {
    try { secrets.set(envKey, envSecret, envMaster || envKey.slice(-12)); console.log('🗝️ Clés API fournies par variables d\'environnement → enregistrées chiffrées.'); }
    catch (e) { console.warn('⚠️ Coffre API inaccessible en écriture :', e.message); }
  } else if (envKey && envSecret && secrets.configured && envMaster && !secrets.unlocked) {
    secrets.unlock(envMaster);
  }
  if (secrets.configured && envMaster) secrets.unlock(envMaster);

  const engine = new TradingEngine(CONFIG);
  const market = new MarketData(CONFIG);
  await market.init();

  const bot = new MomentumBot(CONFIG, engine, market);
  const broker = new LiveBroker(CONFIG, secrets, engine);

  // Si le mode réel était déjà actif avant redémarrage : tentative de reconnexion
  if (CONFIG.tradingMode === 'real' && !DEMO) {
    if (secrets.unlocked) {
      try { await broker.connect(); broker.attachHooks(); CONFIG.maxLeverage = MAX_LEVERAGE_REAL; engine.log('INFO', '🔴 Reconnexion au mode RÉEL (clés API restaurées).'); }
      catch (e) { CONFIG.tradingMode = 'paper'; CONFIG.maxLeverage = MAX_LEVERAGE_PAPER; engine.log('WARN', `Mode réel impossible au démarrage (${e.message}) → repli en paper.`); }
    } else {
      CONFIG.tradingMode = 'paper'; CONFIG.maxLeverage = MAX_LEVERAGE_PAPER;
      engine.log('WARN', 'Mode réel demandé mais coffre verrouillé/absent → démarrage en paper. Débloque les clés dans le dashboard.');
    }
  }

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(auth.requireAuth(path.join(__dirname, 'public')));
  app.use(auth.requireCsrf()); // () : renvoie une closure liée à `auth` (sinon this perdu → 500 sur POST)
  app.use(express.static(path.join(__dirname, 'public')));

  // ---------- Routes d'authentification ----------
  app.post('/api/login', (req, res) => auth.handleLogin(req, res));
  app.get('/api/me', (_req, res) => auth.handleMe(_req, res));
  app.post('/api/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

  // Payload d'état complet envoyé au dashboard (HTTP + WS)
  const statePayload = () => ({
    ...engine.snapshot(bot.prices),
    signals: bot.signals,
    running: bot.running,
    paused: bot.paused,
    demo: DEMO,
    security: {
      tradingMode: CONFIG.tradingMode,
      realActive: broker.active,
      keys: secrets.status(),
      maxLeverageReal: MAX_LEVERAGE_REAL,
    },
  });

  // API : état complet du bot
  app.get('/api/state', (_req, res) => res.json(statePayload()));

  // API : schéma des paramètres éditables + valeurs courantes + défauts
  app.get('/api/config', (_req, res) => {
    const params = {};
    for (const k of editableKeys()) params[k] = CONFIG[k];
    res.json({
      params,
      defaults: DEFAULTS,
      spec: PARAM_SCHEMA,
      groups: PARAM_GROUPS,
      timeframes: TIMEFRAMES,
      symbols: CONFIG.symbols,
      symbolUniverse: symbolUniverse(CONFIG.symbols),
      initialCapital: CONFIG.initialCapital,
      maxLeverage: CONFIG.maxLeverage,
      security: statePayload().security,
    });
  });

  // API : modifier les paramètres via le dashboard (patch validé ; paires vérifiées sur l'exchange)
  app.post('/api/params', async (req, res) => {
    const result = await bot.applyParamsAsync(req.body || {}, broker);
    res.status(result.ok ? 200 : 400).json({ ...result, state: statePayload() });
  });

  // API : réinitialiser les paramètres aux valeurs par défaut
  app.post('/api/params/reset', async (_req, res) => {
    const result = await bot.resetParams(broker);
    res.json({ ...result, state: statePayload() });
  });

  // API : changer le timeframe (boutons du dashboard) — passe par la validation params
  app.post('/api/timeframe', (req, res) => {
    const { tf } = req.body || {};
    const result = bot.applyParams({ timeframe: tf });
    res.status(result.ok ? 200 : 400).json({ ok: result.ok, timeframe: CONFIG.timeframe });
  });

  // API : start / stop / pause
  app.post('/api/start', (_req, res) => { bot.start(); res.json(statePayload()); });
  app.post('/api/stop', (_req, res) => { bot.stop(); res.json(statePayload()); });
  app.post('/api/pause', (req, res) => {
    if (!bot.running) return res.status(400).json({ error: 'Bot non démarré.' });
    bot.setPaused(req.body?.paused !== false);
    res.json(statePayload());
  });

  // API : fermer toutes les positions manuellement au prix courant
  app.post('/api/closeall', async (_req, res) => {
    await bot.closeAllManually();
    res.json(statePayload());
  });

  // API : fermer une position précise au prix courant
  app.post('/api/close/:symbol', async (req, res) => {
    const sym = decodeURIComponent(req.params.symbol);
    if (!engine.positions.has(sym)) return res.status(404).json({ error: `Aucune position ouverte sur ${sym}.` });
    const trade = await bot.closeManually(sym);
    bot.onChange();
    res.json({ ok: true, trade, state: statePayload() });
  });

  // ---------- Coffre à clés API (les secrets ne transitent JAMAIS en clair vers le client) ----------
  app.get('/api/keys/status', (_req, res) => res.json(secrets.status()));

  app.post('/api/keys/set', async (req, res) => {
    const { apiKey, apiSecret, master } = req.body || {};
    if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || typeof master !== 'string') {
      return res.status(400).json({ error: 'Champs requis : apiKey, apiSecret et master (mot de passe maître qui chiffrera le coffre).' });
    }
    if (apiKey.trim().length < 8 || apiSecret.trim().length < 8) {
      return res.status(400).json({ error: 'Clés trop courtes — vérifie que tu as copié la clé API et le secret complets.' });
    }
    if (master.length < 8) {
      return res.status(400).json({ error: 'Mot de passe maître trop court (8 caractères minimum).' });
    }
    try {
      // on vérifie d'abord que les clés fonctionnent AVANT de les enregistrer
      const probe = new (ccxt[CONFIG.exchange])({ apiKey: apiKey.trim(), secret: apiSecret.trim(), enableRateLimit: true });
      if (CONFIG.marketType === 'future' && probe.options) probe.options.defaultType = 'swap';
      await probe.loadMarkets();
      await probe.fetchBalance();
      secrets.set(apiKey.trim(), apiSecret.trim(), master);
      engine.log('INFO', `🗝️ Clés API enregistrées (chiffrées AES-256-GCM, id=${secrets.keyId}).`);
      res.json({ ok: true, status: secrets.status(), state: statePayload() });
    } catch (e) {
      res.status(400).json({ error: `Clés refusées par l'exchange ou réseau indisponible : ${String(e.message).slice(0, 200)}` });
    }
  });

  app.post('/api/keys/unlock', (req, res) => {
    const { master } = req.body || {};
    if (typeof master !== 'string') return res.status(400).json({ error: 'Mot de passe maître requis.' });
    if (!secrets.unlock(master)) return res.status(401).json({ error: 'Mot de passe maître incorrect.' });
    engine.log('INFO', '🔓 Coffre déverrouillé pour cette session.');
    res.json({ ok: true, status: secrets.status(), state: statePayload() });
  });

  app.post('/api/keys/lock', (_req, res) => {
    secrets.lock();
    if (CONFIG.tradingMode === 'real') {
      broker.detachHooks(); broker.disconnect();
      CONFIG.tradingMode = 'paper'; CONFIG.maxLeverage = MAX_LEVERAGE_PAPER;
      saveOverrides();
      engine.log('WARN', 'Coffre verrouillé pendant le mode réel → retour automatique en paper.');
    }
    res.json({ ok: true, status: secrets.status(), state: statePayload() });
  });

  app.post('/api/keys/test', async (_req, res) => {
    if (!broker.active) return res.status(400).json({ error: 'Aucune connexion réelle active (mode paper ou coffre verrouillé).' });
    try { res.json(await broker.testConnection()); }
    catch (e) { res.status(500).json({ error: `Test échoué : ${String(e.message).slice(0, 200)}` }); }
  });

  app.post('/api/keys/erase', (_req, res) => {
    if (CONFIG.tradingMode === 'real') { broker.detachHooks(); broker.disconnect(); CONFIG.tradingMode = 'paper'; CONFIG.maxLeverage = MAX_LEVERAGE_PAPER; saveOverrides(); }
    secrets.erase();
    engine.log('WARN', '🗑️ Clés API effacées du coffre.');
    res.json({ ok: true, status: secrets.status(), state: statePayload() });
  });

  // Push temps réel via WebSocket
  bot.onChange = () => {
    const payload = JSON.stringify(statePayload());
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };
  wss.on('connection', (ws, req) => {
    if (!auth.wsAuthenticate(req)) { ws.close(4401, 'Non authentifié'); return; }
    ws.send(JSON.stringify(statePayload()));
  });

  server.listen(CONFIG.port, () => {
    console.log(`📊 Dashboard : http://localhost:${CONFIG.port} (protégé par mot de passe)`);
    bot.start();
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
