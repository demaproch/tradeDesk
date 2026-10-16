// ============================================================
// Moteur de trading simulé (paper trading)
// - capital initial 1000 $, risque 8 %, levier 10x (max 12x)
// - TP +2.8 % / SL -1.0 % sur le mouvement du prix
// - cooldown 5 min par symbole, 1 position max par symbole
// ============================================================

const CONFIG = require('./config');

class TradingEngine {
  constructor(config = CONFIG) {
    this.cfg = config;
    this.capital = config.initialCapital;   // capital réalisé (cash)
    this.positions = new Map();             // symbol -> position ouverte
    this.closedTrades = [];                 // historique des trades fermés
    this.lastTradeTime = new Map();         // symbol -> timestamp de dernière ouverture
    this.equityHistory = [];                // [{t, equity}] pour le graphique
    this.logs = [];                         // journal des événements (borné)
  }

  // ---------- utilitaires ----------

  log(level, msg) {
    const entry = { t: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    const tag = { INFO: 'ℹ️', TRADE: '💹', EXIT: '✅', WARN: '⚠️', ERROR: '❌' }[level] || '';
    console.log(`[${new Date(entry.t).toISOString()}] ${tag} ${msg}`);
  }

  /** Prix courant (dernière clôture de bougie) */
  lastPrice(candles) {
    return candles[candles.length - 1].close;
  }

  /**
   * Equity = cash (capital réalisé) + somme des PnL non réalisés.
   * La marge engagée d'une position ouverte est DÉJÀ comprise dans le cash
   * (elle n'est jamais "re-prélevée") : on ajoute uniquement le PnL latent.
   * Ancien bug corrigé : la mise initiale était re-additionnée par position
   * ouverte, ce qui gonflait artificiellement l'équité.
   */
  equity(pricesBySymbol = {}) {
    let eq = this.capital;
    for (const [sym, pos] of this.positions) {
      const price = pricesBySymbol[sym] ?? pos.entryPrice;
      eq += this.unrealizedPnl(pos, price);
    }
    return eq;
  }

  /** Somme des PnL non réalisés sur toutes les positions ouvertes. */
  totalUnrealized(pricesBySymbol = {}) {
    let u = 0;
    for (const [sym, pos] of this.positions) {
      const price = pricesBySymbol[sym] ?? pos.entryPrice;
      u += this.unrealizedPnl(pos, price);
    }
    return u;
  }

  unrealizedPnl(pos, price) {
    const movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const dirMovePct = pos.side === 'LONG' ? movePct : -movePct;
    // PnL = marge * levier * variation du prix (dans le sens de la position)
    return pos.margin * pos.leverage * (dirMovePct / 100);
  }

  recordEquity(pricesBySymbol) {
    this.equityHistory.push({ t: Date.now(), equity: this.equity(pricesBySymbol) });
    if (this.equityHistory.length > 2000) this.equityHistory.shift();
  }

  /**
   * Historique d'équité recalculé à partir des trades fermés uniquement.
   * Permet de reconstruire la courbe après un changement de timeframe :
   * equity(t) = capital initial + Σ PnL réalisés dont closedAt <= t.
   * (La marge n'entre jamais dans ce calcul — seul le PnL réalisé compte.)
   */
  rebuildEquityHistory() {
    const start = this.cfg.initialCapital;
    const sorted = [...this.closedTrades].sort((a, b) => a.closedAt - b.closedAt);
    let run = start;
    const hist = [{ t: sorted.length ? sorted[0].closedAt - 1 : Date.now(), equity: run }];
    for (const tr of sorted) {
      run += tr.pnl;
      hist.push({ t: tr.closedAt, equity: run });
    }
    // point courant : cash réalisé actuel (sans PnL latent, par convention historique)
    hist.push({ t: Date.now(), equity: this.capital });
    this.equityHistory = hist.slice(-2000);
  }

  // ---------- dimensionnement ----------

  /**
   * Marge = 8 % du capital actuel.
   * Exposition notionnelle = marge × levier (~80 % du capital en 10x).
   */
  computePositionSize() {
    const margin = this.capital * (this.cfg.riskPct / 100);
    const leverage = Math.min(this.cfg.leverage, this.cfg.maxLeverage);
    const notional = margin * leverage;
    return { margin, leverage, notional };
  }

  // ---------- entrée ----------

  canOpen(symbol) {
    // Une seule position à la fois par symbole
    if (this.cfg.maxOnePositionPerSymbol && this.positions.has(symbol)) return false;
    // Cooldown de 5 minutes entre deux trades sur le même symbole
    const last = this.lastTradeTime.get(symbol) || 0;
    if (Date.now() - last < this.cfg.cooldownMs) return false;
    return true;
  }

  /**
   * Ouvre une position si le signal est validé.
   * @param {string} symbol
   * @param {'LONG'|'SHORT'} side
   * @param {number} price  prix d'entrée
   * @param {object} meta   { changePct, rsi } pour le log
   */
  openPosition(symbol, side, price, meta = {}) {
    if (!this.canOpen(symbol)) return null;
    if (!(price > 0)) return null;

    const { margin, leverage, notional } = this.computePositionSize();
    const qty = notional / price; // taille en unité du contrat

    const pos = {
      symbol,
      side,
      entryPrice: price,
      margin,
      leverage,
      notional,
      qty,
      openedAt: Date.now(),
      tpPct: this.cfg.takeProfitPct,
      slPct: this.cfg.stopLossPct,
      meta,
    };

    this.positions.set(symbol, pos);
    this.lastTradeTime.set(symbol, Date.now());
    this.log('TRADE', `Ouverture ${side} ${symbol} @ ${price.toFixed(4)} | marge=${margin.toFixed(2)}$ levier=${leverage}x expo=${notional.toFixed(2)}$ | var=${meta.changePct?.toFixed(3)}% RSI=${meta.rsi?.toFixed(1)}`);
    return pos;
  }

  // ---------- sortie ----------

  /**
   * Vérifie TP/SL d'une position avec le prix courant.
   * @returns {null|'TP'|'SL'}
   */
  checkExit(pos, price) {
    // Comparaison en ratio brut pour éviter les artéfacts de flottants
    // (((102.8-100)/100*100) vaut 2.7999… en IEEE-754 et ne déclencherait pas le TP).
    const ratio = (price - pos.entryPrice) / pos.entryPrice;
    const dirRatio = pos.side === 'LONG' ? ratio : -ratio;
    if (dirRatio >= pos.tpPct / 100 - Number.EPSILON) return 'TP';
    if (dirRatio <= -(pos.slPct / 100) + Number.EPSILON) return 'SL';
    return null;
  }

  closePosition(symbol, price, reason) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const pnl = this.unrealizedPnl(pos, price);
    this.capital += pnl;               // le PnL réalisé revient dans le cash
    this.positions.delete(symbol);

    const trade = {
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      margin: pos.margin,
      leverage: pos.leverage,
      pnl,
      reason,                          // 'TP' | 'SL' | 'MANUAL'
      openedAt: pos.openedAt,
      closedAt: Date.now(),
    };
    this.closedTrades.push(trade);
    if (this.closedTrades.length > 500) this.closedTrades.shift();

    this.log('EXIT', `Fermeture ${reason} ${pos.side} ${symbol} @ ${price.toFixed(4)} | PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$ | capital=${this.capital.toFixed(2)}$`);
    return trade;
  }

  /** Fermeture manuelle (bouton du dashboard) */
  closeAll(priceFn) {
    for (const [sym, pos] of [...this.positions]) {
      const price = priceFn ? priceFn(sym, pos.entryPrice) : pos.entryPrice;
      this.closePosition(sym, price, 'MANUAL');
    }
  }

  // ---------- statistiques ----------

  stats() {
    const wins = this.closedTrades.filter((t) => t.pnl > 0);
    const losses = this.closedTrades.filter((t) => t.pnl <= 0);
    const totalPnl = this.closedTrades.reduce((s, t) => s + t.pnl, 0);
    return {
      capital: this.capital,
      openPositions: this.positions.size,
      closedCount: this.closedTrades.length,
      winRate: this.closedTrades.length ? (wins.length / this.closedTrades.length) * 100 : 0,
      wins: wins.length,
      losses: losses.length,
      totalPnl,
    };
  }

  /** Temps restant de cooldown pour un symbole (0 si aucun) */
  cooldownLeft(symbol) {
    const last = this.lastTradeTime.get(symbol) || 0;
    return Math.max(0, last + this.cfg.cooldownMs - Date.now());
  }

  /** Paire [min,max] des prix d'entrée/sortie pour une position ouverte */
  tpSlPrices(pos) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    const pTP = pos.entryPrice * (1 + (dir * pos.tpPct) / 100);
    const pSL = pos.entryPrice * (1 - (dir * pos.slPct) / 100);
    return [Math.min(pTP, pSL), Math.max(pTP, pSL)];
  }

  snapshot(pricesBySymbol = {}) {
    const editableKeys = Object.keys(require('./params').PARAM_SCHEMA);
    const params = {};
    for (const k of editableKeys) params[k] = this.cfg[k];

    // cooldown restant par symbole (affiché dans les cartes de signaux)
    const cooldowns = {};
    for (const sym of this.cfg.symbols) cooldowns[sym] = this.cooldownLeft(sym);

    const positions = [...this.positions.values()].map((p) => {
      const price = pricesBySymbol[p.symbol] ?? p.entryPrice;
      const [tpLo, tpHi] = this.tpSlPrices(p);
      const movePct = ((price - p.entryPrice) / p.entryPrice) * 100 * (p.side === 'LONG' ? 1 : -1);
      return { ...p, currentPrice: price, uPnl: this.unrealizedPnl(p, price), movePct, tpLo, tpHi };
    });

    return {
      capital: this.capital,
      equity: this.equity(pricesBySymbol),
      unrealized: this.totalUnrealized(pricesBySymbol),
      timeframe: this.cfg.timeframe,
      params,
      cooldowns,
      stats: this.stats(),
      positions,
      trades: this.closedTrades.slice(-50).reverse(),
      equityHistory: this.equityHistory.slice(-600),
      logs: this.logs.slice(-60).reverse(),
    };
  }
}

module.exports = TradingEngine;
