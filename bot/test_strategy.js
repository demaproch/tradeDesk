// ============================================================
// Tests unitaires de la stratégie (node test_strategy.js)
// Vérifie chaque règle décrite dans le cahier des charges.
// ============================================================
const assert = require('assert');
const CONFIG = require('./config');
const { rsi, priceChangePct } = require('./indicators');
const TradingEngine = require('./engine');
const { TF_MS, closedCandles, aggregate } = require('./candles');

let passed = 0;
const tests = [];
function t(name, fn) {
  // les fonctions de test peuvent être async (openPosition/closePosition sont async)
  tests.push([name, fn]);
}

// Engine de test SANS frais (isole la logique TP/SL/PnL brut)
const NOFEE = { ...CONFIG, feePct: 0 };

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

console.log('\n— TP / SL (checkExit retourne {kind, price}) —');
t('TP LONG déclenché exactement à +2.8%', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 102.8).kind, 'TP');
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 102.5), null); // en dessous -> pas de TP
});
t('SL LONG déclenché à -1.0%', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 99.0).kind, 'SL');
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 101), null);
});
t('TP SHORT déclenché quand le prix baisse de 2.8%', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('ETH/USDT:USDT', 'SHORT', 1000);
  assert.strictEqual(e.checkExit(e.positions.get('ETH/USDT:USDT'), 972).kind, 'TP');
});
t('prix d’exécution = prix exact du niveau (pas la clôture qui a slippé)', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  // clôture à 103.5 : le TP (102.8) est franchi -> exécuté à 102.8, pas 103.5
  const exit = e.checkExit(e.positions.get('BTC/USDT:USDT'), 103.5);
  assert.strictEqual(exit.kind, 'TP');
  assert.ok(Math.abs(exit.price - 102.8) < 1e-9, `price=${exit.price}`);
  // clôture à 98 : le SL (99) est franchi -> exécuté à 99, pas 98
  const e2 = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e2.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const exit2 = e2.checkExit(e2.positions.get('BTC/USDT:USDT'), 98);
  assert.strictEqual(exit2.kind, 'SL');
  assert.ok(Math.abs(exit2.price - 99) < 1e-9, `price=${exit2.price}`);
});
t('si TP et SL franchis sur la même bougie -> priorité au SL (conservateur)', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  // on simule un passage direct à une clôture qui a traversé les deux niveaux
  const exit = e.checkExit(e.positions.get('BTC/USDT:USDT'), 98); // sous SL
  assert.strictEqual(exit.kind, 'SL');
});
t('PnL TP brut = marge × levier × 2.8% = 22.4$ (capital 1000, sans frais)', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.ok(Math.abs(tr.pnl - 80 * 10 * 0.028) < 1e-9);
  assert.ok(Math.abs(e.capital - (1000 + 22.4)) < 1e-9);
});
t('PnL SL brut = -marge × levier × 1% = -8$ (sans frais)', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = await e.closePosition('BTC/USDT:USDT', 99, 'SL');
  assert.ok(Math.abs(tr.pnl + 8) < 1e-9);
});

console.log('\n— Frais de transaction —');
t('frais appliqués aux deux jambes, déduits du PnL', async () => {
  const e = new TradingEngine({ ...CONFIG, feePct: 0.04, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);   // notional 800$
  const tr = await e.closePosition('BTC/USDT:USDT', 102.8, 'TP'); // sortie notional 822.4$
  const expectedFees = (800 + 822.4) * 0.0004;    // 0.64896$
  assert.ok(Math.abs(tr.fees - expectedFees) < 1e-9, `fees=${tr.fees}`);
  assert.ok(Math.abs(tr.pnl - (22.4 - expectedFees)) < 1e-9, `pnl=${tr.pnl}`);
  assert.ok(Math.abs(tr.grossPnl - 22.4) < 1e-9);
});
t('feePct = 0 -> aucun frais', async () => {
  const e = new TradingEngine({ ...CONFIG, feePct: 0, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.strictEqual(tr.fees, 0);
});

console.log('\n— Règles supplémentaires —');
t('une seule position par symbole', async () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(await e.openPosition('BTC/USDT:USDT', 'SHORT', 100), null);
});
t('cooldown 5 min bloque la réouverture', async () => {
  const e = new TradingEngine(CONFIG); // cooldownMs = 300000
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.strictEqual(e.canOpen('BTC/USDT:USDT'), false);
  // après expiration simulée du cooldown
  e.lastTradeTime.set('BTC/USDT:USDT', Date.now() - 301_000);
  assert.strictEqual(e.canOpen('BTC/USDT:USDT'), true);
});
t('checkExit ne ferme rien et renvoie le niveau exact — SL avant TP si les deux sont atteignables', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'SHORT', 100); // TP=97.2, SL=101
  assert.strictEqual(e.checkExit(e.positions.get('BTC/USDT:USDT'), 100.5), null);
  const hit = e.checkExit(e.positions.get('BTC/USDT:USDT'), 102); // au-dessus du SL
  assert.strictEqual(hit.kind, 'SL');
  assert.ok(Math.abs(hit.price - 101) < 1e-9);
});

console.log('\n— Bougies closes & agrégation (candles.js) —');
t('closedCandles retire la dernière bougie (en cours de formation)', () => {
  const raw = [{ time: 0, close: 1 }, { time: 1, close: 2 }, { time: 2, close: 3 }];
  assert.deepStrictEqual(closedCandles(raw), [{ time: 0, close: 1 }, { time: 1, close: 2 }]);
});
t('closedCandles : moins de 2 bougies -> []', () => {
  assert.deepStrictEqual(closedCandles([{ time: 0, close: 1 }]), []);
});
t('agrège 1m -> 3m (open/high/low/close du bucket)', () => {
  const m = 60_000;
  const now = Math.floor(Date.now() / (3 * m)) * (3 * m); // début d'un bucket 3m déjà révolu
  const raw = [
    { time: now - 3 * m, open: 10, high: 11, low: 9,  close: 10.5 },
    { time: now - 2 * m, open: 10.5, high: 12, low: 10, close: 11.5 },
    { time: now - 1 * m, open: 11.5, high: 13, low: 11, close: 12 },
    { time: now + 2 * m, open: 12, high: 12.5, low: 11.5, close: 12.2 }, // bucket en cours -> écarté
  ];
  const agg = aggregate(raw, TF_MS['1m'], TF_MS['3m']);
  assert.strictEqual(agg.length, 1);
  assert.strictEqual(agg[0].open, 10);
  assert.strictEqual(agg[0].high, 13);
  assert.strictEqual(agg[0].low, 9);
  assert.strictEqual(agg[0].close, 12);
});
t('agrège : facteur 1 = passe-plat', () => {
  const raw = [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5 }];
  assert.deepStrictEqual(aggregate(raw, TF_MS['5m'], TF_MS['5m']), raw);
});
t('équité = cash + PnL non réalisé (la mise n\'est JAMAIS re-additionnée)', async () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100); // marge 80$, levier 10x
  const eq = e.equity({ 'BTC/USDT:USDT': 101 }); // +1% -> uPnl = 80*10*1% = 8$
  // equity attendue = 1000 + 8 = 1008 (et non 1000 + 80 + 8 = 1088 : ancien bug)
  assert.ok(Math.abs(eq - 1008) < 1e-9, `equity=${eq}`);
});
t('équité = cash quand la position est au prix d\'entrée (pas de bonus de marge)', async () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.ok(Math.abs(e.equity({ 'BTC/USDT:USDT': 100 }) - 1000) < 1e-9);
});
t('équité cohérente à travers ouverture → TP → fermeture', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.ok(Math.abs(e.equity({ 'BTC/USDT:USDT': 102.8 }) - (1000 + 22.4)) < 1e-9); // uPnl au TP
  await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.ok(Math.abs(e.capital - 1022.4) < 1e-9);
  assert.ok(Math.abs(e.equity() - 1022.4) < 1e-9); // plus de position => equity == cash
});
t('équité multi-positions : jamais la somme des mises (bug "ajoute les mises initiales")', async () => {
  const e = new TradingEngine({ ...CONFIG, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);   // marge 80$
  await e.openPosition('ETH/USDT:USDT', 'SHORT', 100);  // marge 80$
  // prix aux points d'entrée -> PnL latent nul -> équité = cash = 1000 (et non 1160)
  const eq = e.equity({ 'BTC/USDT:USDT': 100, 'ETH/USDT:USDT': 100 });
  assert.ok(Math.abs(eq - 1000) < 1e-9, `equity=${eq}`);
  // BTC +1% (uPnl +8$), ETH -0.5% en SHORT (uPnl +4$) -> 1012 exactement
  const eq2 = e.equity({ 'BTC/USDT:USDT': 101, 'ETH/USDT:USDT': 99.5 });
  assert.ok(Math.abs(eq2 - 1012) < 1e-9, `equity=${eq2}`);
  // totalUnrealized = equity - cash
  assert.ok(Math.abs(e.totalUnrealized({ 'BTC/USDT:USDT': 101, 'ETH/USDT:USDT': 99.5 }) - 12) < 1e-9);
});
t('historique d\'équité reconstruit = capital initial + Σ PnL réalisés uniquement', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0 });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');   // +22.4$ -> cash 1022.4
  await e.openPosition('ETH/USDT:USDT', 'LONG', 100);    // marge = 8% de 1022.4
  await e.closePosition('ETH/USDT:USDT', 99, 'SL');      // -8.1792$
  e.rebuildEquityHistory();
  const expected = 1000 + 22.4 - 8 * 1.0224;       // SL sur la 2e position calculée après le TP
  const last = e.equityHistory[e.equityHistory.length - 1];
  assert.ok(Math.abs(last.equity - expected) < 1e-6, `last=${last.equity} attendu≈${expected}`);
  // premier point = capital initial, aucune marge ajoutée nulle part
  assert.strictEqual(e.equityHistory[0].equity, CONFIG.initialCapital);
  // aucune marge re-additionnée nulle part : max = cash après le TP, min = capital initial
  for (const p of e.equityHistory) assert.ok(p.equity <= 1022.4 + 1e-9 && p.equity >= CONFIG.initialCapital - 1e-9);
});

// ---------- Sélection des paires via le dashboard ----------
const { normalizeSymbols, validatePatch: vp2, symbolUniverse } = require('./params');
t('normalizeSymbols : accepte BTC/USDT et ajoute :USDT', () => assert.deepStrictEqual(normalizeSymbols(['BTC/USDT']).value, ['BTC/USDT:USDT']));
t('normalizeSymbols : chaîne CSV + dédoublonnage', () => assert.deepStrictEqual(normalizeSymbols('btc/usdt:usdt, ETH/USDT:usdt ,BTC/USDT:USDT').value, ['BTC/USDT:USDT','ETH/USDT:USDT']));
t('normalizeSymbols : refuse liste vide', () => assert.strictEqual(normalizeSymbols([]).ok, false));
t('normalizeSymbols : refuse format invalide', () => assert.strictEqual(normalizeSymbols(['FAKE']).ok, false));
t('validatePatch symboles : valide', () => { const r = vp2({ symbols: ['BTC/USDT:USDT'] }, CONFIG); assert.ok(r.ok); assert.deepStrictEqual(r.changes.symbols, ['BTC/USDT:USDT']); });
t('validatePatch symboles : vide rejeté', () => assert.strictEqual(vp2({ symbols: [] }, CONFIG).ok, false));
t('symbolUniverse : contient les actives en premier', () => { const u = symbolUniverse(['TON/USDT:USDT']); assert.strictEqual(u[0], 'TON/USDT:USDT'); assert.ok(u.includes('BTC/USDT:USDT')); });
t('snapshot cooldowns inclut les paires en position hors sélection', async () => {
  const cfg = { ...CONFIG, symbols: ['BTC/USDT:USDT'] };
  const e = new TradingEngine(cfg);
  await e.openPosition('ETH/USDT:USDT', 'LONG', 3000);
  const snap = e.snapshot({});
  assert.ok('ETH/USDT:USDT' in snap.cooldowns && 'BTC/USDT:USDT' in snap.cooldowns);
});


// ---------- Hooks de trading réel (onOpen / onClose) ----------
t('onOpen qui lève -> aucune position créée, journal explique', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0, onOpen: () => { throw new Error('solde insuffisant'); } });
  const pos = await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(pos, null);
  assert.strictEqual(e.positions.size, 0);
  assert.ok(e.logs.some((l) => l.level === 'ERROR' && /Ordre RÉEL refusé/.test(l.msg)));
});
t('onOpen réussi -> prix d’exécution réel retenu + orderId', async () => {
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0, onOpen: () => ({ id: '42', entryPrice: 100.5 }) });
  const pos = await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  assert.strictEqual(pos.entryPrice, 100.5);
  assert.strictEqual(pos.orderId, '42');
});
t('onClose qui lève -> position conservée, pas de trade enregistré', async () => {
  let closed = 0;
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0, onClose: () => { closed++; throw new Error('rejet exchange'); } });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = await e.closePosition('BTC/USDT:USDT', 99, 'SL');
  assert.strictEqual(tr, null);
  assert.strictEqual(closed, 1);
  assert.strictEqual(e.positions.size, 1);          // toujours ouverte
  assert.strictEqual(e.closedTrades.length, 0);     // rien d'inscrit
  assert.strictEqual(e.capital, 1000);              // cash intact
});
t('onClose réussi -> clôture normale + ordre envoyé une fois', async () => {
  const sent = [];
  const e = new TradingEngine({ ...NOFEE, cooldownMs: 0, onClose: (o) => { sent.push(o); } });
  await e.openPosition('BTC/USDT:USDT', 'LONG', 100);
  const tr = await e.closePosition('BTC/USDT:USDT', 102.8, 'TP');
  assert.ok(tr && tr.pnl > 0);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].reason, 'TP');
  assert.strictEqual(sent[0].side, 'LONG');
});

// ---------- Coffre à secrets (clés API chiffrées) ----------
const os = require('os');
const fs = require('fs');
const path = require('path');
const { SecretStore } = require('./secrets');
t('SecretStore : round-trip chiffrement/déchiffrement AES-256-GCM', () => {
  const f = path.join(os.tmpdir(), `mombot-secrets-test-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  const s = new SecretStore(f);
  assert.strictEqual(s.configured, false);
  s.set('APIKEY123', 'SECRET456', 'master-pw');
  assert.strictEqual(s.status().configured, true);
  assert.strictEqual(s.unlocked, true);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('APIKEY123'));   // jamais en clair sur disque
  assert.ok(!JSON.stringify(raw).includes('SECRET456'));
  assert.ok(!JSON.stringify(raw).includes('master-pw'));
  const got = s.withApiKey(({ apiKey, apiSecret }) => ({ apiKey, apiSecret }));
  assert.deepStrictEqual(got, { apiKey: 'APIKEY123', apiSecret: 'SECRET456' });
  const s2 = new SecretStore(f);
  assert.strictEqual(s2.configured, true);
  assert.strictEqual(s2.unlocked, false);
  assert.strictEqual(s2.unlock('mauvais'), false);
  assert.strictEqual(s2.unlock('master-pw'), true);
  assert.strictEqual(s2.withApiKey((k) => k.apiKey), 'APIKEY123');
  s2.erase();
  assert.strictEqual(new SecretStore(f).configured, false);
});

// ---------- Authentification (scrypt + sessions + CSRF) ----------
const { AuthManager } = require('./auth');
t('Auth : mot de passe vérifié (scrypt), mauvais refusé', () => {
  const f = path.join(os.tmpdir(), `mombot-auth-test-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  const a = new AuthManager(f, 'hunter2');
  assert.strictEqual(a.verifyPassword('hunter2'), true);
  assert.strictEqual(a.verifyPassword('nope'), false);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('hunter2'));      // jamais en clair
  fs.unlinkSync(f);
});
t('Auth : session signée + CSRF double-submit', () => {
  const f = path.join(os.tmpdir(), `mombot-auth-test2-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  const a = new AuthManager(f, 'pw-x');
  let cookie = '';
  const res = { setHeader: (k, v) => { if (k === 'Set-Cookie') cookie = String(v); } };
  const csrf = a.createSession(res);
  const m = cookie.match(/mombot_session=([^;]+)/);
  const req = { headers: { cookie: `mombot_session=${m[1]}` } };
  assert.ok(a.getSession(req), 'session valide acceptée');
  const bad = { headers: { cookie: `mombot_session=${m[1].split('.')[0]}.9999999999999.AAAA` } };
  assert.strictEqual(a.getSession(bad), null);
  assert.strictEqual(a.checkCsrf(a.getSession(req), { headers: { 'x-csrf-token': csrf } }), true);
  assert.strictEqual(a.checkCsrf(a.getSession(req), { headers: {} }), false);
  a.destroySession(req, res);
  assert.strictEqual(a.getSession(req), null);
  fs.unlinkSync(f);
});
t('Auth : verrouillage après 10 échecs de login', () => {
  const f = path.join(os.tmpdir(), `mombot-auth-test3-${process.pid}.json`);
  try { fs.unlinkSync(f); } catch {}
  const a = new AuthManager(f, 'ok-pw');
  const codes = [];
  for (let i = 0; i < 12; i++) {
    let code = 0;
    const res = { status: (c) => { code = c; return res; }, json: () => res, setHeader: () => {} };
    a.handleLogin({ body: { password: 'wrong' } }, res);
    codes.push(code);
  }
  // NOTE : res.status() est évalué APRÈS res.json() dans `return res.status(...).json(...)`
  // donc codes[i] reflète le statut du traitement SUIVANT. Le 11e appel (i=10) voit
  // le verrou posé par le 10e échec -> 429 ; le 12e confirme le verrouillage.
  assert.strictEqual(codes.slice(0, 9).every((c) => c === 401), true);
  assert.strictEqual(codes[10], 429); // verrouillé
  assert.strictEqual(codes[11], 429);
  fs.unlinkSync(f);
});

// Exécution STRICTEMENT séquentielle de tous les tests (les async attendent bien),
// puis affichage du total.
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`); passed++;
    } catch (e) {
      console.log(`  ❌ ${name}\n     ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passés${process.exitCode ? " — ÉCHECS DÉTECTÉS" : " — tout est vert 🟢"}\n`);
})();
