// ============================================================
// Tests unitaires de la stratégie (node test_strategy.js)
// Vérifie chaque règle décrite dans le cahier des charges.
// ============================================================
const assert = require('assert');
const CONFIG = require('./config');
const { rsi, priceChangePct } = require('./indicators');
const TradingEngine = require('./engine');

let passed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1; }
}

console.log('\n— Paramètres généraux —');
t('timeframe par défaut = 5m', () => assert.strictEqual(CONFIG.timeframe, '5m'));
t('5 paires configurées', () => assert.deepStrictEqual(CONFIG.symbols, ['BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','AVAX/USDT:USDT','SUI/USDT:USDT']));
t('capital initial = 1000 $', () => assert.strictEqual(CONFIG.initialCapital, 1000));
t('cycle ~50 s', () => assert.strictEqual(CONFIG.cycleMs, 50_000));

console.log('\n— Indicateurs —');
t('RSI(6) : série en hausse -> RSI élevé', () => {
  const closes = Array.from({length: 30}, (_, i) => 100 + i); // hausse continue
  assert.ok(rsi(closes, 6) === 100); // avgLoss=0 -> 100
});
t('RSI(6) : série en baisse -> RSI bas', () => {
  const closes = Array.from({length: 30}, (_, i) => 200 - i);
  assert.ok(rsi(closes, 6) < 20);
});
t('RSI(6) référence Wilder (données classiques) ≈ 71.45', () => {
  const closes = [44,44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28];
  assert.ok(Math.abs(rsi(closes, 6) - 71.45) < 0.02);
});
t('variation sur 10 bougies = (actuel - N-10)/N-10 * 100', () => {
  const candles = Array.from({length: 20}, (_, i) => ({ close: i < 10 ? 100 : 100 + i }));
  // prix actuel = clôture idx 19 = 119 ; prix il y a 10 bougies = idx 9 = 100 -> +19%
  assert.ok(Math.abs(priceChangePct(candles, 10) - 19) < 1e-9);
});
t('données insuffisantes -> null', () => assert.strictEqual(priceChangePct([{close:1}], 10), null));

console.log('\n— Conditions d’entrée —');
// reproduit la logique de bot.js/processSymbol
function signal(changePct, r, cfg = CONFIG) {
  if (changePct > cfg.minMovePct && r > cfg.rsiLongMin) return 'LONG';
  if (changePct < -cfg.minMovePct && r < cfg.rsiShortMax) return 'SHORT';
  return null;
}
t('LONG si var>+0.55% et RSI>52', () => assert.strictEqual(signal(0.60, 55), 'LONG'));
t('pas de LONG si RSI=52 (strict)', () => assert.strictEqual(signal(0.60, 52), null));
t('pas de LONG si var=0.55% (strict)', () => assert.strictEqual(signal(0.55, 55), null));
t('SHORT si var<-0.55% et RSI<48', () => assert.strictEqual(signal(-0.60, 45), 'SHORT'));
t('pas de SHORT si RSI=48 (strict)', () => assert.strictEqual(signal(-0.60, 48), null));
t('var positive + RSI faible -> aucun signal', () => assert.strictEqual(signal(0.8, 40), null));

console.log('\n— Money management —');
t('marge = 8% du capital, levier 10x, expo = marge*levier', () => {
  const e = new TradingEngine(CONFIG);
  const s = e.computePositionSize();
  assert.strictEqual(s.margin, 80);
  assert.strictEqual(s.leverage, 10);
  assert.strictEqual(s.notional, 800);
});
t('levier plafonné à maxLeverage (12x)', () => {
  const e = new TradingEngine({ ...CONFIG, leverage: 20 });
  assert.strictEqual(e.computePositionSize().leverage, 12);
});

console.log('\n— TP / SL —');
t('TP LONG déclenché exactement à +2.8% (flottants gérés)', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 102.8), 'TP');   // 2.79999… IEEE -> TP quand même
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 102.5), null);   // en dessous -> pas de TP
});
t('SL LONG déclenché à -1.0%', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 99.0), 'SL');
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 101), null);
});
t('TP SHORT déclenché quand le prix baisse de 2.8%', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('ETH/USDT:USDT', 'SHORT', 1000);
  assert.strictEqual(e.checkExit(e.positions.get('ETH/USDT:USDT'), 972), 'TP');
});
t('PnL TP = marge × levier × 2.8% = 22.4$ (capital 1000)', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.ok(Math.abs(tr.pnl - 80 * 10 * 0.028) < 1e-9);
  assert.ok(Math.abs(e.capital - (1000 + 22.4)) < 1e-9);
});
t('PnL SL = -marge × levier × 1% = -8$', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = e.closePosition('BTC/USDT:USDT', 99, 'SL');
  assert.ok(Math.abs(tr.pnl + 8) < 1e-9);
});

console.log('\n— Règles supplémentaires —');
t('une seule position par symbole', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(e.openPosition('BTC/USDT:USDT', 'SHORT', 100), null);
});
t('cooldown 5 min bloque la réouverture', () => {
  const e = new TradingEngine(CONFIG); // cooldownMs = 300000
  e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.strictEqual(e.canOpen('BTC/USDT:USDT'), false);
  // après expiration simulée du cooldown
  e.lastTradeTime.set('BTC/USDT:USDT', Date.now() - 301_000);
  assert.strictEqual(e.canOpen('BTC/USDT:USDT'), true);
});
t('équité = cash + marge + PnL non réalisé', () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  e.openPosition('BTC/USDT:USDT', 'LONG', 100); // marge 80$, levier 10x
  const eq = e.equity({ 'BTC/USDT:USDT': 101 }); // +1% -> uPnl = 80*10*1% = 8$
  assert.ok(Math.abs(eq - (1000 + 80 + 8)) < 1e-9);
});

console.log(`\n${passed} tests passés${process.exitCode ? ' — ÉCHECS DÉTECTÉS' : ' — tout est vert 🟢'}\n`);
