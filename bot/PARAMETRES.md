# momBot — Guide des paramètres & fonctionnalités (A → Z)

Ce document décrit **chaque paramètre** du bot : ce qu'il fait, ses valeurs possibles, comment le configurer, et les interactions avec les autres paramètres. Il couvre aussi **toutes les fonctionnalités** (dashboard, sécurité, backtest, alertes, persistance…).

> Les valeurs par défaut proviennent de `config.js`. Tout paramètre listé ici avec 🎛 est éditable **à chaud depuis le dashboard** (panneau repliable « ⚙️ Paramètres du bot ») ; les autres se changent en éditant `config.js` avant lancement. Les modifications du dashboard sont persistées dans `params.overrides.json` et rechargées au démarrage (« 💾 Overrides de paramètres chargés »).

---

## Table des matières

1. [Marché & paires](#1-marché--paires)
2. [Signal d'entrée (momentum + RSI)](#2-signal-dentrée-momentum--rsi)
3. [Money management (sizing)](#3-money-management-sizing)
4. [Sorties : TP / SL / trailing / break-even](#4-sorties-tp--sl--trailing--break-even)
5. [Filtres avancés](#5-filtres-avancés)
6. [Exécution & cadence](#6-exécution--cadence)
7. [Mode de trading : paper / réel / observation](#7-mode-de-trading--paper--réel--observation)
8. [Sécurité : mot de passe, clés API, coffre](#8-sécurité--mot-de-passe-clés-api-coffre)
9. [Alertes push (Telegram / webhook)](#9-alertes-push-telegram--webhook)
10. [Dashboard : toutes les fonctionnalités](#10-dashboard--toutes-les-fonctionnalités)
11. [Backtest CLI](#11-backtest-cli)
12. [Persistance & reprise après crash](#12-persistance--reprise-après-crash)
13. [Tableau de bord complet des paramètres](#13-tableau-de-bord-complet-des-paramètres)
14. [Recettes de configuration](#14-recettes-de-configuration)

---

## 1. Marché & paires

### 🎛 `symbols` — Paires à trader
- **Défaut** : `BTC/USDT:USDT, ETH/USDT:USDT, SOL/USDT:USDT, AVAX/USDT:USDT, SUI/USDT:USDT`
- **Format** : perpetual USDT `BASE/USDT:USDT`. Le dashboard accepte aussi `BTC/USDT` ou `btc` (normalisés automatiquement).
- **Configuration** : cases à cocher (univers de 15 perps connus) **+ champ libre** pour une paire exotique (ex. `TON` → `TON/USDT:USDT`). En mode live, chaque nouvelle paire est **vérifiée sur l'exchange** (`loadMarkets`) avant application ; une paire inconnue est refusée avec message explicite.
- **Règles importantes** :
  - Minimum 1 paire, maximum 20 (garde-fous requêtes API + lisibilité).
  - Décocher une paire **ne ferme pas** la position ouverte : elle reste gérée jusqu'à son TP/SL (pas d'abandon orphelin), mais aucune nouvelle entrée n'est possible dessus.
  - En mode `--demo`, une paire inconnue reçoit un prix simulé déterministe.
- **Effet** : immédiat (le cycle suivant ne traite que les paires actives ; les cartes « Signaux » apparaissent dès l'ajout).

### `exchange` / `marketType` (non éditables via UI)
- **Défaut** : `binance` / `future`. Le bot trade les **perpetuals USDT** (LONG + SHORT possibles). Changer d'exchange = modifier `config.js` (ccxt supporte Bybit, OKX… mais les garde-fous ont été testés sur Binance Futures).

### `candlesLimit`
- **Défaut** : `60`. Nombre de bougies demandées à l'API par cycle. Volontairement supérieur au besoin (lookback 10 + RSI 6 + marge pour l'EMA filtre) ; inutile d'y toucher sauf si tu montes beaucoup `lookbackCandles`/`emaTrendFilter`.

---

## 2. Signal d'entrée (momentum + RSI)

La stratégie est du **suivi de mouvement court terme** : on entre dans le sens d'une impulsion déjà en cours, confirmée par le RSI. Les calculs se font **uniquement sur des bougies clôturées** (la bougie en formation est écartée) et **une seule entrée est possible par nouvelle bougie close**.

### 🎛 `timeframe`
- **Défaut** : `5m`. Choix : `1m | 3m | 5m | 15m | 30m | 1h | 4h`.
- Note : Binance ne sert pas de klines « 3m » → le bot **agrège les bougies 1m en 3m** côté client (bucket en cours exclu). Tous les timeframes proposés sont donc réels.
- Effet immédiat ; la courbe d'équité est reconstruite proprement.
- **Contrainte** : en `1m`, le `cycleMs` ne peut pas descendre sous 20 000 ms (refusé par la validation de cohérence).

### 🎛 `minMovePct` — Variation minimale (%)
- **Défaut** : `0.55` (bornes UI : 0.01 → 50, pas de 0.05).
- Formule : `(clôture actuelle − clôture il y a N bougies) / clôture il y a N bougies × 100`, avec N = `lookbackCandles`.
- LONG si variation > +`minMovePct` ; SHORT si < −`minMovePct`.
- **Comment le régler** :
  - Plus bas (0.3–0.4 %) → plus de signaux, plus de bruit, plus de frais.
  - Plus haut (0.8–1.2 %) → moins de trades, signaux plus « propres ».
  - À adapter au timeframe : en 1m, 0.55 % est énorme (peu de trades) ; en 1h c'est modéré. Fais un backtest avant de changer (`node backtest.js …`).

### 🎛 `rsiLongMin` / `rsiShortMax` — Seuils RSI
- **Défaut** : `52` / `48` (bornes 0–100, pas de 0.5).
- LONG exige `RSI > rsiLongMin` ; SHORT exige `RSI < rsiShortMax`. C'est un filtre de **force directionnelle**, pas un excès : un RSI à 90 en LONG est accepté (momentum fort).
- **Contrainte de cohérence** : `rsiShortMax` doit être **strictement inférieur** à `rsiLongMin` (sinon patch refusé).
- Écarter les seuils (ex. 55/45) = plus sélectif, moins de trades. Les rapprocher (50.5/49.5) = quasi neutre, la variation décide presque seule.

### 🎛 `lookbackCandles` (avancé)
- **Défaut** : `10` (2–100). Fenêtre de mesure de la variation. 10 bougies en 5m = ~50 min de momentum.

### 🎛 `rsiPeriod` (avancé)
- **Défaut** : `6` (2–100). RSI très court = sensible/rapide (choix stratégique). Période classique 14 = beaucoup plus lisse ; change les deux ensemble si tu expérimentes.

---

## 3. Money management (sizing)

Quand un signal est validé, le moteur dimensionne ainsi :

```
marge      = capital × riskPct / 100
exposition = marge × levier          (notionnel de la position)
risque réel≈ SL% × levier × marge    (perte si le stop saute, hors frais)
```

### 🎛 `riskPct` — Risque par trade (%)
- **Défaut** : `8` (bornes UI 0.1–100 ; **plafonné à 25 en mode réel**).
- C'est la fraction du capital engagée en **marge** (pas la perte max !). Avec SL 1 % et levier 10×, la perte ≈ 10 % de la marge, soit 0,8 % du capital.
- **Guide** : 1–3 % = conservateur (survit aux séries de pertes) ; 8 % (défaut historique) = agressif ; >15 % = roulette. En réel, commence à 1–2 %.

### 🎛 `leverage` — Levier (×)
- **Défaut** : `10` (1–12). **Plafond dépend du mode : 12× en paper, 5× en réel** (garde-fou anti-liquidation ; un patch `leverage: 8` est refusé en réel avec message explicite).
- Exposition = marge × levier. Défaut : 8 % × 10 = ~80 % du capital exposé par position.

### 🎛 `maxLeverage` (via config.js)
- Plafond dur du levier en paper (12). Ne remonte pas ce chiffre sans comprendre les liquidations.

### 🎛 `initialCapital` — Capital simulé ($)
- **Défaut** : `1000` (10–1 000 000). Uniquement pour le **paper trading** : le changer **reset le carnet** (capital, positions, historique) et redéfinit la base du graphique d'équité (`startEquity`). Sans effet en mode réel.

### 🎛 `feePct` — Frais par jambe (%)
- **Défaut** : `0.04` (0–1). Frais taker estimés appliqués à l'entrée ET à la sortie : `frais = notionnel × feePct/100 × 2`. Affiché dans le log de fermeture (`PnL=-8.64$ (brut -8.00$, frais -0.64$)`).
- Binance Futures : taker ~0.04–0.05 %, maker ~0.02 % (mais ce bot utilise des ordres MARKET → taker). Mets 0 pour retrouver le comportement « sans frais » d'un autre bot et comparer.

---

## 4. Sorties : TP / SL / trailing / break-even

Les niveaux sont exprimés en **% de mouvement du prix** (pas en % de marge), dans le sens de la position. Exécution **au prix exact du niveau** (comme un ordre conditionnel), priorité au SL si les deux sont franchis sur la même bougie.

### 🎛 `takeProfitPct`
- **Défaut** : `2.8` (0.05–100). LONG fermé quand le prix monte de +2,8 % depuis l'entrée (SHORT : −2,8 %).

### 🎛 `stopLossPct`
- **Défaut** : `1.0`. Ratio gain/risque par défaut : 2.8 / 1.0 = **2.8 R/R** — avec 26 % de胜率 suffisant pour être rentable (avant frais).

### 🎛 `trailingPct` — Trailing stop
- **Défaut** : `0` = désactivé (comportement d'origine). 
- Actif (ex. `1.5`) : le stop suit le **meilleur mouvement atteint** (`highestMovePct`) à 1,5 % de retrait. Le stop ne redescend jamais sous le SL initial et ne remonte jamais au-dessus du TP.
- **Contrainte** : doit être **strictement inférieur** au TP (sinon le TP serait inatteignable → patch refusé).
- Cas d'usage : laisser courir les gros mouvements en réduisant le risque de retour à zéro. Coûte des fermetures anticipées dans les marchés hachés.

### 🎛 `breakEvenPct` (+ `breakEvenOffsetPct` via config.js)
- **Défaut** : `0` = désactivé. Actif (ex. `1.0`) : dès que le gain a touché +1 %, le stop est remonté **au prix d'entrée** (offset éventuel en % au-dessus pour couvrir les frais). Une fois déclenché, la position ne peut plus finir perdante (hors frais/slippage).
- **Contrainte** : `< takeProfitPct`.
- Combinaison classique : `breakEvenPct: 1.0` + `trailingPct: 1.5` → sécurisé à partir de +1 %, puis suivi du pic.

### 🎛 `useExchangeStops` — Stops côté exchange (mode réel)
- **Défaut** : `true`. En plus du polling du bot, place de vrais ordres `STOP_MARKET` / `TAKE_PROFIT_MARKET` (reduceOnly) sur l'exchange : **la position reste protégée même si le bot/PC meurt**.
- Limitation assumée : si trailing/break-even actifs, les stops exchange sont mis à jour périodiquement (polling) — un petit délai de rattrapage est possible. En paper, ignoré (sans objet).

---

## 5. Filtres avancés

Désactivés par défaut = comportement de la stratégie d'origine. Ils **bloquent des entrées**, ils ne modifient jamais les sorties.

### 🎛 `emaTrendFilter` — Filtre de tendance EMA
- **Défaut** : `0` = off. Si `N > 0` (pas de 5, max 400) : LONG autorisé seulement si la dernière clôture est **au-dessus de l'EMA(N)** calculée sur `trendTimeframe` ; SHORT seulement en dessous.
- Philosophie : « n'achète pas contre la tendance de fond ». Réduit les SL en contre-tendance, réduit aussi le nombre de trades.
- Pas assez d'historique sur le TF supérieur ? Le signal n'est **pas bloqué** (on ne pénalise pas l'absence de données).

### 🎛 `trendTimeframe`
- **Défaut** : `1h` (choix : 15m | 30m | 1h | 4h). Doit rester **supérieur** au timeframe principal pour avoir du sens (ex. trade 5m filtré par EMA50 en 1h ≈ tendance des 50 dernières heures).

### 🎛 `maxTotalExposurePct` — Plafond d'exposition cumulée
- **Défaut** : `300` (% du capital, bornes 20–1000). Somme des notionnels de **toutes** les positions ouvertes limitées.
- Pourquoi : BTC/ETH/SOL/AVAX/SUI sont **fortement corrélés** — 5 longs simultanés = souvent 5× le même pari. Avec 80 % d'expo par position, le plafond 300 % autorise ~3–4 positions ; descends à 150–200 % pour être prudent.
- Comportement à l'approche du plafond : l'entrée est **réduite** pour coller au plafond si la marge restante est significative, sinon **refusée** (journalisé WARN).

### 🎛 `tradingHoursUTC` — Fenêtre horaire
- **Défaut** : `""` = toujours. Format `"13-21"` (heures UTC, début inclus, fin exclusive). Aucune **nouvelle** entrée hors fenêtre ; les sorties TP/SL restent actives 24/7 (jamais de position abandonnée).
- Utilité : éviter les heures mortes (week-end illiquide) ou aligner sur la volatilité US/EU. Convertis : Paris = UTC+1/+2.

---

## 6. Exécution & cadence

### 🎛 `cycleMs` — Intervalle du cycle
- **Défaut** : `50000` ms (5 s – 10 min). Fréquence d'analyse de toutes les paires.
- Inutile < temps de formation d'une bougie : en 5m, 30–60 s suffisent (les clôtures dures + verrou « 1 entrée par bougie » rendent un cycle plus rapide quasi inutile, juste plus de requêtes API).
- En 1m : minimum forcé 20 s. Modifier le cycle **redémarre le timer** immédiatement.

### 🎛 `cooldownMs` — Cooldown par symbole
- **Défaut** : `300000` (5 min, 0–24 h). Délai minimum entre deux **ouvertures** sur le même symbole (même après une fermeture immédiate). Empêche la ré-entrée dans le bruit post-SL.
- Le countdown restant s'affiche en chip ⏳ sur la carte du signal correspondant.

### `maxOnePositionPerSymbol` (config.js)
- Toujours vrai structurellement : le carnet est indexé par symbole. Non exposé car changer cette règle casserait toute la logique de gestion.

---

## 7. Mode de trading : paper / réel / observation

### 🎛 `tradingMode`
- **Défaut** : `paper` 🧪 (pastille cyan dans le header). Simulation sur **prix réels** (ou synthétiques en `--demo`) : carnet local, capital virtuel, stats complètes.
- `real` 🔴 (pastille rouge) : ordres MARKET envoyés sur l'exchange via le coffre. **Refusé** si : coffre verrouillé, clés absentes, ou connexion exchange impossible (message explicite). Passage en réel = double confirmation dans l'UI.
- Garde-fous renforcés en réel : levier ≤ 5×, risque ≤ 25 %, stops exchange par défaut.

### 🎛 `observeOnly` — Mode observation 👁
- **Défaut** : `false`. Le bot calcule, affiche et journalise les signaux **sans jamais ouvrir de position** (ni paper ni réel). Parfait pour valider une nouvelle config (paires, seuils, filtres) pendant quelques jours avant d'armer.

### Commutation paper ↔ réel
- Bouton du panneau 🔐. Repasser en paper **ne ferme pas** les positions réelles existantes (gère-les sur l'exchange ou ferme-les d'abord via « Fermer tout »). Le carnet paper reprend là où il était (persisté).

---

## 8. Sécurité : mot de passe, clés API, coffre

### Mot de passe du dashboard (`MOMBOT_PASSWORD`)
- **Aucun mot de passe par défaut.** Deux cas :
  1. Tu lances avec `MOMBOT_PASSWORD="..." node bot.js` → c'est lui qui sert (haché scrypt dans `auth.json`).
  2. Sans variable → un mot de passe fort est **généré et affiché une seule fois en console** au premier lancement. Oublié ? Supprime `auth.json`, relance : nouveau mot de passe.
- Mécanismes (`auth.js`) : cookie HttpOnly signé HMAC (TTL 7 j), jeton CSRF double-submit sur toutes les routes mutantes, anti-brute-force (10 échecs / 5 min → IP bloquée), WebSocket éjecté (code 4401) si session expirée.

### Clés API & coffre (`secrets.js`) — panneau 🔐 occultable
- Flux : saisir clé + secret + **mot de passe maître** (≥ 8 caractères, confirmé) → « Enregistrer » → les clés sont **validées sur l'exchange avant stockage** (un `apiKey invalid` est rejeté, rien n'est écrit) → chiffrées **AES-256-GCM** (clé dérivée scrypt du master) dans `secrets.json`.
- Le mot de passe maître n'est **jamais stocké** : perdu = coffre irrécupérable (bouton « Effacer » pour repartir de zéro).
- Déverrouillage requis pour passer en réel ; **Verrouiller** remet automatiquement en paper et purges les clés de la RAM.
- Ce que voit le navigateur : uniquement un `keyId` tronqué et des booléens. Les clés en clair ne quittent jamais le process Node.
- ⚠️ Crée une clé API **sans droit de retrait**, idéalement restreinte à ton IP, permissions « lecture + trading futures » uniquement.
- « Tester la connexion » → solde réel de ton compte (preuve que la signature fonctionne).

---

## 9. Alertes push (Telegram / webhook)

Carte dédiée (repliable) dans le dashboard, route `/api/alerts/config`, bouton « 📤 Tester ».

| Paramètre (config.js) | Défaut | Rôle |
|---|---|---|
| `alertOnClose` | `true` | Notifie chaque fermeture (TP ✅ / SL ❌ / MANUEL) avec symbole, direction, PnL net. |
| `alertOnError` | `true` | Notifie erreurs réseau persistantes et refus d'ordre en mode réel. |
| `alertDrawdownPct` | `20` | Alerte si le drawdown dépasse ce % (0 = off). Se réarme une fois repassé sous moitié du seuil (anti-spam). |

- **Telegram** : token du bot (@BotFather) + chat id (@userinfobot). **Webhook** : POST JSON `{text}` vers n'importe quelle URL (Discord via slack-compatible, ntfy.sh, script maison…).
- Anti-doublon : une même alerte (clé `kind:symbol`) n'est pas renvoyée deux fois en < 60 s. Chaque envoi (succès/échec) est journalisé dans le log du bot.

---

## 10. Dashboard : toutes les fonctionnalités

http://localhost:3000 (page `/login` d'abord). Mono-fichier sans framework, WebSocket temps réel.

- **Header** : logo momBot animé, pastille 🧪 PAPER / 🔴 LIVE, état ▶ running / ⏸ paused / ⏹ stopped, pillule ⏱ **uptime** (temps de pause décompté, secondes près), bouton déconnexion 🚪.
- **KPI cards** : capital, équité temps réel (PnL latent inclus, **sans double comptage des marges**), positions ouvertes, PnL session.
- **Graphique « Évolution de l'équité »** : sélecteur segmenté de timeframe, **tooltip au survol** (heure, équité, delta vs départ — base `startEquity` recalée si reset du capital).
- **Signaux en direct** : une carte par paire (variation %, RSI, bordure illuminée vert/rouge si signal actif, chip ⏳ cooldown, badge position, motif « filtré » quand un filtre bloque).
- **Positions ouvertes** : sens, taille, marge, levier, entrée (heure) + **durée live** (tick chaque seconde), barre SL→TP avec marqueur de progression animé, bouton « Fermer » par position.
- **Historique des trades** : 9 colonnes dont **Entrée (heure)**, Durée, PnL net (brut + frais séparés), export CSV (`/api/trades.csv`).
- **Journal** : logs live (INFO/WARN/ERROR colorés, horodatés).
- **📊 Statistiques** (sous le journal, repliable, résumé en chips) : Trades, Profit factor, Expectancy/trade, Max drawdown, Frais cumulés, Slippage estimé, Mise à jour.
- **⚙️ Paramètres du bot** : panneau repliable, formulaire **généré depuis le schéma serveur** (groupes 🪙📡💰🎯🧪⚙️🔐), bornes/aides par champ, aperçu live du dimensionnement (marge, expo, gain TP, perte SL, R/R), badge « n modif. non appliquée(s) », Appliquer / ↺ Défauts, mémoire localStorage de l'état replié.
- **🔐 Clés API & sécurité** : entièrement occultable (replié = zéro info visible), saisie/déverrouillage/verrouillage/effacement, test connexion, activation réel/paper avec double confirmation.
- **Boutons Start / Pause / Stop / Fermer tout** : toasts d'erreur explicites si le serveur refuse (CSRF, état…).

---

## 11. Backtest CLI

Avant d'armer quoi que ce soit en réel :

```bash
node backtest.js --symbol BTC/USDT:USDT --timeframe 5m --days 30
node backtest.js --all                          # toutes les paires du config
node backtest.js --symbol ETH/USDT:USDT --days 90 --tp 3.5 --sl 1.2 --minMove 0.7
```

Options : `--tp --sl --minMove --rsiLong --rsiShort --lookback --rsiPeriod --risk --levier --fee --cooldown --capital --emaFilter --mode close|intrabar`.

- **`close`** : TP/SL évalués sur les clôtures = comportement actuel du bot (exécution au niveau exact ; optimiste sur les gaps).
- **`intrabar`** : TP/SL considéré touché dès que high/low franchit le niveau (SL prioritaire si les deux dans la même bougie) = fidèle à de vrais stop orders.
- Sortie : nb trades, winrate, profit factor, expectancy, max DD, frais, equity finale. Utilise exactement le même cœur `strategy.js` que le live (aucun look-ahead).

---

## 12. Persistance & reprise après crash

`state.js` : le carnet (capital, positions ouvertes, trades, équité, cooldowns, `startEquity`) est écrit dans `state.json` de façon **atomique** (tmp + rename), debouncé 2 s, avec backup `.bak` de secours si coupure pendant l'écriture.

- Redémarrage → « ♻️ État restauré depuis state.json (capital X$, n position(s)) ».
- En mode réel, les positions sont **re-synchronisées avec l'exchange** (taille/prix réels) ; divergence → WARN + la position locale est conservée pour ne jamais perdre le suivi d'un stop.
- Pour repartir de zéro : supprimer `state.json` (+ `.bak`) bot arrêté, ou « ↺ Défauts » + reset du capital simulé.
- ⚠️ `state.json`, `auth.json`, `secrets.json`, `params.overrides.json` sont gitignorés (contenu sensible/local).

---

## 13. Tableau de bord complet des paramètres

| Paramètre | Groupe | Défaut | Bornes UI | Immédiat ? | Notes |
|---|---|---|---|---|---|
| `symbols` | 🪙 | 5 paires | 1–20 | ✅ | vérifiées sur l'exchange en live |
| `timeframe` | ⚙️ | 5m | enum | ✅ | 3m agrégé depuis 1m |
| `minMovePct` | 📡 | 0.55 % | 0.01–50 | ✅ | |
| `rsiLongMin` | 📡 | 52 | 0–100 | ✅ | > rsiShortMax obligatoire |
| `rsiShortMax` | 📡 | 48 | 0–100 | ✅ | |
| `lookbackCandles` | 📡 adv | 10 | 2–100 | ✅ | |
| `rsiPeriod` | 📡 adv | 6 | 2–100 | ✅ | |
| `riskPct` | 💰 | 8 % | 0.1–100 | ✅ | ≤ 25 en réel |
| `leverage` | 💰 | 10× | 1–12 | ✅ | ≤ 5 en réel |
| `initialCapital` | 💰 adv | 1000 $ | 10–1M | reset carnet | paper only |
| `feePct` | ⚙️ | 0.04 % | 0–1 | ✅ | |
| `takeProfitPct` | 🎯 | 2.8 % | 0.05–100 | ✅ | TP/SL positions ouvertes recalculés |
| `stopLossPct` | 🎯 | 1.0 % | 0.05–100 | ✅ | |
| `trailingPct` | 🎯 | 0 (off) | 0–50 | ✅ | < TP obligatoire |
| `breakEvenPct` | 🎯 | 0 (off) | 0–50 | ✅ | < TP obligatoire |
| `emaTrendFilter` | 🧪 | 0 (off) | 0–400 | ✅ | |
| `trendTimeframe` | 🧪 | 1h | enum | ✅ | |
| `maxTotalExposurePct` | 🧪 | 300 % | 20–1000 | ✅ | réduction/refus d'entrée |
| `tradingHoursUTC` | 🧪 adv | "" (toujours) | `\d{1,2}-\d{1,2}` | ✅ | sorties 24/7 |
| `cycleMs` | ⚙️ adv | 50 000 | 5s–10min | ✅ timer restart | ≥ 20s en 1m |
| `cooldownMs` | ⚙️ adv | 300 000 | 0–24h | ✅ | |
| `tradingMode` | 🔐 | paper | paper/real | ✅ | réel exige coffre débloqué |
| `observeOnly` | 🔐 | false | bool | ✅ | aucun ordre, aucun carnet |
| `useExchangeStops` | 🔐 | true | bool | ✅ | réel uniquement |

Seuils d'alerte : `alertOnClose` / `alertOnError` / `alertDrawdownPct` (config.js + carte Notifications).

---

## 14. Recettes de configuration

**🐣 Découvrir (sans risque)** — défauts + observation :
`observeOnly: true`, timeframe 5m, surveiller 2 semaines, lire les stats.

**🛡 Prudent paper** : `riskPct: 2`, `leverage: 5`, `emaTrendFilter: 50 @ 1h`, `maxTotalExposurePct: 150`, TP 2.5 / SL 1.0, `feePct: 0.05`.

**⚡ Momentum agressif** : `minMovePct: 0.4`, `lookbackCandles: 6`, `rsiLongMin: 55 / rsiShortMax: 45`, `trailingPct: 1.2`, `breakEvenPct: 0.8`, timeframe 1m ou 3m, `cooldownMs: 120000`. Attention au ratio signaux/frais : backteste.

**🔴 Premier passage en réel** : `MOMBOT_PASSWORD=...` fort, clé API **sans retrait + IP restreinte**, `useExchangeStops: true`, `riskPct: 1–2`, levier ≤ 3, 2 paires max (BTC/ETH), `maxTotalExposurePct: 60`, alertes Telegram activées, VPS (pas ton PC portable), `observeOnly` encore 1 semaine avec ces réglages avant de désarmer l'observation.

**🌙 Ne trader que l'Europe/US** : `tradingHoursUTC: "7-21"`, `emaTrendFilter: 100 @ 4h`, `minMovePct: 0.6`.

---

*Règle d'or : chaque changement de paramètre doit être justifié par un backtest (`node backtest.js`) ou une période en mode observation — pas par une série de 3 pertes.*
