// ============================================================
// Indicateurs techniques (implémentation pure JS, zéro dépendance)
// ============================================================

/**
 * RSI à lissage de Wilder.
 * @param {number[]} closes  série de clôtures (la plus récente en dernier)
 * @param {number}   period  période du RSI (6 ici)
 * @returns {number|null}    dernière valeur du RSI, ou null si données insuffisantes
 */
function rsi(closes, period = 6) {
  if (!closes || closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;

  // Premières moyennes (SMA des gains/pertes sur la première fenêtre)
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Lissage de Wilder sur le reste de la série
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100; // pas de perte -> RSI = 100
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Variation de prix en % sur les N dernières bougies.
 * (prix actuel - prix il y a N bougies) / prix il y a N bougies * 100
 * @param {Array<{close:number}>} candles  bougies triées de la plus ancienne à la plus récente
 * @param {number} lookback                nombre de bougies (10 ici)
 * @returns {number|null}
 */
function priceChangePct(candles, lookback = 10) {
  if (!candles || candles.length < lookback + 1) return null;
  const current = candles[candles.length - 1].close;          // prix actuel
  const past = candles[candles.length - 1 - lookback].close;  // prix il y a `lookback` bougies
  if (past === 0) return null;
  return ((current - past) / past) * 100;
}

module.exports = { rsi, priceChangePct };
