// ============================================================
// Bot principal : boucle de stratégie + dashboard web (Express + WS)
//
//   node bot.js              -> paper trading avec prix réels Binance
//   node bot.js --demo       -> données simulées (fonctionne sans internet)
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

  /** Renvoie les N dernières bougies [{close}] pour un symbole */
  async fetchCandles(symbol) {
    if (DEMO) {
      const st = this.demoState.get(symbol);
      // petite marche aléatoire avec drift occasionnel pour générer des signaux
      if (Math.random() < 0.05) st.drift = (Math.random() - 0.5) * 0.006; // changement de tendance
      st.price *= 1 + st.drift + (Math.random() - 0.5) * 0.003;
      st.candles.push({ close: st.price });
      if (st.candles.length > this.cfg.candlesLimit) st.candles.shift();
      return st.candles.slice(-this.cfg.candlesLimit);
    }
    const ohlcv = await this.exchange.fetchOHLCV(
      symbol,
      this.cfg.timeframe,
      undefined,
      this.cfg.candlesLimit
    );
    return ohlcv.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
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
    this.prices = {};        // symbol -> dernier prix connu
    this.signals = {};       // symbol -> dernière lecture d'indicateurs (dashboard)
    this.onChange = () => {}; // callback push vers le dashboard
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.engine.log('INFO', `Bot démarré | timeframe=${this.cfg.timeframe} | cycle=${this.cfg.cycleMs / 1000}s | capital=${this.engine.capital}$`);
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

  setTimeframe(tf) {
    if (!TIMEFRAMES.includes(tf)) return false;
    this.cfg.timeframe = tf;
    this.engine.log('INFO', `Timeframe changé -> ${tf}`);
    this.onChange();
    return true;
  }

  /**
   * Applique un patch de paramètres validé (via params.js).
   * Le timer est redémarré si cycleMs change ; TP/SL des positions ouvertes sont recalculés.
   * @returns {{ok:boolean, error?:string, applied?:object}}
   */
  applyParams(patch) {
    const res = validatePatch(patch, this.cfg);
    if (!res.ok) return res;
    for (const [k, v] of Object.entries(res.changes)) this.cfg[k] = v;
    saveOverrides();
    if ('cycleMs' in res.changes) this.restartTimer();
    // Les nouvelles valeurs TP/SL s'appliquent aussi aux positions déjà ouvertes
    for (const pos of this.engine.positions.values()) {
      pos.tpPct = this.cfg.takeProfitPct;
      pos.slPct = this.cfg.stopLossPct;
    }
    this.engine.log('INFO', `Paramètres mis à jour : ${Object.entries(res.changes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
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
      // Point d'équité : cash réalisé + PnL latent uniquement.
      // (La marge engagée des positions ouvertes reste comptée dans le cash ;
      // elle n'est JAMAIS re-additionnée — c'était l'ancien bug.)
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
    const price = closes[closes.length - 1];
    this.prices[symbol] = price;

    const pos = this.engine.positions.get(symbol);

    // ----- 1) Gestion de sortie prioritaire : TP / SL -----
    if (pos) {
      const exit = this.engine.checkExit(pos, price);
      if (exit) {
        this.engine.closePosition(symbol, price, exit);
      }
    }

    // ----- 2) Détection du signal d'entrée -----
    const changePct = priceChangePct(candles, this.cfg.lookbackCandles);
    const r = rsi(closes, this.cfg.rsiPeriod);
    this.signals[symbol] = { changePct, rsi: r, price };

    if (changePct == null || r == null) return;
    if (pos) return;                       // déjà une position sur ce symbole
    if (!this.engine.canOpen(symbol)) return; // cooldown en cours

    const longSignal = changePct > this.cfg.minMovePct && r > this.cfg.rsiLongMin;
    const shortSignal = changePct < -this.cfg.minMovePct && r < this.cfg.rsiShortMax;

    if (longSignal) {
      this.engine.openPosition(symbol, 'LONG', price, { changePct, rsi: r });
    } else if (shortSignal) {
      this.engine.openPosition(symbol, 'SHORT', price, { changePct, rsi: r });
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
