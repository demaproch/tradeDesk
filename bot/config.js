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
  maxLeverage: 12,                // levier plafond (paper ; bridé à 5x en mode réel)

  // --- Mode de trading ---
  tradingMode: 'paper',           // 'paper' (simulation) | 'real' (ordres sur l'exchange via clés API du coffre)

  // --- Sorties (TP / SL fixes, pas de trailing) ---
  takeProfitPct: 2.8,             // TP : +2.8% de mouvement du prix
  stopLossPct: 1.0,               // SL : -1.0% de mouvement du prix

  // --- Trailing stop & break-even (0 = désactivé, comportement d'origine) ---
  trailingPct: 0,                 // ex. 1.5 : le stop suit le pic à -1.5% de recul max
  breakEvenPct: 0,                // ex. 1.0 : à +1.0% de gain, stop remonté au prix d'entrée
  breakEvenOffsetPct: 0,          // coussin au-dessus du prix d'entrée quand BE actif (%)

  // --- Filtres avancés (désactivés par défaut = stratégie d'origine) ---
  emaTrendFilter: 0,              // 0 = off ; N>0 : LONG seulement si clôture > EMA(N), SHORT < EMA(N)
  trendTimeframe: '1h',           // timeframe du filtre de tendance (multi-timeframe)
  maxTotalExposurePct: 300,       // plafond d'exposition notionnelle cumulée (% du capital) — gère la corrélation BTC/ETH/SOL…
  tradingHoursUTC: '',            // ex. "13-21" : n'ouvrir des trades qu'entre ces heures UTC (vide = toujours)

  // --- Mode observation (watch) : signaux calculés/journalisés, aucun ordre ---
  observeOnly: false,

  // --- Ordres conditionnels côté exchange (mode réel uniquement) ---
  useExchangeStops: true,         // place STOP_MARKET/TAKE_PROFIT_MARKET réels en plus du polling bot

  // --- Alertes push (Telegram / webhook) — configurables via le dashboard ---
  alertOnClose: true,             // notifier chaque fermeture (TP/SL/MANUEL)
  alertOnError: true,             // notifier erreurs réseau/refus d'ordre
  alertDrawdownPct: 20,           // alerter si le drawdown dépasse ce % (0 = désactivé)

  // --- Règles supplémentaires ---
  cooldownMs: 5 * 60 * 1000,      // 5 minutes entre deux trades sur le même symbole
  maxOnePositionPerSymbol: true,  // une seule position à la fois par symbole
  feePct: 0.04,                   // frais taker estimés par jambe en % (binance futures ~0.04-0.05%)

  // --- Dashboard ---
  port: 3000,                     // port HTTP du dashboard
};

module.exports = CONFIG;
