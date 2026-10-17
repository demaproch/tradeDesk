// ============================================================
// Moteur de trading simulé (paper trading)
// - capital initial 1000 $, risque 8 %, levier 10x (max 12x)
// - TP +2.8 % / SL -1.0 % sur le mouvement du prix
// - cooldown 5 min par symbole, 1 position max par symbole
// - entrées et sorties évaluées sur CLÔTURES dures de bougies closes
//   (la bougie en cours de formation n'est jamais utilisée pour trader)
// - frais taker estimés à chaque fermeture (feePct par jambe)
// ============================================================

const CONFIG = require('./config');

/** Formatage lisible d'une durée (ms) : "45 s", "3 min 12 s", "1 h 05 min" */
function fmtDuration(ms) {
  if (ms == null || !(ms >= 0)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h} h ${String(rm).padStart(2, '0')} min` : `${h} h`;
}

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

  /** PnL brut d'une position fermée au prix `price` : qty × Δprix, signé selon le sens. */
  realizedPnl(pos, price) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    return pos.qty * (price - pos.entryPrice) * dir;
  }

  /** Prix exact du Take Profit et du Stop Loss d'une position (selon son sens). */
  tpSlPrices(pos) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    const pTP = pos.entryPrice * (1 + (dir * pos.tpPct) / 100);
    const pSL = pos.entryPrice * (1 - (dir * pos.slPct) / 100);
    return { pTP, pSL };
  }

  /** [min,max] des prix TP/SL (pour la barre SL→TP du dashboard). */
  tpSlRange(pos) {
    const { pTP, pSL } = this.tpSlPrices(pos);
    return [Math.min(pTP, pSL), Math.max(pTP, pSL)];
  }

  /**
   * Vérifie si une clôture a franchi le TP ou le SL.
   * Si les deux sont franchis dans la même bougie, priorité au SL (conservateur).
   * @returns {null|{kind:'TP'|'SL', price:number}}
   */
  checkExit(pos, closePrice) {
    const { pTP, pSL } = this.tpSlPrices(pos);
    const hitSL = pos.side === 'LONG' ? closePrice <= pSL : closePrice >= pSL;
    const hitTP = pos.side === 'LONG' ? closePrice >= pTP : closePrice <= pTP;
    if (hitSL) return { kind: 'SL', price: pSL };
    if (hitTP) return { kind: 'TP', price: pTP };
    return null;
  }

  // ---------- dimensionnement ----------

  /**
   * Marge = riskPct % du capital actuel.
   * Exposition notionnelle = marge × levier.
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
    // Cooldown entre deux trades sur le même symbole
    const last = this.lastTradeTime.get(symbol) || 0;
    if (Date.now() - last < this.cfg.cooldownMs) return false;
    return true;
  }

  /**
   * Ouvre une position si le signal est validé.
   * @param {string} symbol
   * @param {'LONG'|'SHORT'} side
   * @param {number} price  prix d'entrée (clôture dure de la bougie close)
   * @param {object} meta   { changePct, rsi } pour le log
   */
  async openPosition(symbol, side, price, meta = {}) {
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

    // ----- Trading réel : on place l'ordre sur l'exchange AVANT d'enregistrer
    // la position. En cas d'échec (clé API insuffisante, solde, réseau…),
    // aucune position simulée n'est créée : le journal dit pourquoi. -----
    if (typeof this.cfg.onOpen === 'function') {
      let res;
      try {
        res = await this.cfg.onOpen({ symbol, side, price, qty, leverage });
      } catch (e) {
        this.log('ERROR', `⛔ Ordre RÉEL refusé (${side} ${symbol}) : ${e.message}. Position non ouverte.`);
        return null;
      }
      if (res && res.entryPrice > 0) pos.entryPrice = res.entryPrice; // prix réel d'exécution
      pos.orderId = res ? res.id ?? null : null;
    }

    this.positions.set(symbol, pos);
    this.lastTradeTime.set(symbol, Date.now());
    this.log('TRADE', `Ouverture ${side} ${symbol} @ ${pos.entryPrice.toFixed(4)} | marge=${margin.toFixed(2)}$ levier=${leverage}x expo=${notional.toFixed(2)}$ | var=${meta.changePct?.toFixed(3)}% RSI=${meta.rsi?.toFixed(1)}${pos.orderId ? ` | orderId=${pos.orderId}` : ''}`);
    return pos;
  }

  // ---------- sortie ----------

  async closePosition(symbol, price, reason) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    // ----- Trading réel : l'ordre de clôture est envoyé AVANT d'inscrire le
    // trade. Si l'exchange refuse, la position reste ouverte (on réessaiera
    // au cycle suivant) et le journal explique l'échec. -----
    if (typeof this.cfg.onClose === 'function') {
      try {
        await this.cfg.onClose({ symbol, side: pos.side, qty: pos.qty, price, reason });
      } catch (e) {
        this.log('ERROR', `⛔ Clôture RÉELLE refusée (${reason} ${pos.side} ${symbol}) : ${e.message}. Position conservée.`);
        return null;
      }
    }

    // Frais taker estimés sur les deux jambes (entrée + sortie), assis sur le
    // volume réellement échangé (au moins le notionnel ouvert).
    const now = Date.now();
    const feePct = this.cfg.feePct ?? 0.04; // % par jambe
    const fees = (pos.notional + pos.qty * price) * (feePct / 100);
    const grossPnl = this.realizedPnl(pos, price);
    const pnl = grossPnl - fees;

    this.capital += pnl;               // le PnL NET réalisé revient dans le cash
    this.positions.delete(symbol);

    const trade = {
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      margin: pos.margin,
      leverage: pos.leverage,
      pnl,
      grossPnl,
      fees,
      reason,                          // 'TP' | 'SL' | 'MANUAL'
      openedAt: pos.openedAt,          // horodatage d'entrée (ms)
      closedAt: now,                   // horodatage de sortie (ms)
      durationMs: now - pos.openedAt,  // durée du trade (ms)
    };
    this.closedTrades.push(trade);
    if (this.closedTrades.length > 500) this.closedTrades.shift();

    const durStr = fmtDuration(trade.durationMs);
    const entryTime = new Date(pos.openedAt).toLocaleTimeString('fr-FR');
    this.log('EXIT', `Fermeture ${reason} ${pos.side} ${symbol} @ ${price.toFixed(4)} | entrée ${entryTime} | durée ${durStr} | PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$ (brut ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(2)}$, frais -${fees.toFixed(2)}$) | capital=${this.capital.toFixed(2)}$`);
    return trade;
  }

  /** Fermeture manuelle (bouton du dashboard) — async car hooks réels. */
  async closeAll(priceFn) {
    for (const [sym, pos] of [...this.positions]) {
      const price = priceFn ? priceFn(sym, pos.entryPrice) : pos.entryPrice;
      await this.closePosition(sym, price, 'MANUAL');
    }
  }

  // ---------- équité ----------

  unrealizedPnl(pos, price) {
    return this.realizedPnl(pos, price);
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

  /**
   * Equity = cash (capital réalisé) + somme des PnL non réalisés.
   * La marge engagée d'une position ouverte est DÉJÀ comprise dans le cash
   * (elle n'est jamais "re-prélevée") : on ajoute uniquement le PnL latent.
   */
  equity(pricesBySymbol = {}) {
    let eq = this.capital;
    for (const [sym, pos] of this.positions) {
      const price = pricesBySymbol[sym] ?? pos.entryPrice;
      eq += this.unrealizedPnl(pos, price);
    }
    return eq;
  }

  recordEquity(pricesBySymbol) {
    this.equityHistory.push({ t: Date.now(), equity: this.equity(pricesBySymbol) });
    if (this.equityHistory.length > 2000) this.equityHistory.shift();
  }

  /**
   * Historique d'équité recalculé à partir des trades fermés uniquement.
   * equity(t) = capital initial + Σ PnL nets réalisés dont closedAt <= t.
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
    hist.push({ t: Date.now(), equity: this.capital });
    this.equityHistory = hist.slice(-2000);
  }

  // ---------- statistiques ----------

  stats() {
    const wins = this.closedTrades.filter((t) => t.pnl > 0);
    const losses = this.closedTrades.filter((t) => t.pnl <= 0);
    const totalPnl = this.closedTrades.reduce((s, t) => s + t.pnl, 0);
    const totalFees = this.closedTrades.reduce((s, t) => s + (t.fees || 0), 0);
    return {
      capital: this.capital,
      openPositions: this.positions.size,
      closedCount: this.closedTrades.length,
      winRate: this.closedTrades.length ? (wins.length / this.closedTrades.length) * 100 : 0,
      wins: wins.length,
      losses: losses.length,
      totalPnl,
      totalFees,
    };
  }

  /** Temps restant de cooldown pour un symbole (0 si aucun) */
  cooldownLeft(symbol) {
    const last = this.lastTradeTime.get(symbol) || 0;
    return Math.max(0, last + this.cfg.cooldownMs - Date.now());
  }

  snapshot(pricesBySymbol = {}) {
    const editableKeys = Object.keys(require('./params').PARAM_SCHEMA);
    const params = {};
    for (const k of editableKeys) params[k] = this.cfg[k];

    // cooldown restant par symbole (affiché dans les cartes de signaux)
    const cooldowns = {};
    for (const sym of new Set([...this.cfg.symbols, ...this.positions.keys()])) cooldowns[sym] = this.cooldownLeft(sym);

    const positions = [...this.positions.values()].map((p) => {
      const price = pricesBySymbol[p.symbol] ?? p.entryPrice;
      const [tpLo, tpHi] = this.tpSlRange(p);
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
