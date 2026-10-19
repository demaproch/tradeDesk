# momBot — Documentation de la stratégie et du fonctionnement (A → Z)

> Ce document décrit **la stratégie de trading** et **le fonctionnement technique complet** du bot,
> de la récupération des bougies jusqu'à l'affichage du dashboard. Il est volontairement indépendant
> du code : en le lisant seul, on doit pouvoir reconstruire un bot équivalent dans n'importe quel
> langage. (Pour un prompt prêt à coller dans une autre IA, voir `PROMPT_SKILL.md`.)

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Paramètres généraux](#2-paramètres-généraux)
3. [Cycle de vie d'un tick (le cœur du bot)](#3-cycle-de-vie-dun-tick-le-cœur-du-bot)
4. [Étape 1 — Récupération & assainissement des données de marché](#4-étape-1--récupération--assainissement-des-données)
5. [Étape 2 — Gestion des sorties (TP / SL) — prioritaire](#5-étape-2--gestion-des-sorties-tp--sl--prioritaire)
6. [Étape 3 — Calcul du signal d'entrée](#6-étape-3--calcul-du-signal-dentrée)
7. [Étape 4 — Filtres avant ouverture (anti re-entry, cooldown, position unique)](#7-étape-4--filtres-avant-ouverture)
8. [Étape 5 — Dimensionnement de la position (money management)](#8-étape-5--dimensionnement-de-la-position-money-management)
9. [Étape 6 — Ouverture de la position & journalisation](#9-étape-6--ouverture-de-la-position--journalisation)
10. [Étape 7 — PnL, frais et équité temps réel](#10-étape-7--pnl-frais-et-équité-temps-réel)
11. [Paper trading vs trading réel](#11-paper-trading-vs-trading-réel)
12. [Garde-fous et pièges corrigés (à ne jamais réintroduire)](#12-garde-fous-et-pièges-corrigés)
13. [Paramètres modifiables via le dashboard](#13-paramètres-modifiables-via-le-dashboard)
14. [Rôle de chaque fichier](#14-rôle-de-chaque-fichier)
15. [Annexe A — Formules exactes](#annexe-a--formules-exactes)
16. [Annexe B — Exemple de trade chiffré pas à pas](#annexe-b--exemple-de-trade-chiffré-pas-à-pas)

---

## 1. Vue d'ensemble

momBot est un bot de **momentum court terme** sur les perpetuals USDT d'un exchange de crypto
(Binance par défaut). En une phrase :

> Le bot détecte un mouvement de prix significatif sur les 10 dernières bougies **clôturées**,
> le confirme avec le RSI(6), entre **dans le sens du mouvement** avec 8 % du capital en marge
> et un levier ×10, puis sort automatiquement à **+2,8 %** (take profit) ou **-1,0 %** (stop loss).

C'est une stratégie de **suivi de tendance** (« trend-following ») appliquée à très court terme :
on ne devine jamais un retournement, on emboîte le pas à un mouvement déjà en cours et confirmé
par la force (RSI). Le ratio risque/gain est volontairement asymétrique en faveur du gain :
risque ~1 %, gain visé ~2,8 % (ratio ≈ 1:2,8), donc même un win rate de ~30 % peut rester rentable
après frais.

Architecture générale :

```
        ┌────────────────────────────────────────────────────┐
        │                  Exchange (Binance)                │
        │   klines OHLCV · prix mark · comptes futures       │
        └───────────▲───────────────────────────▲────────────┘
                    │ fetchOHLCV (REST)         │ ordres MARKET (ccxt signé)
                    │                           │
        ┌───────────┴───────────┐   ┌───────────┴────────────┐
        │    MarketData /       │   │      LiveBroker        │
        │    DemoMarket         │   │  (seulement si mode    │
        │  (bougies closes +    │   │   réel activé + clés  │
        │   agrégation 1m→3m)   │   │   déverrouillées)     │
        └───────────┬───────────┘   └───────────▲────────────┘
                    │ bougies saines            │ hooks onOpen/onClose
                    ▼                           │
        ┌───────────────────────────────────────┴───────────┐
        │                     MomentumBot                   │
        │   setInterval(cycleMs) → runCycle()               │
        │   pour chaque symbole surveillé : processSymbol() │
        └───────────┬───────────────────────────────────────┘
                    │ signaux, positions, trades, équité
                    ▼
        ┌───────────────────────────────────────────────────┐
        │              TradingEngine (carnet papier)        │
        │  sizing · TP/SL · cooldown · PnL net · stats      │
        └───────────┬───────────────────────────────────────┘
                    │ snapshot JSON + push WebSocket
                    ▼
        ┌───────────────────────────────────────────────────┐
        │   Dashboard Express + WS (protégé par login)      │
        │   graphique d'équité · cartes signaux · panneau   │
        │   paramètres éditable · historique · stats        │
        └───────────────────────────────────────────────────┘
```

---

## 2. Paramètres généraux

| Élément | Valeur par défaut | Notes |
|---|---|---|
| Timeframe | `5m` | Choix : 1m, 3m, 5m, 15m, 30m, 1h, 4h (modifiable en direct) |
| Marché | Perpetuals USDT (`BASE/USDT:USDT`) | LONG **et** SHORT possibles |
| Paires | BTC, ETH, SOL, AVAX, SUI /USDT | 15 paires proposées + paire libre, éditables |
| Capital de départ | 1 000 $ (simulé) | sert de base au money management |
| Rythme | 1 cycle toutes les ~50 s | le vrai déclencheur d'entrée est la **nouvelle bougie close** |
| Positions | Max 1 par symbole | aucune pyramide |
| Cooldown | 5 min entre 2 trades sur le même symbole | anti-rebound après un stop |

Tous ces paramètres sont modifiables **sans redémarrer** via le dashboard (voir §13).

---

## 3. Cycle de vie d'un tick (le cœur du bot)

À chaque cycle (`setInterval` de `cycleMs`), pour **chaque symbole surveillé** (+ ceux ayant
encore une position ouverte, même si la paire a été décochée depuis), le bot exécute cet ordre
strict :

```
processSymbol(symbol):
  1. bougies = fetchCandles(symbol)          # nettoyées : closes uniquement, agrégées si besoin
  2. closePrice = dernière clôture
  3. SI position ouverte sur symbol :
        exit = checkExit(pos, closePrice)     # TP ou SL franchi ?
        SI exit → closePosition(exit.price)   # fermé AU PRIX EXACT du niveau, pas à la clôture
  4. SI nouvelle bougie close sur symbol (timestamp différent du précédent) :
        var%  = priceChangePct(bougies, 10)
        rsi   = rsi(clôtures, 6)
        SI var% > +0,55 ET rsi > 52            → demande LONG
        SI var% < -0,55 ET rsi < 48            → demande SHORT
        SI signal ET pas de position ET canOpen(cooldown) :
            marge = capital × 8% ; levier = min(10, plafond) ; notional = marge × levier
            openPosition(side, closePrice)
  5. point d'équité = cash réalisé + PnL latent (jamais la marge comptée deux fois)
```

Points critiques de cet ordre :

- **Les sorties sont vérifiées AVANT les entrées.** Un symbole qui vient de toucher son SL ne
  peut pas rouvrir une position dans la même foulée.
- **Une entrée n'est possible que sur une NOUVELLE bougie clôturée** (détection par changement de
  timestamp). C'est ce qui empêche le bot d'entrer 60 fois pendant la formation d'une bougie 5 m.
- Les indicateurs sont calculés sur des **clôtures dures** de bougies closes, jamais sur la bougie
  en cours (qui change à chaque tick et crée de faux signaux).

---

## 4. Étape 1 — Récupération & assainissement des données

Le module `candles.js` garantit des données propres avant tout calcul :

1. **Suppression de la bougie en cours de formation.** `fetchOHLCV` renvoie toujours une dernière
   bougie non close dont la clôture fluctue seconde par seconde. On la retire systématiquement :
   seules les bougies **closes** entrent dans les calculs.
2. **Agrégation si nécessaire.** Certains timeframes (ex. `3m`) ne sont pas servis nativement par
   l'exchange. Le bot télécharge alors les bougies de base (`1m`) et les agrège en buckets alignés
   sur l'horodatage (`floor(time / tfMs)`), en retirant aussi le dernier bucket encore en cours.
   Sans cela, un timeframe demandé « 3m » serait silencieusement traité en 1m — et la stratégie
   ne serait plus la même.
3. **Suffisance des données.** Il faut au moins `lookback + 1` bougies (11) pour calculer la
   variation, et `rsiPeriod + 1` (7) pour le RSI ; sinon le cycle passe son tour sans erreur.

En mode démo hors-ligne, un générateur produit des séries OHLCV plausibles (marche aléatoire
autour de prix de référence) avec les mêmes garanties (dernière bougie = celle en cours, retirée).

---

## 5. Étape 2 — Gestion des sorties (TP / SL) — prioritaire

Dès qu'une position existe, à **chaque cycle**, on compare la dernière clôture aux deux niveaux :

```
dir = +1 si LONG, -1 si SHORT
prix_TP = entrée × (1 + dir × takeProfitPct/100)     # +2,8 % de mouvement du prix
prix_SL = entrée × (1 - dir × stopLossPct/100)       # -1,0 % de mouvement du prix

hitSL = LONG ? close ≤ prix_SL : close ≥ prix_SL
hitTP = LONG ? close ≥ prix_TP : close ≤ prix_TP

SI hitSL → fermeture "SL"  (priorité au stop si les deux sont touchés sur la même bougie)
SI hitTP → fermeture "TP"
```

Règles importantes :

- **Exécution au prix exact du niveau**, comme le ferait un ordre conditionnel réel — pas à la
  clôture de la bougie, qui peut avoir slippé bien plus loin (ce qui gonflait artificiellement
  les pertes dans les premières versions).
- **Priorité au SL** quand une seule et même bougie franchit TP et SL : on suppose le pire chemin
  intra-bougie. C'est conservateur et honnête en backtest/paper.
- Pas de trailing stop, pas d'extension : TP/SL fixes, c'est tout.
- Fermeture manuelle possible depuis le dashboard (« Fermer » par position, « Fermer tout »),
  enregistrée comme raison `MANUAL`.

---

## 6. Étape 3 — Calcul du signal d'entrée

Deux mesures complémentaires, calculées sur les bougies closes :

### a) Variation de prix sur les N dernières bougies (momentum)

```
var% = (close[-1] − close[-1−N]) / close[-1−N] × 100        avec N = 10
```

`close[-1]` = dernière clôture, `close[-11]` = la clôture il y a 10 bougies. C'est le « capteur de
vitesse » : il mesure l'amplitude du mouvement déjà engagé.

### b) RSI(6) — confirmation de force

Implémentation **lissage de Wilder** classique :

```
premiers avgGain/avgLoss = moyenne simple des gains/pertes sur les 6 premiers changements
puis : avgGain = (avgGain×5 + gain)/6 ; avgLoss = (avgLoss×5 + perte)/6
RS = avgGain / avgLoss ; RSI = 100 − 100/(1+RS)   (100 si avgLoss = 0)
```

Un RSI(6) court réagit vite : il sert ici de **filtre de direction de la force**, pas de repère
de surachat/survente classique.

### c) Règles d'entrée (symétriques)

| Direction | Condition de variation | Condition RSI | Résultat |
|---|---|---|---|
| **LONG** | var% > **+0,55 %** | RSI > **52** | Ouvre un Long |
| **SHORT** | var% < **−0,55 %** | RSI < **48** | Ouvre un Short |

Interprétation : on exige à la fois une **amplitude** de mouvement (0,55 % sur 10 bougies, seuil
au-dessus du bruit normal du timeframe) et une **conviction directionnelle** du RSI (>52 côté
acheteur, <48 côté vendeur). La zone neutre 48–52 bloque les entrées timides.

⚠️ Une entrée n'est évaluée **que sur une nouvelle bougie clôturée** (§3). Le même signal répété
sur plusieurs cycles d'une même bougie ne déclenche rien de plus.

---

## 7. Étape 4 — Filtres avant ouverture

Avant d'envoyer quoi que ce soit, trois garde-fous :

1. **Une seule position par symbole.** Si une position est déjà ouverte sur la paire, aucun nouvel
   ordre (même sens opposé) — le bot attend la sortie.
2. **Cooldown de 5 minutes** entre deux trades sur le même symbole (mesuré depuis la dernière
   **fermeture**). Empêche de re-entrer immédiatement dans le mur après un stop, typique des
   rebonds post-SL.
3. **Paire active.** Une paire décochée du dashboard continue de gérer ses positions ouvertes
   (sorties uniquement) mais ne peut plus en ouvrir de nouvelles.

---

## 8. Étape 5 — Dimensionnement de la position (money management)

Quand un signal passe tous les filtres :

```
marge     = capital_actuel × riskPct/100          # 8 % du capital
levier    = min(leverage, maxLeverage)            # 10, plafonné à 12 (paper) / 5 (réel)
notional  = marge × levier                        # exposition ≈ 80 % du capital
quantité  = notional / prix_entrée                # en unité du contrat
```

Exemple : capital 1 000 $ → marge 80 $ → levier 10 → exposition ~800 $.

Nuance essentielle souvent mal comprise : le **risque réel par trade n'est pas 8 %**. Le SL est à
−1 % du *prix*, donc avec ×10 de levier la perte sur la marge est ~10 %, soit ~0,8 % du capital
(+ frais). Le « 8 % » désigne la **marge engagée**, pas la perte maximale.

---

## 9. Étape 6 — Ouverture de la position & journalisation

La position stocke : symbole, côté, prix d'entrée, quantité, marge, levier, notional, niveaux
TP/SL figés à l'ouverture, horodatage d'entrée (`openedAt`), éventuellement l'`orderId` réel.

Journal d'ouverture (type TRADE) :

```
Ouverture LONG BTC/USDT:USDT @ 81286.0000 | marge=73.36$ levier=10x expo=733.59$ | var=0.596% RSI=52.5
```

En mode réel, l'ordre MARKET est passé **avant** d'enregistrer la position (avec mise à jour du
levier, arrondi à la précision du marché) ; en cas d'échec d'exécution, aucune position n'est
créée et l'erreur est journalisée.

---

## 10. Étape 7 — PnL, frais et équité temps réel

### PnL d'une fermeture

```
brut LONG  = (sortie − entrée) × quantité
brut SHORT = (entrée − sortie) × quantité
frais      = (notional_entrée + valeur_notionnelle_sortie) × feePct/100   # taker ~0,04 %/jambe
net        = brut − frais
capital   += net
```

Le log affiche le détail : `PnL=-8.64$ (brut -8.00$, frais -0.64$)`. Ignorer les frais rendrait
une stratégie perdante invisible : avec SL à −1 % × 10 = −10 % de marge, ~0,8 % de frais
supplémentaires par aller-retour changent complètement l'espérance.

### Équité (graphique « Évolution de l'équité »)

```
equity = capital_réalisé + Σ PnL_latents_des_positions_ouvertes
PnL_latent(LONG)  = (prix_courant − entrée) × quantité
PnL_latent(SHORT) = (entrée − prix_courant) × quantité
```

**La marge d'une position ouverte n'est JAMAIS ajoutée à l'équité** : elle est déjà comprise dans
le capital (elle n'a pas été « dépensée », seulement immobilisée). Ajouter la marge était le bug
historique qui faisait sauter l'équité de +8 % à chaque ouverture. L'historique d'équité n'enregistre
un point que s'il varie réellement (> 0,005 $), avec une référence de départ (`startEquity`)
stabilisée au premier point pour éviter des paliers trompeurs après changement de capital/timeframe.

### Statistiques (tableau sous le journal)

Trades totaux, taux de réussite, **profit factor** (gains bruts ÷ pertes brutes), expectancy/trade,
max drawdown (pic creux sur la courbe d'équité), frais cumulés, slippage estimé (écart moyen
entre prix de clôture théorique et prix d'exécution), horodatage de mise à jour.

---

## 11. Paper trading vs trading réel

| | Paper (défaut) | Réel |
|---|---|---|
| Carnet | `TradingEngine` simulé | même moteur, branché sur un `LiveBroker` |
| Prix d'exécution | clôture dure de la bougie | ordre MARKET sur l'exchange |
| TP/SL | évalués au cycle, exécutés au prix exact du niveau | idem (polling) — ⚠️ pas de stop orders côté exchange |
| Frais | estimés (`feePct`) | facturés réellement par l'exchange |
| Levier | ≤ 12× | bridé ≤ 5× |
| Risque/trade | libre | plafonné ≤ 25 % |
| Activation | — | clés API saisies dans le panneau 🔐 (coffre AES-256-GCM, mot de passe maître) |

Le passage en réel refuse toute activation sans coffre déverrouillé et teste la connexion
(solde lu) avant de basculer. Revenir en paper verrouille le coffre.

---

## 12. Garde-fous et pièges corrigés

À connaître absolument si on portait cette stratégie ailleurs — chacun de ces bugs a fait perdre
de l'argent en simulation avant correction :

1. **Signaux sur bougie en cours de formation** → entrées sur des spikes fictifs, RSI 80–90 juste
   avant un retournement, SL en quelques minutes. Corrigé : clôtures dures + 1 entrée par nouvelle
   bougie close (détection par timestamp).
2. **Timeframe fantôme** (`3m` non servi par Binance, silencieusement remplacé par 1m) → la
   stratégie jouée n'était pas celle configurée. Corrigé : agrégation client explicite 1m→3m.
3. **Sorties évaluées trop tard / au mauvais prix** (fermeture à la clôture slippée au-delà du
   niveau, franchissement partiel ignoré) → pertes amplifiées. Corrigé : exécution au prix exact
   du TP/SL, priorité au SL sur bougie ambigüe.
4. **Frais ignorés** → stratégie gagnante sur le papier, ruinée en réalité. Corrigé : PnL net
   avec frais taker aller-retour.
5. **Marge ajoutée à l'équité** → courbe fausse, escaliers à chaque ouverture. Corrigé : équité =
   cash + PnL latent uniquement.
6. **Cooldown à 0** (dérive de config) → re-entrées instantanées dans le rebond post-stop.
   Corrigé : minimum 5 min, persisté proprement.
7. **Pas de CSRF/auth sur le dashboard** → n'importe qui sur le réseau pouvait piloter le bot.
   Corrigé : login, cookie HttpOnly signé, double-submit CSRF, anti-brute-force.

---

## 13. Paramètres modifiables via le dashboard

Panneau repliable « ⚙️ Paramètres du bot » — les champs sont générés depuis un schéma serveur,
validés côté serveur (bornes, entiers, cohérences croisées : RSI short < RSI long, cycle ≥ 20 s…
trailing < TP, levier ≤ 5× en réel…), puis persistés (`params.overrides.json`) et appliqués **à chaud** :

- 🪙 Marché & paires : cases à cocher (15 perps) + champ paire libre.
- 📡 Signal : variation min (%) , seuils RSI LONG/SHORT ; avancés : nb de bougies, période RSI.
- 💰 Money : risque (%), levier (×), capital simulé.
- 🎯 Sorties : Take Profit (%), Stop Loss (%), trailing stop, break-even.
- 🧪 Filtres : EMA tendance multi-timeframe, exposition totale max, heures de trade UTC.
- ⚙️ Exécution : timeframe, durée de cycle, cooldown, frais par jambe.
- 🔐 Mode : paper/réel, mode observation, stops côté exchange, clés API (panneau occultable séparé).

Un aperçu live calcule marge/exposition/gain TP/perte SL selon les valeurs en cours d'édition.
« ↺ Défauts » restaure la configuration d'origine.

📖 **Chaque paramètre est documenté en détail** (rôle, bornes, valeur par défaut, comment le régler,
interactions, recettes de configuration) dans **[PARAMETRES.md](PARAMETRES.md)**.

---

## 14. Rôle de chaque fichier

| Fichier | Rôle |
|---|---|
| `config.js` | Valeurs par défaut de la stratégie (timeframe, paires, seuils, sizing, TP/SL, cooldown, frais…). Source unique de vérité. |
| `params.js` | Schéma des paramètres éditables : types, bornes, groupes UI, validation d'un patch, cohérences croisées, garde-fous mode réel, persistance des overrides. |
| `indicators.js` | RSI(6) à lissage de Wilder et variation % sur N bougies. Pur JS, zéro dépendance, testable isolément. |
| `candles.js` | Assainissement des données : retrait de la bougie en cours, agrégation multi-timeframe (1m→3m…), table des durées de timeframe. |
| `engine.js` | `TradingEngine` : carnet de trading (papier par défaut). Dimensionnement, règles d'entrée/sortie, cooldown, PnL net avec frais, équité, historique, stats, hooks `onOpen`/`onClose`, `resetBook`. |
| `bot.js` | Orchestrateur : `MarketData`/`DemoMarket` (données), `LiveBroker` (ordres réels ccxt), `MomentumBot` (boucle `runCycle`/`processSymbol`), serveur Express + WebSocket, routes API sécurisées, authentification, tableau de bord statique. |
| `auth.js` | `AuthManager` : mot de passe (env `MOMBOT_PASSWORD` ou généré), hash scrypt, sessions cookie HttpOnly signées HMAC, CSRF double-submit, anti-brute-force, garde middleware HTTP/WS. |
| `secrets.js` | `SecretStore` : coffre chiffré AES-256-GCM des clés API (dérivation PBKDF2 du mot de passe maître), unlock/lock/erase, jamais de secret en clair côté client ou logs. |
| `public/index.html` | Dashboard SPA : graphique d'équité SVG avec tooltips au survol, cartes signaux par paire, positions ouvertes (barre SL→TP, durée live, fermeture manuelle), historique des trades (heure d'entrée + durée), tableau statistiques, panneau paramètres éditable repliable, panneau clés API occultable, pastille PAPER/LIVE, uptime, toasts. |
| `public/login.html` | Page de connexion au dashboard. |
| `test_strategy.js` | Suite de tests de la stratégie (54 cas) : formules RSI/variation, TP/SL exacts, frais, bougies closes, agrégation, cooldown, équité, validation des paramètres, auth/CSRF e2e. |
| `strategy.js` | Cœur de stratégie **pur** (shared live + backtest) : `entrySignal`, `checkExitBar`, `tpSlPrices`, `evaluateBar`. Aucune dépendance, aucun look-ahead. |
| `backtest.js` | Backtesteur CLI sur données historiques réelles (`node backtest.js --symbol … --days … --mode close\|intrabar`). |
| `alerts.js` | Notifications push Telegram / webhook générique, anti-spam 60 s, configurables depuis le dashboard. |
| `state.js` | Persistance atomique du carnet (`state.json` + `.bak`) : reprise après crash/redémarrage. |
| `package.json` | Dépendances (`express`, `ws`, `ccxt`) et scripts. |
| `README.md` | Installation, démarrage, sécurité, déploiement. |
| `STRATEGIE.md` | La stratégie et son fonctionnement détaillés de A à Z. |
| `PARAMETRES.md` | Guide de référence : chaque paramètre et chaque fonctionnalité expliqués + recettes. |
| `PROMPT_SKILL.md` | Prompt autonome pour reproduire le bot avec une autre IA. |
| *(générés)* `auth.json`, `secrets.json`, `params.overrides.json` | État local sensible — exclus de git par `.gitignore`. |

---

## Annexe A — Formules exactes

```text
Variation        : var% = (C[t] − C[t−10]) / C[t−10] × 100          (bougies closes)
RSI Wilder(6)    : G_i = max(C[i]−C[i−1], 0) ; L_i = max(C[i−1]−C[i], 0)
                   G̃_6 = moy(G_1..G_6) ; L̃_6 = moy(L_1..L_6)
                   G̃_i = (G̃_{i−1}×5 + G_i)/6  (idem pertes)
                   RSI = 100 − 100/(1 + G̃/L̃) ; 100 si L̃ = 0
Entrée LONG      : var% > +0,55  ET  RSI > 52   ET  nouvelle bougie close
Entrée SHORT     : var% < −0,55  ET  RSI < 48   ET  nouvelle bougie close
Marge            : M = capital × 0,08
Levier           : L = min(10, plafond[12 paper | 5 réel])
Notional         : N = M × L ; Quantité Q = N / prix_entrée
Prix TP          : P_e × (1 ± 0,028)   (+ LONG, − SHORT)
Prix SL          : P_e × (1 ∓ 0,010)   (− LONG, + SHORT)
PnL brut         : LONG (P_s − P_e)·Q ; SHORT (P_e − P_s)·Q
Frais aller-retour: (N + P_s·Q) × 0,0004
PnL net          : brut − frais ; capital ← capital + net
Équité           : capital + Σ PnL_latents (la marge n'y figure PAS)
Drawdown max     : max sur la courbe d'équité de (pic − valeur)/(pic) × 100
Profit factor    : Σ gains nets ÷ |Σ pertes nettes|
Expectancy       : PnL net total ÷ nombre de trades
```

Constantes : seuil variation 0,55 % · RSI 52/48 · lookback 10 bougies · RSI période 6 ·
risque 8 % · levier 10 (plafond 12/5) · TP +2,8 % · SL −1,0 % · cooldown 5 min ·
cycle 50 s · frais 0,04 %/jambe · capital initial 1 000 $.

---

## Annexe B — Exemple de trade chiffré pas à pas

Contexte : capital 1 000 $, timeframe 5m, paire AVAX/USDT, pas de position, cooldown expiré.

1. **14:05** — cycle : la dernière bougie 5m close est celle de 14:00. Timestamp nouveau →
   évaluation autorisée.
2. **Données** : clôture il y a 10 bougies (13:15) = 9,930 $ ; clôture 14:00 = 9,988 $.
   `var% = (9,988 − 9,930)/9,930 × 100 = +0,584 %` → dépasse +0,55 ✓.
   RSI(6) sur les 10 dernières clôtures = 55,6 → > 52 ✓. **Signal LONG.**
3. **Sizing** : marge = 1 000 × 8 % = 80 $ ; levier 10 ; notional = 800 $ ;
   quantité = 800 / 9,988 = 80,097 AVAX. Position ouverte @ 9,988 $.
   TP = 9,988 × 1,028 = 10,268 $ ; SL = 9,988 × 0,99 = 9,888 $.
4. **14:10** — clôture 10,05 $ : ni TP ni SL. Rien.
5. **14:20** — clôture 10,27 $ ≥ TP (10,268) → **fermeture au prix exact 10,268 $**.
   Brut = (10,268 − 9,988) × 80,097 = +22,43 $ ;
   Frais = (800 + 10,268×80,097) × 0,0004 ≈ 0,65 $ ; **Net = +21,78 $** ; capital = 1 021,78 $.
6. Cooldown armé jusqu'à 14:25 : même si un nouveau signal LONG apparaît à 14:22, pas d'entrée.

Variante perdante : clôture 9,88 $ ≤ SL → fermeture à 9,888 $ exactement, brut = −8,00 $,
frais ≈ 0,64 $, net ≈ −8,64 $ (≈ −0,86 % du capital), soit bien moins dramatique que le
« −10 % » apparent — c'est le sens du couple risque 8 % de marge / SL 1 % de prix.
