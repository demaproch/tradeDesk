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
const ccxt = require('ccxt');
const CONFIG = require('./config');
const { rsi, priceChangePct } = require('./indicators');
const TradingEngine = require('./engine');

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
    this.prices = {};        // symbol -> dernier prix connu
    this.signals = {};       // symbol -> dernière lecture d'indicateurs (dashboard)
    this.onChange = () => {}; // callback push vers le dashboard
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.engine.log('INFO', `Bot démarré | timeframe=${this.cfg.timeframe} | cycle=${this.cfg.cycleMs / 1000}s | capital=${this.engine.capital}$`);
    this.runCycle(); // premier cycle immédiat
    this.timer = setInterval(() => this.runCycle(), this.cfg.cycleMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.log('INFO', 'Bot arrêté.');
    this.onChange();
  }

  setTimeframe(tf) {
    if (!['1m', '3m', '5m', '15m', '30m', '1h', '4h'].includes(tf)) return false;
    this.cfg.timeframe = tf;
    this.engine.log('INFO', `Timeframe changé -> ${tf}`);
    this.onChange();
    return true;
  }

  async runCycle() {
    if (!this.running) return;
    try {
      for (const symbol of this.cfg.symbols) {
        await this.processSymbol(symbol);
      }
      this.engine.recordEquity(this.prices);
      this.onChange();
    } catch (e) {
      this.engine.log('ERROR', `Erreur de cycle : ${e.message}`);
    }
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
      } else {
        // PnL latent mis à jour pour l'affichage
        pos.uPnl = this.engine.unrealizedPnl(pos, price);
        pos.movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'LONG' ? 1 : -1);
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
  const engine = new TradingEngine(CONFIG);
  const market = new MarketData(CONFIG);
  await market.init();

  const bot = new MomentumBot(CONFIG, engine, market);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.static(path.join(__dirname, 'public')));

  // API : état complet du bot
  app.get('/api/state', (_req, res) => {
    res.json({ ...engine.snapshot(bot.prices), signals: bot.signals, running: bot.running, demo: DEMO });
  });

  // API : changer le timeframe (boutons du dashboard)
  app.post('/api/timeframe', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { tf } = JSON.parse(body || '{}');
        const ok = bot.setTimeframe(tf);
        res.json({ ok, timeframe: CONFIG.timeframe });
      } catch {
        res.status(400).json({ ok: false });
      }
    });
  });

  // API : start / stop
  app.post('/api/start', (_req, res) => { bot.start(); res.json({ running: bot.running }); });
  app.post('/api/stop', (_req, res) => { bot.stop(); res.json({ running: bot.running }); });

  // API : fermer toutes les positions manuellement au prix courant
  app.post('/api/closeall', (_req, res) => {
    engine.closeAll((sym, fallback) => bot.prices[sym] ?? fallback);
    res.json(engine.snapshot(bot.prices));
  });

  // Push temps réel via WebSocket
  bot.onChange = () => {
    const payload = JSON.stringify({ ...engine.snapshot(bot.prices), signals: bot.signals, running: bot.running, demo: DEMO });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ ...engine.snapshot(bot.prices), signals: bot.signals, running: bot.running, demo: DEMO }));
  });

  server.listen(CONFIG.port, () => {
    console.log(`📊 Dashboard : http://localhost:${CONFIG.port}`);
    bot.start();
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
