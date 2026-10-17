// ============================================================
// Configuration de la stratégie (modifiable sans toucher au code)
// ============================================================

const CONFIG = {
  // --- Exchange / marché ---
  exchange: 'binance',            // exchange ccxt supportant les futures USDT
  marketType: 'future',           // trade sur les perpetuals (LONG + SHORT)
  symbols: [                      // paires tradées
    'BTC/USDT:USDT',
    'ETH/USDT:USDT',
    'SOL/USDT:USDT',
    'AVAX/USDT:USDT',
    'SUI/USDT:USDT',
  ],

  // --- Timeframe ---
  timeframe: '5m',                // 1m | 3m | 5m | 15m | 30m | 1h | 4h
  candlesLimit: 60,               // on récupère plus que nécessaire pour le RSI

  // --- Boucle du bot ---
  cycleMs: 50_000,                // un cycle toutes les ~50 secondes

  // --- Détection du signal (momentum) ---
  lookbackCandles: 10,            // variation calculée sur les 10 dernières bougies
  minMovePct: 0.55,               // seuil de variation en % (0.55%)
  rsiPeriod: 6,                   // RSI sur 6 périodes
  rsiLongMin: 52,                 // LONG : RSI > 52
  rsiShortMax: 48,                // SHORT : RSI < 48

  // --- Money management ---
  initialCapital: 1000,           // capital de départ simulé ($)
  riskPct: 8,                     // risque = 8% du capital par trade
  leverage: 10,                   // levier utilisé
  maxLeverage: 12,                // levier plafond

  // --- Sorties (TP / SL fixes, pas de trailing) ---
  takeProfitPct: 2.8,             // TP : +2.8% de mouvement du prix
  stopLossPct: 1.0,               // SL : -1.0% de mouvement du prix

  // --- Règles supplémentaires ---
  cooldownMs: 5 * 60 * 1000,      // 5 minutes entre deux trades sur le même symbole
  maxOnePositionPerSymbol: true,  // une seule position à la fois par symbole
  feePct: 0.04,                   // frais taker estimés par jambe en % (binance futures ~0.04-0.05%)

  // --- Dashboard ---
  port: 3000,                     // port HTTP du dashboard
};

module.exports = CONFIG;
