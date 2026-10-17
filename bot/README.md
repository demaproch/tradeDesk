# momBot 🤖

Bot de trading **momentum + RSI** sur les futures perpétuels Binance (paper trading), avec dashboard temps réel et paramètres 100 % éditables depuis l'interface.

> En une phrase : le bot détecte un mouvement de prix significatif sur les 10 dernières bougies **clôturées**, le confirme avec le RSI, entre dans le sens du mouvement avec 8 % de risque et un levier 10x, puis sort automatiquement à **+2,8 %** (TP) ou **−1,0 %** (SL).

---

## Sommaire

1. [Démarrage rapide](#démarrage-rapide)
2. [La stratégie de A à Z](#la-stratégie-de-à-z)
   - [Paramètres généraux](#1-paramètres-généraux)
   - [Détection du signal](#2-détection-du-signal-entrée-en-position)
   - [Dimensionnement de la position](#3-dimensionnement-de-la-position-money-management)
   - [Gestion des sorties (TP / SL)](#4-gestion-des-sorties-tp--sl)
   - [Règles supplémentaires](#5-règles-supplémentaires)
   - [Pièges corrigés (pourquoi ces choix)](#6-pièges-corrigés--pourquoi-ces-choix)
3. [Rôle de chaque fichier](#rôle-de-chaque-fichier)
4. [Architecture & flux de données](#architecture--flux-de-données)
5. [API du dashboard](#api-du-dashboard)
6. [Tests](#tests)

---

## Démarrage rapide

```bash
cd bot
npm install            # ccxt, express, ws

node bot.js            # prix réels Binance (futures USDT-M)
node bot.js --demo     # données simulées — fonctionne sans internet

# tableau de bord : http://localhost:3000
node test_strategy.js  # 38 tests de la stratégie
```

Aucune clé API n'est nécessaire : le bot est en **paper trading** (capital virtuel de 1000 $), il ne passe aucun ordre réel. Il utilise uniquement les données publiques de l'exchange via [ccxt](https://github.com/ccxt/ccxt).

---

## La stratégie de A à Z

### 1. Paramètres généraux

| Élément | Valeur | Où le changer |
|---|---|---|
| Timeframe | `5m` par défaut (1m, 3m, 5m, 15m, 30m, 1h, 4h) | Dashboard → boutons timeframe |
| Paires tradées | BTC/USDT, ETH/USDT, SOL/USDT, AVAX/USDT, SUI/USDT | `config.js` (`symbols`) |
| Marché | Perpetuals USDT (LONG **et** SHORT) | `config.js` (`marketType`) |
| Capital de départ | 1000 $ (simulé) | `config.js` (`initialCapital`) |
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

- Franchissement du TP → fermeture **au prix exact du TP** (comme un ordre conditionnel réel, pas à la clôture qui a pu slpper).
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
| TP/SL déclenchés **à la clôture** de la bougie | fermettes slippées bien au-delà du niveau | détection par franchissement high/low, exécution au **prix exact** du niveau |
| **Frais ignorés** | un SL à −10 % de marge devenait −10,8 % avec les fees ; ruine lente malgré un bon winrate | PnL net = brut − frais des deux jambes |

---

## Rôle de chaque fichier

```
bot/
├── bot.js                 ← point d'entrée : boucle + serveur web
├── engine.js              ← cœur métier : paper trading pur (zéro réseau)
├── config.js              ← tous les paramètres par défaut de la stratégie
├── params.js              ← schéma + validation des paramètres éditables
├── indicators.js          ← calculs techniques purs (RSI, variation)
├── candles.js             ← manipulation OHLCV (bougies closes, agrégation)
├── test_strategy.js       ← 38 tests unitaires de la stratégie
├── params.overrides.json  ← patch de paramètres persisté depuis le dashboard (généré)
├── server.log             ← journal d'exécution (généré)
├── package.json           ← dépendances : ccxt, express, ws
└── public/
    └── index.html         ← dashboard complet (HTML/CSS/JS, zéro framework)
```

### `bot.js` — orchestrateur
- Boucle principale : toutes les `cycleMs`, appelle l'exchange via **ccxt** (`fetchOHLCV`), nettoie/agrège les bougies (`candles.js`), calcule les signaux (`indicators.js`), pilote le moteur (`engine.js`).
- Mode `--demo` : générateur de prix synthétiques (marche sans internet ni compte).
- Gère les erreurs réseau (timeouts, DNS) sans crasher : log WARN et retry au cycle suivant.
- Serveur **Express** : sert le dashboard + API REST (voir plus bas) ; **WebSocket** (`ws`) : push du snapshot d'état à chaque cycle vers tous les clients.
- Applique les changements de paramètres à chaud (redémarre le timer si `cycleMs` change, recalcule TP/SL des positions ouvertes…).

### `engine.js` — moteur de trading simulé
Logique purement déterministe, testable sans réseau :
- `openPosition(symbol, side, price, meta)` : vérifie cooldown / position existante, calcule marge (`riskPct`), levier plafonné, qty, prix TP/SL exacts.
- `checkExit(pos, candle)` : retourne `{kind: 'TP'|'SL', price}` au prix exact du niveau (SL prioritaire), sinon `null`.
- `closePosition(symbol, price, reason)` : PnL brut, frais des deux jambes, mise à jour du capital, historique du trade (`openedAt`, `closedAt`, `durationMs`), log détaillé (heure d'entrée + durée).
- Suit `capital`, `positions` (Map), `closedTrades`, `lastTradeTime`, `equityHistory` (avec PnL latent), `logs` (bornés à 300).
- `fmtDuration()` : durées lisibles (« 3 min 12 s », « 1 h 05 min »).

### `config.js` — paramètres par défaut
Un seul objet `CONFIG` centralisant : exchange, symboles, timeframe, cadence, seuils du signal (variation, RSI), money management (capital, risque, levier), sorties (TP/SL), cooldown, frais, port du dashboard. Modifier ici = changer la stratégie sans toucher au code.

### `params.js` — validation des paramètres éditables
- `PARAM_SCHEMA` : pour chaque paramètre modifiable via l'UI → type, bornes min/max, pas, unité, groupe d'affichage (`signal` / `money` / `exits` / `execution`), niveau (`core` visible / `advanced` replié), texte d'aide. C'est ce schéma qui **génère automatiquement le formulaire** du dashboard.
- `checkCoherence()` : garde-fous croisés (RSI short < RSI long ; cycle ≥ 20 s en 1m…).
- Application atomique : un patch invalide est **entièrement rejeté** avec message explicite (aucune mutation partielle), puis persisté dans `params.overrides.json`.

### `indicators.js` — indicateurs techniques (pur JS, zéro dépendance)
- `rsi(closes, period)` : RSI à **lissage de Wilder** (celui de TradingView/Binance), renvoie `null` si données insuffisantes.
- `priceChangePct(closes, lookback)` : variation en % entre la dernière clôture et celle d'il y a `lookback` bougies.

### `candles.js` — manipulation de bougies OHLCV
- `closedCandles(candles)` : retire la dernière bougie (toujours en cours de formation dans `fetchOHLCV`) — **garantie anti-biais**.
- `aggregate(candles, fromMs, toMs)` : construit des timeframe inexistants côté exchange (le 3m à partir du 1m), combine open/high/low/close, et supprime le dernier bucket non terminé.
- `TF_MS` : table de conversion timeframe → millisecondes.

### `public/index.html` — dashboard (mono-fichier, sans framework)
- Thème sombre premium, logo momBot (monogramme SVG animé).
- KPI cards (capital, équité temps réel, positions, PnL), **graphique d'équité avec tooltip au survol** (heure, équité, PnL).
- Sélecteur segmenté de timeframe, panneau **« ⚙️ Paramètres du bot » repliable** (formulaire généré depuis `/api/config`, résumé des valeurs clés quand replié, badge « n modif. non appliquée(s) », mémoire localStorage), aperçu live du dimensionnement (marge, expo, gain si TP, perte si SL, ratio R/R).
- Cartes de signaux par symbole (bordure illuminée si LONG/SHORT actif, chip countdown du cooldown), positions ouvertes avec barre SL→TP animée + bouton Fermer, historique des trades avec **heure d'entrée et durée**, journal des logs en direct (WebSocket).
- Boutons Start / Pause / Stop / Fermer tout.

### `test_strategy.js` — tests de la stratégie
38 tests exécutés par `node test_strategy.js` : RSI Wilder contre valeurs connues, variation sur N clôtures, TP/SL déclenchés aux niveaux **exactes** (SL prioritaire), frais nets, cooldown, 1 position/symbole, exclusion des bougies non closes, agrégation 1m→3m, équité sans double-comptage des marges, heure d'entrée/durée dans l'historique…

---

## Architecture & flux de données

```
                    ┌────────────┐    fetchOHLCV (ccxt/Binance)
   cycle (50 s) ───▶│   bot.js   │◀─── ou générateur --demo
                    └─────┬──────┘
                          │ bougies brutes
                          ▼
                    ┌────────────┐  closedCandles() / aggregate(3m)
                          │ bougies closes
                          ▼
                    ┌────────────┐  rsi() / priceChangePct()
                    │indicators  │
                    └─────┬──────┘
                          │ signal LONG/SHORT ?
                          ▼
                    ┌────────────┐  openPosition / checkExit / closePosition
                    │  engine.js │◀── CONFIG (config.js + overrides params.js)
                    └─────┬──────┘
                          │ snapshot (capital, positions, trades, equity, logs)
                          ▼
              Express REST + WebSocket  ──▶  public/index.html (dashboard)
```

## API du dashboard

| Méthode | Route | Effet |
|---|---|---|
| GET | `/api/state` | Snapshot complet (équité, positions, trades, logs…) |
| GET | `/api/config` | Valeurs actives + `PARAM_SCHEMA` + groupes (génère le formulaire) |
| POST | `/api/params` | Patch de paramètres (validé, atomique, persisté, appliqué à chaud) |
| POST | `/api/params/reset` | Retour aux valeurs par défaut de `config.js` |
| POST | `/api/timeframe` | Changement de timeframe (reconstruit l'historique d'équité) |
| POST | `/api/start` · `/api/stop` · `/api/pause` | Contrôle du bot |
| POST | `/api/close/:symbol` | Fermeture manuelle d'une position |
| POST | `/api/closeall` | Fermeture de toutes les positions |
| WS | `ws://localhost:3000` | Push du snapshot à chaque cycle |

## Tests

```bash
node test_strategy.js
# ✔ 38 tests passent — RSI, variation, TP/SL exacts, frais, cooldown,
#   bougies closes, agrégation 3m, équité, durée des trades…
```

---

⚠️ **Avertissement** : projet à but éducatif. Le paper trading ne prédit pas les résultats réels (slippage, liquidations, latences, funding fees non simulés). Le trading de futures avec levier peut entraîner la perte totale du capital.
