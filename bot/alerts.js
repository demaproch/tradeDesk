// ============================================================
// Notifications push (Telegram + webhook générique)
// - configurables depuis le dashboard, testables en un clic
// - journalise chaque envoi (succès/échec) dans le log du bot
// - anti-spam : même alerte non renvoyée deux fois < 60 s
// ============================================================

class AlertManager {
  constructor() {
    this.cfg = { telegramToken: '', telegramChatId: '', webhookUrl: '' };
    this._lastSent = new Map(); // key -> timestamp (anti-doublon)
    this.lastResult = null;     // dernier résultat de test (pour l'UI)
  }

  configure({ telegramToken, telegramChatId, webhookUrl } = {}) {
    if (typeof telegramToken === 'string') this.cfg.telegramToken = telegramToken.trim();
    if (typeof telegramChatId === 'string') this.cfg.telegramChatId = telegramChatId.trim();
    if (typeof webhookUrl === 'string') this.cfg.webhookUrl = webhookUrl.trim();
  }

  /** Ne renvoie que l'état (sans secrets) pour le dashboard. */
  status() {
    return {
      telegramConfigured: !!(this.cfg.telegramToken && this.cfg.telegramChatId),
      webhookConfigured: !!this.cfg.webhookUrl,
      lastResult: this.lastResult,
    };
  }

  get enabled() {
    return this.status().telegramConfigured || this.status().webhookConfigured;
  }

  /** Envoi immédiat sans anti-doublon (bouton « Tester »). */
  async sendNow(title, text) {
    return this._dispatch(`${title}\n${text}`, `test:${Date.now()}`);
  }

  /**
   * Envoi avec anti-spam : si `key` a déjà été envoyée il y a moins de
   * `throttleMs`, la notification est ignorée silencieusement.
   */
  async notify(key, title, text, throttleMs = 60_000) {
    const now = Date.now();
    const last = this._lastSent.get(key) || 0;
    if (now - last < throttleMs) return { ok: true, skipped: true };
    this._lastSent.set(key, now);
    return this._dispatch(`${title}\n${text}`, key);
  }

  async _dispatch(message, key) {
    const results = [];
    try {
      if (this.cfg.telegramToken && this.cfg.telegramChatId) {
        results.push(await this._sendTelegram(message));
      }
      if (this.cfg.webhookUrl) {
        results.push(await this._sendWebhook(message));
      }
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
    const out = {
      sentAt: Date.now(),
      channels: results.length ? results : [{ ok: false, error: 'Aucun canal configuré' }],
    };
    out.ok = out.channels.some((r) => r.ok);
    this.lastResult = { ok: out.ok, at: out.sentAt, summary: out.channels.map((r) => (r.ok ? 'ok' : `échec: ${r.error}`)).join(', ') };
    if (!out.ok) this._lastSent.delete(key); // permettra de réessayer
    return out;
  }

  async _sendTelegram(message) {
    const url = `https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: message }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(`Telegram HTTP ${res.status} ${j.description || ''}`.trim());
    return { channel: 'telegram', ok: true };
  }

  async _sendWebhook(message) {
    const res = await fetch(this.cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'momBot', text: message, ts: Date.now() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    return { channel: 'webhook', ok: true };
  }
}

module.exports = { AlertManager };
