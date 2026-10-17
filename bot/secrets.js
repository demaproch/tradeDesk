// ============================================================
// Coffre à secrets momBot : clé API + secret API de l'exchange
// - Chiffrés AES-256-GCM avec une clé dérivée (scrypt) d'un master
//   password, lui-même dérivé d'un sel aléatoire stocké en clair.
// - Le master password n'est JAMAIS écrit sur disque ; il vit en RAM
//   pendant la session (fourni via MOMBOT_MASTER env ou le dashboard).
// - Sans master password connu, le fichier secrets.json est illisible :
//   changer de mot de passe = régénérer les clés API côté exchange.
// - L'accès au secret déchiffré est cloisonné : seule la fonction
//   withApiKey() y a accès (callback), il ne transite jamais dans
//   /api/state ni dans le journal.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');

const KDF = { N: 16384, r: 8, p: 1 };

function deriveKey(master, saltBuf) {
  return Buffer.from(crypto.scryptSync(String(master), saltBuf, 32, KDF));
}

function encryptString(plain, master, saltBuf) {
  const key = deriveKey(master, saltBuf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    v: 1,
    salt: saltBuf.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: enc.toString('base64url'),
  };
}

function decryptString(blob, master) {
  if (!blob || blob.v !== 1) throw new Error('Format de secret non reconnu.');
  const key = deriveKey(master, Buffer.from(blob.salt, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64url')), decipher.final()]).toString('utf8');
}

class SecretStore {
  /** @param {string} file chemin secrets.json */
  constructor(file) {
    this.file = file;
    this.keyId = null;          // 8 premiers hex chars du hash public (pour affichage)
    this.master = null;         // présent uniquement après unlock réussi
    this._blobs = null;         // { apiKey, apiSecret } chiffrés
    this.reload();
  }

  reload() {
    this.master = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.apiKey && raw.apiSecret) {
        this._blobs = raw;
        this.keyId = String(raw.keyId || '').slice(0, 8) || null;
      } else {
        this._blobs = null;
      }
    } catch { this._blobs = null; }
  }

  get configured() { return !!this._blobs; }
  get unlocked() { return !!(this.master && this._blobs); }

  /** Enregistre (chiffre) une nouvelle paire de clés. */
  set(apiKey, apiSecret, master) {
    const salt = crypto.randomBytes(16);
    this._blobs = {
      apiKey: encryptString(apiKey, master, salt),
      apiSecret: encryptString(apiSecret, master, crypto.randomBytes(16)),
      keyId: crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16),
    };
    this.keyId = this._blobs.keyId.slice(0, 8);
    this.master = String(master);
    fs.writeFileSync(this.file, JSON.stringify(this._blobs, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
  }

  /** Déblocage en mémoire ; renvoie false si mot de passe incorrect. */
  unlock(master) {
    if (!this._blobs) return false;
    try {
      decryptString(this._blobs.apiKey, master);
      decryptString(this._blobs.apiSecret, master);
      this.master = String(master);
      return true;
    } catch {
      return false;
    }
  }

  lock() { this.master = null; }

  erase() {
    this.master = null;
    this._blobs = null;
    this.keyId = null;
    try { fs.unlinkSync(this.file); } catch { /* déjà absent */ }
  }

  /** Cloisonnement : seul ce callback voit le secret en clair. */
  withApiKey(cb) {
    if (!this.unlocked) throw new Error('Coffre verrouillé : saisissez le mot de passe maître.');
    const apiKey = decryptString(this._blobs.apiKey, this.master);
    const apiSecret = decryptString(this._blobs.apiSecret, this.master);
    return cb({ apiKey, apiSecret });
  }

  /** État public (jamais de matière sensible). */
  status() {
    return {
      configured: this.configured,
      unlocked: this.unlocked,
      keyId: this.keyId ? `${this.keyId}…` : null,
    };
  }
}

module.exports = { SecretStore, encryptString, decryptString };
