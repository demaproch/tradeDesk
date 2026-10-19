// ============================================================
// Persistance du carnet (engine) — survit aux crashs/redémarrages
// - écriture atomique (tmp + rename), debounce 2 s, max 1/s en forcé
// - state.json : capital, positions ouvertes, trades fermés, equity,
//   cooldowns, horodatage d'écriture
// - un fichier .bak est conservé ; si state.json est corrompu (coupure
//   de courant en pleine écriture), on retombe sur le backup.
// ============================================================

const fs = require('fs');
const path = require('path');

class StateStore {
  constructor(file) {
    this.file = file;
    this.bakFile = file + '.bak';
    this._timer = null;
    this._lastWrite = 0;
  }

  /** Charge l'état persisté (state.json, sinon .bak). Renvoie null si absent. */
  load() {
    for (const f of [this.file, this.bakFile]) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (raw && typeof raw.capital === 'number') return raw;
      } catch { /* fichier absent ou corrompu : on tente le suivant */ }
    }
    return null;
  }

  /** Sérialise le moteur au format persisté. */
  serialize(engine) {
    return {
      savedAt: Date.now(),
      capital: engine.capital,
      startEquity: engine.startEquity,
      positions: [...engine.positions.values()],
      closedTrades: engine.closedTrades.slice(-500),
      lastTradeTime: Object.fromEntries(engine.lastTradeTime),
      equityHistory: engine.equityHistory.slice(-2000),
    };
  }

  /** Restaure un état dans le moteur (positions, trades, capital…). */
  restore(engine, state) {
    engine.capital = state.capital;
    engine.startEquity = state.startEquity ?? state.capital;
    engine.positions = new Map((state.positions || []).map((p) => [p.symbol, p]));
    engine.closedTrades = state.closedTrades || [];
    engine.lastTradeTime = new Map(Object.entries(state.lastTradeTime || {}));
    engine.equityHistory = state.equityHistory || [];
  }

  /** Écrit immédiatement (utilisé après trade, arrêt propre, etc.). */
  saveNow(engine) {
    this._write(this.serialize(engine));
  }

  /** Écrit différée (debounce 2 s) pour les points d'équité fréquents. */
  scheduleSave(engine) {
    if (this._timer) return; // une écriture est déjà programmée
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow(engine);
    }, 2000);
    if (this._timer.unref) this._timer.unref();
  }

  _write(data) {
    const now = Date.now();
    if (now - this._lastWrite < 1000) return; // anti-bourrage
    this._lastWrite = now;
    try {
      const json = JSON.stringify(data, null, 1);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json);
      try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.bakFile); } catch { /* bak optionnel */ }
      fs.renameSync(tmp, this.file); // atomic sur la plupart des FS
    } catch (e) {
      console.warn('⚠️ Sauvegarde state.json impossible :', e.message);
    }
  }
}

module.exports = { StateStore };
