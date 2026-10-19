# momBot 🤖

Bot de trading **momentum + RSI** sur les futures perpétuels Binance, avec dashboard temps réel protégé par authentification, paramètres 100 % éditables depuis l'interface, et **double mode : paper trading (défaut) ou trading réel** via clés API chiffrées.

> En une phrase : le bot détecte un mouvement de prix significatif sur les 10 dernières bougies **clôturées**, le confirme avec le RSI, entre dans le sens du mouvement avec 8 % de risque et un levier 10x, puis sort automatiquement à **+2,8 %** (TP) ou **−1,0 %** (SL).

### 📚 Documentation complète

| Document | Contenu |
|---|---|
| **[STRATEGIE.md](STRATEGIE.md)** | La stratégie et le fonctionnement du bot **de A à Z** : cycle de vie d'un tick, formules exactes (RSI Wilder, variation, sizing, TP/SL, frais, équité), money management, garde-fous, pièges corrigés, rôle de chaque fichier, annexe avec exemple de trade chiffré pas à pas. Indépendant du code — suffisant pour reconstruire le bot dans un autre langage. |
| **[PROMPT_SKILL.md](PROMPT_SKILL.md)** | Prompt autonome prêt à coller dans une autre IA pour reproduire momBot : version complète (bot + dashboard + sécurité) et version minimale (cœur stratégie + tests), avec contraintes de qualité non négociables et conseils d'utilisation. |
| README.md (ci-dessous) | Installation, démarrage rapide, sécurité, modes paper/réel, API, déploiement. |

---

## Sommaire

0. [Documentation complète](#-documentation-complète) → STRATEGIE.md (A→Z) et PROMPT_SKILL.md (prompt de reproduction)
1. [Démarrage rapide](#démarrage-rapide)
2. [La stratégie de A à Z](#la-stratégie-de-à-z)
   - [Paramètres généraux](#1-paramètres-généraux)
   - [Détection du signal](#2-détection-du-signal-entrée-en-position)
   - [Dimensionnement de la position](#3-dimensionnement-de-la-position-money-management)
   - [Gestion des sorties (TP / SL)](#4-gestion-des-sorties-tp--sl)
   - [Règles supplémentaires](#5-règles-supplémentaires)
   - [Pièges corrigés (pourquoi ces choix)](#6-pièges-corrigés--pourquoi-ces-choix)
3. [Sécurité : authentification du dashboard](#sécurité--authentification-du-dashboard)
4. [Paper trading vs trading réel (clés API)](#paper-trading-vs-trading-réel-clés-api)
5. [Rôle de chaque fichier](#rôle-de-chaque-fichier)
6. [Architecture & flux de données](#architecture--flux-de-données)
7. [API du dashboard](#api-du-dashboard)
8. [Déploiement & checklist production](#déploiement--checklist-production)
9. [Tests](#tests)

---

## Démarrage rapide

```bash
cd bot
npm install                       # ccxt, express, ws — OBLIGATOIRE au 1er lancement
                                  # (sinon : "Error: Cannot find module 'express'")

MOMBOT_PASSWORD="MonMotDePasseSolide" node bot.js      # prix réels Binance + dashboard sécurisé
node bot.js                       # idem, mais mot de passe généré affiché en console (voir §Sécurité)
node bot.js --demo                # données simulées — fonctionne sans internet

# tableau de bord : http://localhost:3000 → page de login
node test_strategy.js             # 54 tests de la stratégie
```

Par défaut le bot démarre en **paper trading** (capital virtuel de 1000 $) : aucune clé API n'est nécessaire, aucun ordre réel n'est envoyé. Il utilise uniquement les données publiques de l'exchange via [ccxt](https://github.com/ccxt/ccxt). Le passage en trading réel est optionnel et décrit plus bas.

---

## La stratégie de A à Z

### 1. Paramètres généraux

| Élément | Valeur | Où le changer |
|---|---|---|
| Timeframe | `5m` par défaut (1m, 3m, 5m, 15m, 30m, 1h, 4h) | Dashboard → sélecteur segmenté |
| Paires tradées | BTC, ETH, SOL, AVAX, SUI /USDT par défaut ; univers de 15 perps cochables + paires exotiques libres | Dashboard → Paramètres → 🪙 Marché & paires |
| Marché | Perpetuals USDT (LONG **et** SHORT) | `config.js` (`marketType`) |
| Capital de départ | 1000 $ (simulé) | Dashboard → Paramètres → 💰 (`initialCapital`, réinitialise le carnet paper) ou `config.js` |
| Positions | 1 maximum par symbole, simultanément | règle dure du moteur |
| Cadence d'analyse | toutes les ~50 s | Dashboard → Paramètres (`cycleMs`) |

### 2. Détection du signal (entrée en position)

À chaque cycle, pour chaque paire :

1. Le bot récupère les **60 dernières bougies** du timeframe choisi (`candlesLimit`).
2. **La dernière bougie (en cours de formation) est écartée** — tout est calculé sur des clôtures dures de bougies closes (`candles.js → closedCandles()`).
3. Deux indicateurs sont calculés (`indicators.js`) :
   - **Variation de prix** sur les `lookbackCandles` (10) dernières clôtures :

     ```
     variation = (close[n] − close[n−10]) / close[n−10] × 100
     ```
   - **RSI 6** (lissage de Wilder) sur la série de clôtures.

4. Conditions d'entrée (**stratégie momentum** : on suit le mouvement déjà en cours, le RSI doit confirmer un minimum de force) :

| Direction | Condition de variation | Condition RSI | Résultat |
|---|---|---|---|
| **LONG** | variation > **+0,55 %** | RSI > **52** | Ouvre un Long |
| **SHORT** | variation < **−0,55 %** | RSI < **48** | Ouvre un Short |

5. L'entrée n'est tentée **qu'une seule fois par nouvelle bougie clôturée** (détection via le timestamp de la dernière bougie). Si le signal était vrai au moment de la clôture et que le bot a raté la fenêtre, il n'entre pas retroactivement.

### 3. Dimensionnement de la position (money management)

Quand un signal est validé :

```
marge engagée   = capital courant × riskPct%        (8 %)
levier          = leverage, plafonné à maxLeverage   (10x, max 12x)
exposition      = marge × levier                     (~80 % du capital)
quantité (qty)  = exposition / prix d'entrée
```

Exemple : capital = 1000 $ → marge = 80 $ → exposition ≈ 800 $.

Le **risque réel** d'un trade n'est pas la marge mais le Stop Loss : avec SL = −1 % du prix et levier 10x, une perte = 1 % × 10 = **10 % de la marge**, soit ~0,8 % du capital (+ frais).

### 4. Gestion des sorties (TP / SL)

Dès l'ouverture, deux niveaux de prix fixes sont calculés et stockés dans la position :

```
LONG  : TP = entrée × (1 + 2,8 %)   SL = entrée × (1 − 1,0 %)
SHORT : TP = entrée × (1 − 2,8 %)   SL = entrée × (1 + 1,0 %)
```

À chaque cycle (et à chaque nouvelle bougie close), `engine.checkExit()` compare high/low de la bougie aux niveaux :

- Franchissement du TP → fermeture **au prix exact du TP** (comme un ordre conditionnel réel, pas à la clôture qui a pu slippér).
- Franchissement du SL → fermeture **au prix exact du SL**.
- Les deux touchés sur la même bougie → **priorité au SL** (hypothèse conservatrice).
- Pas de trailing stop : TP/SL fixes.

**Frais** : à la fermeture, le PnL net soustrait les frais taker estimés sur les deux jambes (entrée + sortie), `feePct` par jambe (0,04 % par défaut, ajustable dans le dashboard). Le log affiche `PnL=-8.64$ (brut -8.00$, frais -0.64$)`.

### 5. Règles supplémentaires

- **Cooldown** : minimum **5 minutes** entre deux ouvertures sur le même symbole (`cooldownMs`).
- **Une position max par symbole** : pas de nouvelle entrée tant que la position est ouverte.
- **Équité temps réel** : `equity = capital réalisé + Σ(marge + PnL latent de chaque position ouverte)` — les mises initiales ne sont jamais comptées deux fois ; le graphique d'équité est reconstruit quand on change de timeframe.
- Fermetures manuelles possibles depuis le dashboard : bouton « Fermer » par position (`POST /api/close/:symbol`) ou « Fermer tout ».

### 6. Pièges corrigés — pourquoi ces choix

Ces règles existent parce que l'implémentation naïve de la stratégie perdait systématiquement :

| Piège | Symptôme | Correctif |
|---|---|---|
| Signal calculé sur la **bougie en cours de formation** | entrées au milieu de spikes artificiels (RSI 90 sur un LONG…), re-entrées 60× par bougie | `closedCandles()` écarte toujours la bougie non close ; 1 tentative d'entrée par bougie clôturée |
| **Timeframe 3m ignoré** (Binance ne sert pas de klines 3m) | le bot retombait silencieusement sur 1m | agrégation client 1m→3m (`candles.js → aggregate()`) avec suppression du bucket en cours |
| TP/SL déclenchés **à la clôture** de la bougie | fermetures slippées bien au-delà du niveau | détection par franchissement high/low, exécution au **prix exact** du niveau |
| **Frais ignorés** | un SL à −10 % de marge devenait −10,8 % avec les fees ; ruine lente malgré un bon winrate | PnL net = brut − frais des deux jambes |

---

## Sécurité : authentification du dashboard

Le dashboard est **protégé par login** — aucune route `/api/*` n'est accessible sans session valide.

### Mot de passe (aucun mot de passe par défaut)

Deux possibilités au démarrage :

1. **Tu le définis toi-même** via la variable d'environnement :
   ```bash
   MOMBOT_PASSWORD="MonMotDePasseSolide" node bot.js
   ```
2. **Sinon, un mot de passe fort est généré automatiquement** au tout premier lancement et **affiché une seule fois dans la console** :
   ```
   🔑 Mot de passe GÉNÉRÉ pour ce premier lancement : Ab3xY…
   ```
   Il est ensuite stocké **haché (scrypt)** dans `auth.json`. Oublié ? Supprime `auth.json` et relance : un nouveau mot de passe est généré.

### Mécanismes (`auth.js`)

- Hachage **scrypt** (N=16384), comparaison à temps constant ; zéro dépendance externe.
- **Session cookie HttpOnly, SameSite=Lax, signature HMAC-SHA256**, TTL 7 jours.
- **Double-submit CSRF** : jeton renvoyé par `/api/me`, exigé en en-tête `X-CSRF-Token` sur toutes les routes mutantes.
- **Anti-brute-force** : verrouillage 5 min après 10 échecs + rate-limit sur `/api/login`.
- WebSocket : les clients non connectés sont éjectés (code 4401).
- Page de login dédiée : `/login` (`public/login.html`).

---

## Paper trading vs trading réel (clés API)

### Mode paper (défaut, recommandé)

`tradingMode = 'paper'` : signaux calculés sur prix réels Binance, mais les ordres sont simulés par `engine.js` avec capital virtuel. Aucun risque financier. Levier plafonné à **12×**.

### Passer en trading réel

1. **Crée une clé API sur ton exchange** (Binance → API Management) avec les droits **lecture + trading uniquement — JAMAIS « withdraw/retrait »**. Idéalement restreins-la à l'IP du serveur.
2. Dashboard → panneau **« 🔐 Clés API & sécurité »** (repliable ; replié, il n'affiche strictement rien des champs) : saisis **Clé API + Secret + un mot de passe maître** (min. 8 caractères, avec confirmation) puis **💾 Enregistrer**. Les clés sont validées contre l'exchange avant enregistrement.
3. Bouton **« Tester la connexion »** → affiche le solde (confirme que les clés marchent).
4. Clique **« Activer le trading RÉEL »** (double confirmation). La pastille du header passe de 🧪 PAPER à 🔴 LIVE.
5. Pour revenir en simulation : **« Revenir en paper »** ou **« Verrouiller le coffre »** (retour paper automatique).

### Ce que fait le bot en mode réel (`LiveBroker` dans `bot.js`)

- Ordres **MARKET** d'entrée/sortie via ccxt authentifié, levé de marge posé avant chaque entrée (`setDefaultLeverage`), sortie en `reduceOnly`, quantité arrondie au pas de lot (`amountToPrecision`).
- TP/SL toujours surveillés par le bot (polling cycle) et déclenchés par ordre marché quand le niveau est franchi. ⚠️ Tant que le bot tourne, c'est fiable ; si le process meurt, **il n'y a pas d'OCO côté exchange** — à considérer avant de trader de vraies sommes.
- Échec d'ordre → position non ouverte (ou conservée), message explicite dans le journal ; le moteur ne diverge jamais silencieusement de l'exchange.

### Garde-fous mode réel (`params.js`)

| Garde-fou | Paper | Réel |
|---|---|---|
| Levier max | 12× | **5×** (`MAX_LEVERAGE_REAL`) |
| Risque max/trade | 100 % | **25 %** |
| Passage refusé si | — | coffre verrouillé / clés absentes / connexion exchange KO |

### Chiffrement du coffre (`secrets.js`)

- Clé + secret chiffrés **AES-256-GCM**, clé dérivée (scrypt) du **mot de passe maître**.
- Le master password **n'est jamais écrit sur disque** : il vit en RAM après déverrouillage (ou via env `MOMBOT_MASTER`). Sans lui, `secrets.json` est illisible → **non récupérable** (il faudra régénérer les clés côté exchange).
- Cloisonnement : seul `withApiKey(callback)` déchiffre ; le secret **ne transite jamais** dans `/api/state`, le WebSocket ni les logs (seul un `keyId` tronqué est affiché).

---

## Rôle de chaque fichier

```
bot/
├── bot.js                 ← point d'entrée : boucle + serveur web + LiveBroker (ordres réels)
├── engine.js              ← cœur métier : moteur de positions (pur, testable, hooks onOpen/onClose)
├── config.js              ← tous les paramètres par défaut de la stratégie
├── params.js              ← schéma + validation des paramètres éditables (+ garde-fous paper/réel)
├── indicators.js          ← calculs techniques purs (RSI, variation)
├── candles.js             ← manipulation OHLCV (bougies closes, agrégation 1m→3m)
├── auth.js                ← authentification dashboard (scrypt, sessions HMAC, CSRF, anti-brute-force)
├── secrets.js             ← coffre AES-256-GCM des clés API (dérivation scrypt du master)
├── public/
│   ├── index.html         ← dashboard complet (HTML/CSS/JS, zéro framework)
│   └── login.html         ← page de connexion
├── test_strategy.js       ← 54 tests unitaires de la stratégie
├── README.md              ← installation, sécurité, modes paper/réel, API, déploiement
├── STRATEGIE.md           ← documentation complète de la stratégie et du fonctionnement (A→Z)
├── PROMPT_SKILL.md        ← prompt autonome pour reproduire le bot avec une autre IA
├── package.json           ← dépendances : ccxt, express, ws
├── .gitignore             ← node_modules/, *.log, auth.json, secrets.json, overrides, .env
└── fichiers générés (jamais commités) :
    ├── params.overrides.json ← patch de paramètres persisté depuis le dashboard
    ├── auth.json             ← hash scrypt du mot de passe dashboard (0600)
    ├── secrets.json          ← clés API chiffrées (0600)
    └── server.log            ← journal d'exécution
```

### `bot.js` — orchestrateur + trading réel
- Boucle principale : toutes les `cycleMs`, appelle l'exchange via **ccxt** (`fetchOHLCV`), nettoie/agrège les bougies (`candles.js`), calcule les signaux (`indicators.js`), pilote le moteur (`engine.js`).
- Mode `--demo` : générateur de prix synthétiques (marche sans internet ni compte).
- Gère les erreurs réseau (timeouts, DNS) sans crasher : log WARN et retry au cycle suivant.
- Classe **`LiveBroker`** : branchée sur les hooks `onOpen`/`onClose` du moteur quand `tradingMode='real'` — orders MARKET authentifiés via le coffre (`SecretStore.withApiKey()`), levier posé avant entrée, sortie `reduceOnly`, arrondi au pas de lot. Reconnexion automatique au mode réel au démarrage si le coffre est débloqué.
- Serveur **Express** : page de login + dashboard + API REST protégées par session/CSRF ; **WebSocket** (`ws`) : push du snapshot d'état à chaque cycle vers les clients connectés (éjection 4401 sinon).
- Applique les changements de paramètres à chaud (redémarre le timer si `cycleMs` change, recalcule TP/SL des positions ouvertes, reset du carnet paper si `initialCapital` change…).

### `engine.js` — moteur de positions
Logique purement déterministe, testable sans réseau (le même code sert au paper et au réel) :
- `openPosition(symbol, side, price, meta)` : vérifie cooldown / position existante, calcule marge (`riskPct`), levier plafonné (`maxLeverage` selon le mode), qty, prix TP/SL exacts. Hooks async `onOpen` (mode réel) : si l'ordre échoue, la position n'est **pas** ouverte.
- `checkExit(pos, candle)` : retourne `{kind: 'TP'|'SL', price}` au prix exact du niveau (SL prioritaire), sinon `null`.
- `closePosition(symbol, price, reason)` : PnL brut, frais des deux jambes, mise à jour du capital, historique du trade (`openedAt`, `closedAt`, `durationMs`), log détaillé (heure d'entrée + durée). Hook `onClose` pour l'ordre réel.
- Suit `capital`, `startEquity` (référence fixe du graphique d'équité), `positions` (Map), `closedTrades`, `lastTradeTime`, `equityHistory` (avec PnL latent), `logs` (bornés à 300).
- `resetBook(newCapital)` : réinitialise le carnet paper (utilisé quand on change le capital simulé ou repart de zéro).
- `fmtDuration()` : durées lisibles (« 3 min 12 s », « 1 h 05 min »).

### `config.js` — paramètres par défaut
Un seul objet `CONFIG` centralisant : exchange, symboles, timeframe, cadence, seuils du signal (variation, RSI), money management (capital, risque, levier), sorties (TP/SL), cooldown, frais, `tradingMode` ('paper' par défaut), port du dashboard. Modifier ici = changer la stratégie sans toucher au code.

### `params.js` — validation des paramètres éditables
- `PARAM_SCHEMA` : pour chaque paramètre modifiable via l'UI → type, bornes min/max, pas, unité, groupe d'affichage (`mode` / `signal` / `money` / `exits` / `execution` / paires), niveau (`core` visible / `advanced` replié), texte d'aide. C'est ce schéma qui **génère automatiquement le formulaire** du dashboard (y compris les cases à cocher des paires).
- `checkCoherence()` : garde-fous croisés (RSI short < RSI long ; cycle ≥ 20 s en 1m ; **levier ≤ 5× et risque ≤ 25 % en mode réel**…).
- Normalisation/validation des symboles (`normalizeSymbols`, `perpSymbol`, `validateSymbolOnExchange` : une paire inconnue de l'exchange est refusée avant application).
- Application atomique : un patch invalide est **entièrement rejeté** avec message explicite (aucune mutation partielle), puis persisté dans `params.overrides.json`.

### `indicators.js` — indicateurs techniques (pur JS, zéro dépendance)
- `rsi(closes, period)` : RSI à **lissage de Wilder** (celui de TradingView/Binance), renvoie `null` si données insuffisantes.
- `priceChangePct(closes, lookback)` : variation en % entre la dernière clôture et celle d'il y a `lookback` bougies.

### `candles.js` — manipulation de bougies OHLCV
- `closedCandles(candles)` : retire la dernière bougie (toujours en cours de formation dans `fetchOHLCV`) — **garantie anti-biais**.
- `aggregate(candles, fromMs, toMs)` : construit des timeframe inexistants côté exchange (le 3m à partir du 1m), combine open/high/low/close, et supprime le dernier bucket non terminé.
- `TF_MS` : table de conversion timeframe → millisecondes.

### `auth.js` — authentification du dashboard
- Zéro dépendance externe : `crypto` natif (scrypt, HMAC-SHA256, randomUUID).
- Mot de passe : env `MOMBOT_PASSWORD`, sinon hash stocké dans `auth.json`, sinon généré + affiché une fois en console.
- Sessions cookie HttpOnly signées (TTL 7 j), double-submit CSRF, verrouillage 10 échecs / 5 min, rate-limit login, éjection WebSocket 4401.
- Middleware Express : `requireAuth()` (routes + fichiers statiques → redirection `/login`) et `requireCsrf()` (toutes les routes mutantes).

### `secrets.js` — coffre à clés API
- Chiffrement AES-256-GCM, clé dérivée par scrypt d'un mot de passe maître jamais stocké.
- API : `setKeys` (avec confirmation master), `unlock`, `lock`, `erase`, `status` (renvoie uniquement un `keyId` tronqué + booléens), `withApiKey(cb)` (seul accès au clair, en RAM).

### `public/index.html` — dashboard (mono-fichier, sans framework)
- Thème sombre premium, logo momBot (monogramme SVG animé), pastille 🧪 PAPER / 🔴 LIVE dans le header, pillule ⏱ uptime (temps de pause décompté), bouton déconnexion.
- KPI cards (capital, équité temps réel, positions, PnL), **graphique d'équité avec tooltip au survol** (heure, équité, PnL ; base = `startEquity`).
- Sélecteur segmenté de timeframe ; panneau **« ⚙️ Paramètres du bot » repliable** (formulaire généré depuis `/api/config`, résumé des valeurs clés quand replié, badge « n modif. non appliquée(s) », mémoire localStorage) incluant le groupe **🪙 Marché & paires** (cases à cocher + champ paire exotique) ; aperçu live du dimensionnement (marge, expo, gain si TP, perte si SL, ratio R/R).
- Panneau **« 🔐 Clés API & sécurité »** entièrement occultable (replié : aucun champ ni info du coffre visible ; mémorisé en localStorage) : saisie clé/secret/master, déverrouillage/verrouillage/effacement, test de connexion (solde), activation/désactivation du mode réel.
- Cartes de signaux par symbole (bordure illuminée si LONG/SHORT actif, chip countdown du cooldown), positions ouvertes avec barre SL→TP animée + bouton Fermer, historique des trades avec **heure d'entrée et durée**, journal des logs en direct (WebSocket).
- Boutons Start / Pause / Stop / Fermer tout (avec toasts d'erreur explicites si le serveur refuse).

### `public/login.html` — page de connexion
Formulaire minimal assorti au thème ; POST `/api/login`, redirection vers le dashboard une fois la session + jeton CSRF obtenus.

### `test_strategy.js` — tests de la stratégie
54 tests exécutés par `node test_strategy.js` : RSI Wilder contre valeurs connues, variation sur N clôtures, TP/SL déclenchés aux niveaux **exactes** (SL prioritaire), frais nets, cooldown, 1 position/symbole, exclusion des bougies non closes, agrégation 1m→3m, équité sans double-comptage des marges, référence `startEquity`, heure d'entrée/durée dans l'historique, normalisation/rejet des symboles, garde-fous paper vs réel…

---

## Architecture & flux de données

```
                    ┌────────────┐    fetchOHLCV (ccxt/Binance)
   cycle (50 s) ───▶│   bot.js   │◀─── ou générateur --demo
                    └─────┬──────┘
                          │ bougies brutes
                          ▼
                    ┌────────────┐  closedCandles() / aggregate(3m)
                    │ candles.js │
                    └─────┬──────┘
                          │ bougies closes
                          ▼
                    ┌────────────┐  rsi() / priceChangePct()
                    │indicators  │
                    └─────┬──────┘
                          │ signal LONG/SHORT ?
                          ▼
                    ┌────────────┐  openPosition / checkExit / closePosition
                    │  engine.js │◀── CONFIG (config.js + overrides params.js)
                    └──┬──────┬──┘
        hooks onOpen/onClose  │ snapshot (capital, positions, trades, equity, logs)
              (mode réel)     ▼
                    ┌────────────┐   Express REST + WebSocket (session+CSRF)
                    │ LiveBroker │──▶ public/index.html (dashboard)
                    └─────┬──────┘
                          │ ordres MARKET authentifiés (coffre secrets.js)
                          ▼
                     EXCHANGE (Binance Futures)
```

## API du dashboard

Toutes les routes `/api/*` (sauf `/api/login`) exigent une **session valide** ; les routes mutantes exigent en plus l'en-tête **`X-CSRF-Token`**.

| Méthode | Route | Effet |
|---|---|---|
| POST | `/api/login` · `/api/logout` | Session + jeton CSRF / destruction |
| GET | `/api/me` | État de la session + jeton CSRF |
| GET | `/api/state` | Snapshot complet (équité, positions, trades, logs, uptime, mode…) |
| GET | `/api/config` | Valeurs actives + `PARAM_SCHEMA` + groupes + univers de paires (génère le formulaire) |
| POST | `/api/params` | Patch de paramètres (validé, atomique, persisté, appliqué à chaud) |
| POST | `/api/params/reset` | Retour aux valeurs par défaut de `config.js` |
| POST | `/api/timeframe` | Changement de timeframe (reconstruit l'historique d'équité) |
| POST | `/api/start` · `/api/stop` · `/api/pause` | Contrôle du bot |
| POST | `/api/close/:symbol` | Fermeture manuelle d'une position |
| POST | `/api/closeall` | Fermeture de toutes les positions |
| GET | `/api/keys/status` | Coffre : déverrouillé ?, keyId tronqué, mode réel possible |
| POST | `/api/keys/set` · `/api/keys/unlock` · `/api/keys/lock` · `/api/keys/erase` | Gestion des clés API chiffrées |
| POST | `/api/keys/test` | Vérifie les clés contre l'exchange (retourne le solde) |
| WS | `ws://localhost:3000` | Push du snapshot à chaque cycle (clients connectés uniquement) |

## Déploiement & checklist production

```bash
# variables d'environnement recommandées (.env ou service systemd/Docker)
MOMBOT_PASSWORD="..."       # mot de passe du dashboard
MOMBOT_MASTER="..."         # master du coffre (sinon saisi via le dashboard, en RAM seulement)
PORT=3000                   # éventuellement personnalisé
```

Checklist avant de trader de vraies sommes :

- [ ] `npm install` + `node test_strategy.js` (54 ✔) sur la machine cible
- [ ] Dashboard derrière HTTPS/reverse-proxy (Caddy/Nginx) — le cookie session ne doit voyager qu'en TLS
- [ ] Clé API **sans droit de retrait**, restreinte à l'IP du serveur
- [ ] Bot lancé sous superviseur (`pm2 start bot.js` ou systemd `Restart=always`) — les TP/SL sont gérés par le process : **mort du process = pas de stop côté exchange** (envisager des STOP_MARKET/OCO si critique)
- [ ] Sauvegardes : `auth.json`, `secrets.json`, `params.overrides.json` (les deux premiers contiennent des matériaux sensibles — permissions 0600)
- [ ] Tester d'abord en paper sur le même timeframe, puis petit capital en réel

## Tests

```bash
node test_strategy.js
# ✔ 54 tests passent — RSI, variation, TP/SL exacts, frais, cooldown,
#   bougies closes, agrégation 3m, équité/startEquity, durée des trades,
#   symboles, garde-fous paper/réel…
```

---

⚠️ **Avertissement** : projet à but éducatif. Le paper trading ne prédit pas les résultats réels (slippage, liquidations, latences, funding fees non simulés). En mode réel, les TP/SL sont surveillés par le bot (polling) et non posés en ordos conditionnels côté exchange : si le process s'arrête, les positions restent ouvertes sans protection — à prendre en compte avant d'engager de vraies sommes. Le trading de futures avec levier peut entraîner la perte totale du capital.
