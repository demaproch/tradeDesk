// ============================================================
// Cœur de stratégie momBot — version PURE (aucune dépendance,
// aucun Date.now() interne) : utilisable telle quelle par le bot
// live ET par le backtesteur.
//
// evaluateBar() reçoit les bougies CLOSES dont la dernière vient
// de se clôturer, et renvoie l'action à exécuter :
//   { action:'EXIT', kind:'TP'|'SL', price }  sortie prioritaire
//   { action:'OPEN', side:'LONG'|'SHORT', changePct, rsi } entrée validée
//   null                                       rien à faire
// ============================================================

const { rsi, priceChangePct } = require('./indicators');

/** Prix exact TP/SL d'une position ouverte (selon son sens). */
function tpSlPrices(pos, tpPct, slPct) {
  const dir = pos.side === 'LONG' ? 1 : -1;
  return {
    pTP: pos.entryPrice * (1 + (dir * tpPct) / 100),
    pSL: pos.entryPrice * (1 - (dir * slPct) / 100),
  };
}

/** Détection de franchissement TP/SL sur une clôture (priorité au SL). */
function checkExitBar(pos, closePrice, tpPct, slPct) {
  const { pTP, pSL } = tpSlPrices(pos, tpPct, slPct);
  const hitSL = pos.side === 'LONG' ? closePrice <= pSL : closePrice >= pSL;
  const hitTP = pos.side === 'LONG' ? closePrice >= pTP : closePrice <= pTP;
  if (hitSL) return { kind: 'SL', price: pSL };
  if (hitTP) return { kind: 'TP', price: pTP };
  return null;
}

/** Signal d'entrée momentum : variation sur N bougies + confirmation RSI. */
function entrySignal(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const changePct = priceChangePct(candles, cfg.lookbackCandles);
  const r = rsi(closes, cfg.rsiPeriod);
  if (changePct == null || r == null) return null;
  if (changePct > cfg.minMovePct && r > cfg.rsiLongMin) return { side: 'LONG', changePct, rsi: r };
  if (changePct < -cfg.minMovePct && r < cfg.rsiShortMax) return { side: 'SHORT', changePct, rsi: r };
  return null;
}

/**
 * Évalue une nouvelle bougie close pour un symbole.
 * @param {Array<{time?,open?,high?,low?,close}>} closedCandles série de clôtures dures
 * @param {{side:string, entryPrice:number}|null} position position ouverte ou null
 * @param {object} cfg paramètres de stratégie (tpPct, slPct, minMovePct, rsiLongMin, rsiShortMax, lookback…)
 * @returns {null|{action:'EXIT',kind,price}|{action:'OPEN',side,changePct,rsi}}
 */
function evaluateBar(closedCandles, position, cfg) {
  if (!closedCandles || closedCandles.length < Math.max(cfg.lookbackCandles + 1, cfg.rsiPeriod + 2)) return null;
  const closePrice = closedCandles[closedCandles.length - 1].close;

  // 1) Sortie prioritaire (TP/SL sur clôture, prix exact du niveau)
  if (position) {
    const exit = checkExitBar(position, closePrice, cfg.takeProfitPct, cfg.stopLossPct);
    if (exit) return { action: 'EXIT', ...exit };
    return null; // une position ouverte bloque toute nouvelle entrée
  }

  // 2) Entrée (momentum + RSI)
  const sig = entrySignal(closedCandles, cfg);
  if (!sig) return null;
  return { action: 'OPEN', ...sig };
}

module.exports = { evaluateBar, entrySignal, checkExitBar, tpSlPrices };
