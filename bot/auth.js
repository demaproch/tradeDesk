// ============================================================
// Authentification du dashboard momBot (session httpOnly + CSRF)
// - Pas de dépendance externe : crypto natif (scrypt, HMAC, randomUUID)
// - Mot de passe : MOMBOT_PASSWORD (env) ou auth.json (sinon généré et
//   affiché dans la console au premier lancement)
// - Verrouillage après 10 tentatives échouées (5 min) + rate-limit login
// - Cookie session signé (HMAC-SHA256), SameSite=Lax, HttpOnly
// - Double-submit CSRF pour toutes les routes /api/* mutantes
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours
const COOKIE_NAME = 'mombot_session';
const MAX_FAILED = 10;          // tentatives avant verrouillage temporaire
const LOCKOUT_MS = 5 * 60 * 1000;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function timingEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

class AuthManager {
  constructor(file, passwordFromEnv) {
    this.file = file;
    this.secret = crypto.randomBytes(32);       // propre à chaque exécution
    this.sessions = new Map();                  // sid -> { csrf, exp }
    this.failed = 0;
    this.lockedUntil = 0;
    this.generated = false;

    if (passwordFromEnv) {
      const salt = b64u(crypto.randomBytes(16));
      this.store = { kdf: 'scrypt', salt, hash: this._hash(passwordFromEnv, salt) };
      this._save();
      return;
    }
    if (this._load()) return;

    // Premier lancement sans configuration : mot de passe fort généré,
    // affiché UNE SEULE fois dans la console, persisté haché dans auth.json.
    const pwd = crypto.randomBytes(9).toString('base64url');
    const salt = b64u(crypto.randomBytes(16));
    this.store = { kdf: 'scrypt', salt, hash: this._hash(pwd, salt) };
    this.generated = true;
    this.firstPassword = pwd;
    this._save();
  }

  _hash(pw, saltB64) {
    return b64u(crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64url'), 32, { N: 16384, r: 8, p: 1 }));
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.kdf === 'scrypt' && raw.salt && raw.hash) { this.store = raw; return true; }
    } catch { /* absent */ }
    return false;
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.store, null, 2), { mode: 0o600 });
      try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
    } catch (e) { console.warn('⚠️ auth.json inaccessible en écriture :', e.message); }
  }

  verifyPassword(pw) {
    return timingEq(this._hash(pw, this.store.salt), this.store.hash);
  }

  get hasPasswordFile() { return !this.generated; }

  // ---------- sessions ----------

  createSession(res) {
    const sid = crypto.randomUUID();
    const csrf = b64u(crypto.randomBytes(24));
    const exp = Date.now() + SESSION_TTL_MS;
    this.sessions.set(sid, { csrf, exp });
    const payload = `${sid}.${exp}`;
    const sig = b64u(crypto.createHmac('sha256', this.secret).update(payload).digest());
    const cookie = `${payload}.${sig}`;
    const secure = ''; // localhost ; placer __Secure- si servi en HTTPS
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    return csrf;
  }

  parseCookie(req) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE_NAME) return v.join('=');
    }
    return null;
  }

  /** Vérifie signature + expiration + existence côté serveur. */
  getSession(req) {
    const raw = this.parseCookie(req);
    if (!raw) return null;
    const parts = String(raw).split('.');
    if (parts.length !== 3) return null;
    const [sid, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!(exp > Date.now())) { this.sessions.delete(sid); return null; }
    const expect = b64u(crypto.createHmac('sha256', this.secret).update(`${sid}.${expStr}`).digest());
    if (!timingEq(sig, expect)) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    return { sid, ...s };
  }

  destroySession(req, res) {
    const raw = this.parseCookie(req);
    if (raw) this.sessions.delete(String(raw).split('.')[0]);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  checkCsrf(session, req) {
    const hdr = req.headers['x-csrf-token'];
    return !!hdr && !!session && timingEq(hdr, session.csrf);
  }

  // ---------- Express middleware ----------

  /** Protège tout ce qui n'est pas la page de login ni les routes d'authentification. */
  requireAuth(publicDir) {
    return (req, res, next) => {
      const p = req.path;
      if (p === '/login' || p === '/login.html') return res.sendFile(path.join(publicDir, 'login.html'));
      // favicon : autorisé sans session (sinon 302 → échec du fetch)
      if (p === '/favicon.ico' || p === '/favicon.svg') return next();
      if (p === '/api/login' || p === '/api/logout' || p === '/api/csrf') return next();
      const sess = this.getSession(req);
      if (!sess) {
        if (p.startsWith('/api/') || p.startsWith('/ws')) return res.status(401).json({ error: 'Non authentifié.' });
        return res.redirect('/login');
      }
      req.session = sess;
      next();
    };
  }

  /** Route GET /api/me : le dashboard vérifie la session et récupère son jeton CSRF. */
  handleMe(req, res) {
    const sess = this.getSession(req);
    if (!sess) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, csrf: sess.csrf });
  }

  /** Toute méthode mutante sur /api/* exige le jeton CSRF (sauf login/logout). */
  requireCsrf(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.path === '/api/login' || req.path === '/api/logout') return next();
    if (this.checkCsrf(req.session, req)) return next();
    res.status(403).json({ error: 'Jeton CSRF manquant ou invalide.' });
  }

  /** WS : le handshake doit porter un cookie de session valide. */
  wsAuthenticate(wsReq) {
    const fake = { headers: { cookie: wsReq.headers.cookie || '' } };
    return !!this.getSession(fake);
  }

  handleLogin(req, res) {
    if (this.lockedUntil > Date.now()) {
      const s = Math.ceil((this.lockedUntil - Date.now()) / 1000);
      return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${s} s.` });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string' || !this.verifyPassword(password)) {
      this.failed++;
      if (this.failed >= MAX_FAILED) {
        this.lockedUntil = Date.now() + LOCKOUT_MS;
        this.failed = 0;
        return res.status(429).json({ error: 'Compte temporairement verrouillé (10 échecs, 5 min).' });
      }
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    this.failed = 0;
    const csrf = this.createSession(res);
    res.json({ ok: true, csrf });
  }
}

module.exports = { AuthManager, COOKIE_NAME };
