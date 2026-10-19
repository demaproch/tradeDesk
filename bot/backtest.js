// ============================================================
// Backtesteur de la stratégie momBot
//   node backtest.js --symbol BTC/USDT:USDT --timeframe 5m --days 30
//   node backtest.js --all                      (toutes les paires du config)
// Options : --tp 2.8 --sl 1.0 --minMove 0.55 --rsiLong 52 --rsiShort 48
//           --lookback 10 --rsiPeriod 6 --risk 8 --levier 10 --fee 0.04
//           --cooldown 300000 --capital 1000 --emaFilter 50 --mode close|intrabar
//
// Deux modes de sortie :
//   close    : TP/SL évalués sur les CLÔTURES (comportement actuel du bot,
//              exécution au prix exact du niveau — optimiste si gap).
//   intrabar : le TP/SL est considéré touché dès que high/low de la bougie
//              franchit le niveau (exécute au niveau exact ; si les deux sont
//              franchis dans la même bougie → SL prioritaire, conservateur).
//              Plus fidèle à des stop orders réels.
//
// Filtre tendance (--emaFilter N, défaut 50) : LONG autorisé seulement si
// clôture > EMA(N) sur le timeframe supérieur (ici le même timeframe, EMA
// longue période = proxy), SHORT seulement si clôture < EMA(N).
// ============================================================

const ccxt = require('ccxt');
const CONFIG = require('./config');
const { entrySignal, checkExitBar } = require('./strategy');
const { rsi } = require('./indicators');

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** EMA vectorielle simple (pas de look-ahead : valeur à la barre i). */
function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  out[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

async function fetchHistory(exchange, symbol, timeframe, days) {
  const tfMs = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5 }[timeframe];
  if (!tfMs) throw new Error(`Timeframe non supporté en backtest : ${timeframe}`);
  const limitPerReq = 1500;
  const total = Math.ceil((days * 86400_000) / tfMs);
  const out = [];
  let since = Date.now() - total * tfMs;
  while (out.length < total) {
    const chunk = await exchange.fetchOHLCV(symbol, timeframe, since, Math.min(limitPerReq, total - out.length));
    if (!chunk.length) break;
    for (const c of chunk) out.push({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] });
    since = chunk[chunk.length - 1][0] + tfMs;
    if (chunk.length < 2) break;
  }
  // on ne garde que les bougies entièrement passées (la dernière peut être partielle)
  while (out.length && out[out.length - 1].time + tfMs > Date.now()) out.pop();
  return out;
}

function runBacktest(candles, cfg) {
  const warmup = Math.max(cfg.lookbackCandles + 1, cfg.rsiPeriod + 2, cfg.emaFilter || 0) + 1;
  const closes = candles.map((c) => c.close);
  const emas = cfg.emaFilter ? emaSeries(closes, cfg.emaFilter) : null;

  let capital = cfg.initialCapital;
  const startCapital = capital;
  let peak = capital, maxDdPct = 0, maxDdUsd = 0;
  const trades = [];
  let pos = null; // { side, entryPrice, qty, margin, openedTime }

  const feeJambe = cfg.feePct / 100;

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];
    const series = candles.slice(0, i + 1);

    // ---------- gestion de la position ouverte ----------
    if (pos) {
      let exit = null;
      if (cfg.exitMode === 'intrabar') {
        // TP/SL détectés sur high/low de la bougie courante
        const dir = pos.side === 'LONG' ? 1 : -1;
        const pTP = pos.entryPrice * (1 + (dir * cfg.takeProfitPct) / 100);
        const pSL = pos.entryPrice * (1 - (dir * cfg.stopLossPct) / 100);
        const hitSL = pos.side === 'LONG' ? bar.low <= pSL : bar.high >= pSL;
        const hitTP = pos.side === 'LONG' ? bar.high >= pTP : bar.low <= pTP;
        if (hitSL) exit = { kind: 'SL', price: pSL };
        else if (hitTP) exit = { kind: 'TP', price: pTP };
      } else {
        exit = checkExitBar(pos, bar.close, cfg.takeProfitPct, cfg.stopLossPct);
      }
      if (exit) {
        const dir = pos.side === 'LONG' ? 1 : -1;
        const gross = pos.qty * (exit.price - pos.entryPrice) * dir;
        const fees = (pos.margin * cfg.leverage + pos.qty * exit.price) * feeJambe;
        const pnl = gross - fees;
        capital += pnl;
        trades.push({ symbol: cfg.symbol, side: pos.side, entryTime: pos.openedTime, exitTime: bar.time, entryPrice: pos.entryPrice, exitPrice: exit.price, reason: exit.kind, grossPnl: gross, fees, pnl, durationMs: bar.time - pos.openedTime });
        pos = null;
        if (capital > peak) peak = capital;
        const ddUsd = peak - capital, ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
        if (ddUsd > maxDdUsd) { maxDdUsd = ddUsd; maxDdPct = ddPct; }
        continue; // cooldown implicite : entrée réévaluée à la bougie suivante
      }
    }

    // ---------- nouvelle entrée ----------
    if (!pos && bar.time - (trades.length ? trades[trades.length - 1].exitTime : 0) >= cfg.cooldownMs) {
      const sig = entrySignal(series, cfg);
      if (sig) {
        // filtre de tendance multi-timeframe (proxy EMA longue)
        if (emas && emas[i] != null) {
          if (sig.side === 'LONG' && !(bar.close > emas[i])) continue;
          if (sig.side === 'SHORT' && !(bar.close < emas[i])) continue;
        }
        const margin = capital * (cfg.riskPct / 100);
        const notional = margin * cfg.leverage;
        pos = { side: sig.side, entryPrice: bar.close, qty: notional / bar.close, margin, leverage: cfg.leverage, openedTime: bar.time };
      }
    }
  }

  // position restée ouverte en fin de backtest : valorisée à la dernière clôture
  if (pos) {
    const last = candles[candles.length - 1];
    const dir = pos.side === 'LONG' ? 1 : -1;
    const gross = pos.qty * (last.close - pos.entryPrice) * dir;
    const fees = (pos.margin * cfg.leverage + pos.qty * last.close) * feeJambe;
    capital += gross - fees;
    trades.push({ symbol: cfg.symbol, side: pos.side, entryTime: pos.openedTime, exitTime: last.time, entryPrice: pos.entryPrice, exitPrice: last.close, reason: 'OPEN_AT_END', grossPnl: gross, fees, pnl: gross - fees, durationMs: last.time - pos.openedTime });
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  return {
    symbol: cfg.symbol, timeframe: cfg.timeframe, bars: candles.length,
    startCapital, endCapital: capital, netPnl: capital - startCapital,
    returnPct: ((capital - startCapital) / startCapital) * 100,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? (capital - startCapital) / trades.length : 0,
    maxDrawdownPct: maxDdPct, maxDrawdownUsd: maxDdUsd, totalFees,
    tradeList: trades,
  };
}

async function main() {
  const symbols = arg('all') ? CONFIG.symbols : [arg('symbol', 'BTC/USDT:USDT')];
  const timeframe = arg('timeframe', '5m');
  const days = Number(arg('days', 30));
  const cfg = {
    symbol: symbols[0], timeframe,
    lookbackCandles: Number(arg('lookback', CONFIG.lookbackCandles)),
    rsiPeriod: Number(arg('rsiPeriod', CONFIG.rsiPeriod)),
    minMovePct: Number(arg('minMove', CONFIG.minMovePct)),
    rsiLongMin: Number(arg('rsiLong', CONFIG.rsiLongMin)),
    rsiShortMax: Number(arg('rsiShort', CONFIG.rsiShortMax)),
    takeProfitPct: Number(arg('tp', CONFIG.takeProfitPct)),
    stopLossPct: Number(arg('sl', CONFIG.stopLossPct)),
    riskPct: Number(arg('risk', CONFIG.riskPct)),
    leverage: Number(arg('levier', CONFIG.leverage)),
    feePct: Number(arg('fee', CONFIG.feePct)),
    cooldownMs: Number(arg('cooldown', CONFIG.cooldownMs)),
    initialCapital: Number(arg('capital', CONFIG.initialCapital)),
    emaFilter: Number(arg('emaFilter', 50)),
    exitMode: arg('mode', 'close'),
  };

  const ex = new ccxt.binance({ enableRateLimit: true });
  if (ex.options) ex.options.defaultType = 'swap';
  console.log(`⏳ Backtest ${days} j | timeframe=${timeframe} | mode sortie=${cfg.exitMode} | filtre EMA${cfg.emaFilter} ${cfg.emaFilter ? '' : '(désactivé)'}`);
  console.log(`   TP=+${cfg.takeProfitPct}% SL=-${cfg.stopLossPct}% var±${cfg.minMovePct}% RSI>${cfg.rsiLongMin}/<${cfg.rsiShortMax} risque=${cfg.riskPct}% levier=${cfg.leverage}x frais=${cfg.feePct}%/jambe\n`);

  const results = [];
  for (const sym of symbols) {
    cfg.symbol = sym;
    const candles = await fetchHistory(ex, sym, timeframe, days);
    if (candles.length < cfg.lookbackCandles + cfg.emaFilter + 5) {
      console.warn(`⚠️ ${sym}: trop peu de données (${candles.length} bougies)`);
      continue;
    }
    const r = runBacktest(candles, cfg);
    results.push(r);
    const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
    console.log(`📊 ${sym} (${r.bars} bougies closes)`);
    console.log(`   Capital   : ${fmt(r.startCapital)}$ → ${fmt(r.endCapital)}$  (${r.netPnl >= 0 ? '+' : ''}${fmt(r.netPnl)}$, ${r.returnPct >= 0 ? '+' : ''}${fmt(r.returnPct)}%)`);
    console.log(`   Trades    : ${r.trades} (gagnés ${r.wins}, perdus ${r.losses}) — winrate ${fmt(r.winRate, 1)}%`);
    console.log(`   Profit factor : ${fmt(r.profitFactor)}  Expectancy/trade : ${fmt(r.expectancy)}$`);
    console.log(`   Max drawdown  : ${fmt(r.maxDrawdownPct)}% (${fmt(r.maxDrawdownUsd)}$)  Frais cumulés : ${fmt(r.totalFees)}$`);
    const byReason = {};
    for (const t of r.tradeList) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
    console.log(`   Sorties       : ${Object.entries(byReason).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    console.log('');
  }

  if (results.length > 1) {
    const tot = results.reduce((a, r) => ({ trades: a.trades + r.trades, wins: a.wins + r.wins, pnl: a.pnl + r.netPnl }), { trades: 0, wins: 0, pnl: 0 });
    console.log(`🧮 TOTAL : ${tot.trades} trades, winrate ${((tot.wins / Math.max(1, tot.trades)) * 100).toFixed(1)}%, PnL cumulé ${tot.pnl >= 0 ? '+' : ''}${tot.pnl.toFixed(2)}$`);
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
