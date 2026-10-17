// ============================================================
// Manipulation de bougies OHLCV
// - suppression de la bougie en cours de formation (non close)
// - agrégation de bougies (ex. 3x1m -> 3m)
// ============================================================

const TF_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000,
};

/** Bougies closes uniquement (la dernière, en cours de formation, est retirée). */
function closedCandles(candles) {
  if (!candles || candles.length < 2) return [];
  return candles.slice(0, -1);
}

/** Agrège des bougies de base (timeframe fromMs) en bougies timeframe toMs. */
function aggregate(candles, fromMs, toMs) {
  const factor = Math.round(toMs / fromMs);
  if (!Number.isFinite(factor) || factor <= 1) return candles;
  const out = [];
  let bucket = null, bucketStart = null;
  for (const c of candles) {
    if (c.time == null) return candles; // mode démo sans timestamps : pas d'agrégation
    const start = Math.floor(c.time / toMs) * toMs;
    if (start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = start;
      bucket = { time: start, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
    }
  }
  if (bucket) out.push(bucket);
  // retire le dernier bucket s'il est encore en cours de formation
  if (out.length && Date.now() < out[out.length - 1].time + toMs) out.pop();
  return out;
}

module.exports = { TF_MS, closedCandles, aggregate };
