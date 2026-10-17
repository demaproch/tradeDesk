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
// Dashboard : http://localhost:3000
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
const { PARAM_SCHEMA, PARAM_GROUPS, TIMEFRAMES, validatePatch, editableKeys } = require('./params');

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
        let p = bases[sym] ?? 100;
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

  start() {
    if (this.running) return;
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
   * @returns {{ok:boolean, error?:string, applied?:object}}
   */
  applyParams(patch) {
    const res = validatePatch(patch, this.cfg);
    if (!res.ok) return res;
    const tfChanged = 'timeframe' in res.changes && res.changes.timeframe !== this.cfg.timeframe;
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
    } else {
      this.engine.log('INFO', `Paramètres mis à jour : ${Object.entries(res.changes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    this.onChange();
    return { ok: true, applied: res.changes };
  }

  resetParams() {
    const patch = {};
    for (const k of editableKeys()) if (DEFAULTS[k] !== this.cfg[k]) patch[k] = DEFAULTS[k];
    if (!Object.keys(patch).length) return { ok: true, applied: {} };
    return this.applyParams(patch);
  }

  async runCycle() {
    if (!this.running || this.paused) return;
    try {
      for (const symbol of this.cfg.symbols) {
        await this.processSymbol(symbol);
      }
      // Point d'équité : cash réalisé + PnL latent uniquement (jamais la marge).
      const eq = this.engine.equity(this.prices);
      const last = this.engine.equityHistory[this.engine.equityHistory.length - 1];
      if (!last || Math.abs(last.equity - eq) > 0.005) {
        this.engine.recordEquity(this.prices);
      }
      this.onChange();
    } catch (e) {
      this.engine.log('ERROR', `Erreur de cycle : ${e.message}`);
    }
  }

  /** Fermeture manuelle (dashboard) : ferme au prix courant et enregistre le point d'équité. */
  closeManually(symbol) {
    const pos = this.engine.positions.get(symbol);
    if (!pos) return null;
    const price = this.prices[symbol] ?? pos.entryPrice;
    const trade = this.engine.closePosition(symbol, price, 'MANUAL');
    this.engine.recordEquity(this.prices);
    return trade;
  }

  closeAllManually() {
    for (const sym of [...this.engine.positions.keys()]) this.closeManually(sym);
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

    // ----- 1) Gestion de sortie prioritaire : TP / SL sur la clôture -----
    const pos = this.engine.positions.get(symbol);
    if (pos) {
      const exit = this.engine.checkExit(pos, closePrice);
      if (exit) {
        // exécuté AU PRIX EXACT du TP/SL (comme un ordre conditionnel réel),
        // pas à la clôture qui peut avoir slippé plus loin
        this.engine.closePosition(symbol, exit.price, exit.kind);
      }
    }

    // ----- 2) Détection du signal d'entrée (une fois par nouvelle bougie close) -----
    const candleTime = candles[candles.length - 1].time;
    const prevTime = this.lastCandleTime.get(symbol);
    const isNewCandle = candleTime == null ? true : candleTime !== prevTime;
    if (candleTime != null) this.lastCandleTime.set(symbol, candleTime);

    const changePct = priceChangePct(candles, this.cfg.lookbackCandles);
    const r = rsi(closes, this.cfg.rsiPeriod);
    this.signals[symbol] = { changePct, rsi: r, price: closePrice, candleTime: candleTime ?? null };

    if (!isNewCandle) return;          // même bougie déjà traitée : pas de re-entry
    if (changePct == null || r == null) return;
    if (this.engine.positions.has(symbol)) return; // déjà une position sur ce symbole
    if (!this.engine.canOpen(symbol)) return;      // cooldown en cours

    const longSignal = changePct > this.cfg.minMovePct && r > this.cfg.rsiLongMin;
    const shortSignal = changePct < -this.cfg.minMovePct && r < this.cfg.rsiShortMax;

    if (longSignal) {
      this.engine.openPosition(symbol, 'LONG', closePrice, { changePct, rsi: r });
    } else if (shortSignal) {
      this.engine.openPosition(symbol, 'SHORT', closePrice, { changePct, rsi: r });
    }
  }
}

// ---------- Dashboard ----------

async function main() {
  loadOverrides();
  const engine = new TradingEngine(CONFIG);
  const market = new MarketData(CONFIG);
  await market.init();

  const bot = new MomentumBot(CONFIG, engine, market);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Payload d'état complet envoyé au dashboard (HTTP + WS)
  const statePayload = () => ({
    ...engine.snapshot(bot.prices),
    signals: bot.signals,
    running: bot.running,
    paused: bot.paused,
    demo: DEMO,
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
      initialCapital: CONFIG.initialCapital,
      maxLeverage: CONFIG.maxLeverage,
    });
  });

  // API : modifier les paramètres via le dashboard (patch validé)
  app.post('/api/params', (req, res) => {
    const result = bot.applyParams(req.body || {});
    res.status(result.ok ? 200 : 400).json({ ...result, state: statePayload() });
  });

  // API : réinitialiser les paramètres aux valeurs par défaut
  app.post('/api/params/reset', (_req, res) => {
    const result = bot.resetParams();
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
  app.post('/api/closeall', (_req, res) => {
    bot.closeAllManually();
    res.json(statePayload());
  });

  // API : fermer une position précise au prix courant
  app.post('/api/close/:symbol', (req, res) => {
    const sym = decodeURIComponent(req.params.symbol);
    if (!engine.positions.has(sym)) return res.status(404).json({ error: `Aucune position ouverte sur ${sym}.` });
    const trade = bot.closeManually(sym);
    bot.onChange();
    res.json({ ok: true, trade, state: statePayload() });
  });

  // Push temps réel via WebSocket
  bot.onChange = () => {
    const payload = JSON.stringify(statePayload());
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };
  wss.on('connection', (ws) => ws.send(JSON.stringify(statePayload())));

  server.listen(CONFIG.port, () => {
    console.log(`📊 Dashboard : http://localhost:${CONFIG.port}`);
    bot.start();
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
