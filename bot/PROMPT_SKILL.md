# PROMPT SKILL — Reproduire momBot avec une autre IA

Copier-coller le bloc ci-dessous dans n'importe quelle IA capable de générer du code.
Il est autonome : toutes les règles y sont incluses, sans dépendre d'un fichier existant.
Deux versions : **A) prompt complet** (bot entier, dashboard inclus) et **B) prompt minimal**
(cœur stratégie seul, pour un backtest rapide).

---

## Version A — Prompt complet (bot Node.js + dashboard)

```text
Tu es un développeur expert en trading algorithmique JavaScript/Node.js. Développe un bot de
trading complet appelé « momBot » avec dashboard web, en respectant EXACTEMENT la stratégie et
les contraintes ci-dessous. Langage : JavaScript (Node.js ≥ 18), dépendances limitées à express,
ws et ccxt. Architecture modulaire en CommonJS (require/module.exports), un fichier par
responsabilité, testable sans réseau.

════════ STRATÉGIE (à implémenter au pixel près) ════════
Marché : perpetuals USDT d'un exchange crypto via ccxt (Binance par défaut). Format symboles
« BASE/USDT:USDT ». Paires par défaut : BTC, ETH, SOL, AVAX, SUI /USDT. Timeframe par défaut 5m,
choix possible 1m, 3m, 5m, 15m, 30m, 1h, 4h. Capital simulé de départ : 1000 $. Une seule position
max par symbole, LONG et SHORT.

Signal d'entrée (momentum confirmé par RSI), évalué UNIQUEMENT sur des bougies CLÔTURÉES :
- Récupérer ~60 bougies du timeframe ; RETIRER SYSTÉMATIQUEMENT la dernière bougie (en cours de
  formation, non close). Tout calcul se fait sur les clôtures dures des bougies closes.
- variation% = (close[-1] - close[-1-10]) / close[-1-10] × 100  (sur les 10 dernières bougies closes)
- RSI(6) à lissage de Wilder sur les clôtures closes : premières moyennes = moyenne simple des
  gains/pertes sur les 6 premiers changements, puis avgGain=(avgGain×5+gain)/6, idem pertes,
  RSI = 100 − 100/(1+RS), 100 si avgLoss=0.
- LONG si variation > +0,55 % ET RSI > 52. SHORT si variation < −0,55 % ET RSI < 48.
- Une entrée ne peut être déclenchée QU'UNE SEULE FOIS par nouvelle bougie clôturée : mémoriser le
  timestamp de la dernière bougie traitée par symbole et ignorer les cycles suivants tant que le
  timestamp ne change pas. (Sinon le bot re-trade le même spike artificiellement.)
- Si le timeframe demandé n'est pas nativement servi par l'exchange (ex. 3m chez Binance),
  télécharger les bougies 1m et les AGRÉGER côté client en buckets alignés floor(time/tfMs),
  en retirant le dernier bucket incomplet. Ne JAMAIS substituer silencieusement un autre timeframe.

Dimensionnement (money management) :
- marge = capital_actuel × 8 % ; levier = min(10, plafond 12 en paper, 5 en mode réel) ;
  notional = marge × levier ; quantité = notional / prix d'entrée.

Sorties (TP/SL fixes, pas de trailing), vérifiées À CHAQUE CYCLE AVANT toute recherche d'entrée :
- prix_TP = entrée × (1 ± takeProfitPct/100) avec +2,8 % pour LONG, −2,8 % pour SHORT ;
  prix_SL = entrée × (1 ∓ stopLossPct/100) avec −1,0 % pour LONG, +1,0 % pour SHORT.
- Fermer dès que la dernière clôture franchit un niveau ; SI LES DEUX SONT FRANCHIS SUR LA MÊME
  BOUGIE, priorité au STOP LOSS (hypothèse du pire chemin intra-bougie).
- Exécuter la fermeture AU PRIX EXACT DU NIVEAU TP/SL (comme un ordre conditionnel), jamais à la
  clôture slippée au-delà.

Règles supplémentaires :
- Cooldown : minimum 5 minutes entre deux trades sur le même symbole (décomposé depuis la
  dernière fermeture). Aucune ouverture pendant le cooldown.
- Impossible d'ouvrir sur un symbole ayant déjà une position ouverte.
- Frais taker estimés : 0,04 % par jambe. PnL NET = PnL brut − frais sur les deux jambes
  ((notional_entrée + valeur_sortie) × 0,0004). Toujours journaliser brut et net séparément.

Équité temps réel (graphique) :
- equity = capital réalisé + Σ PnL latents des positions ouvertes. La MARGE immobilisée n'est
  JAMAIS ajoutée (elle est déjà dans le capital). Enregistrer un point d'historique seulement si
  l'équité varie (>0,005 $), avec une référence de départ figée au premier point (startEquity)
  pour éviter des paliers trompeurs après changement de capital ou redémarrage.

════════ ARCHITECTURE FICHIERS ════════
- config.js        : toutes les valeurs par défaut ci-dessus (source unique de vérité).
- indicators.js    : rsi(closes, period) Wilder + priceChangePct(candles, lookback). Pur JS.
- candles.js       : closedCandles() (retire la bougie en cours) + aggregate(candles, fromMs,
                     toMs) (buckets alignés, retire le bucket en cours) + table TF_MS.
- engine.js        : classe TradingEngine — carnet papier : computePositionSize(), canOpen()
                     (position unique + cooldown), openPosition()/closePosition() avec hooks
                     async onOpen/onClose (branchables sur un broker réel), checkExit(pos, close)
                     retournant {kind:'TP'|'SL', price} au prix exact du niveau, tpSlPrices(),
                     equity(prices) SANS marges, historique + recordEquity + rebuildEquityHistory,
                     stats() (nb trades, win rate, profit factor, expectancy, max drawdown %,
                     frais cumulés, slippage estimé), log circulaire, resetBook().
                     Chaque trade enregistré contient openedAt, closedAt, durationMs.
- params.js        : schéma des paramètres éditables (types, bornes, unités, groupes UI, champs
                     avancés) + validatePatch() (bornes, entiers, cohérences croisées : RSI short
                     < RSI long, cycle ≥ 20 s, liste de symboles normalisée « BASE/USDT:USDT »,
                     1 à 20 paires, garde-fous mode réel levier ≤ 5 / risque ≤ 25 %) + persistance
                     JSON des overrides + reset aux défauts.
- auth.js          : AuthManager — mot de passe via env MOMBOT_PASSWORD sinon GÉNÉRÉ aléatoirement
                     et affiché une seule fois en console (hash scrypt dans auth.json, PAS de mot
                     de passe par défaut codé en dur) ; login POST /api/login avec anti-brute-force
                     (verrou temporaire après 10 échecs) ; session cookie HttpOnly SameSite=Lax
                     signé HMAC, TTL 7 j ; CSRF double-submit (cookie + header X-CSRF-Token exigé
                     sur tous les POST/DELETE) ; middleware requireAuth HTTP + vérification WS
                     (fermeture code 4401 si non authentifié) ; route /login HTML.
- secrets.js       : SecretStore — coffre local chiffré AES-256-GCM des clés API (dérivation PBKDF2
                     150k itérations du mot de passe maître, IV aléatoire, tag vérifié). set/unlock/
                     lock/erase/configured/status. Le secret n'est JAMAIS renvoyé au client ni écrit
                     en clair dans un fichier ou un log ; le mot de passe maître n'est pas stocké
                     (irrécupérable). Support optionnel par variables d'env.
- bot.js           : orchestrateur — MarketData (ccxt fetchOHLCV + agrégation si besoin) et
                     DemoMarket (séries synthétiques plausibles hors-ligne, --demo) ; LiveBroker
                     (ordres MARKET réels : setDefaultLeverage, amountToPrecision, reduceOnly à la
                     sortie, prix d'exécution réel lu sur l'ordre, échec ⇒ pas de position) ;
                     MomentumBot (boucle setInterval(cycleMs) → runCycle → processSymbol avec
                     l'ORDRE STRICT : sorties d'abord, signal ensuite, gated par nouveau timestamp
                     de bougie) ; serveur Express : statiques public/, GET /api/state (snapshot :
                     running, paused, uptimeMs hors pauses, mode paper|real, capital, équité,
                     startEquity, signaux par symbole {changePct, rsi, price}, positions ouvertes
                     avec openedAt/durée live, trades avec heure entrée/sortie/durée, logs),
                     POST /api/start|pause|resume|stop|closeall|close/:symbol, POST /api/params
                     (patch validé, appliqué à chaud : timer redémarré si cycle changé, TP/SL
                     recalculés sur positions ouvertes, symboles filtrés — les positions des paires
                     décochées restent gérées jusqu'à leur sortie), POST /api/reset-params, routes
                     /api/keys/* (set avec validation sur l'exchange avant enregistrement, unlock,
                     lock, erase, test affichant le solde, status), WebSocket push du snapshot à
                     chaque changement ; app.use(auth.requireAuth()) PUIS app.use(auth.requireCsrf())
                     — attention : requireCsrf doit être une FABRIQUE de middleware retournant une
                     closure liée à l'instance (un `app.use(auth.requireCsrf)` non appelé casse
                     TOUS les boutons avec un 500 silencieux). Bot arrêté ⇒ plus aucun ordre mais
                     positions conservées dans l'état.
- public/index.html : dashboard SPA sombre premium (une seule page, vanilla JS) connecté en WS +
                     REST, protégé par redirection /login sur 401 :
                     • Header : logo monogramme, statut (running/paused/stopped), pastille 🧪 PAPER
                       / 🔴 LIVE, pillule uptime ⏱ (temps de pause décompté, recompte à zéro au
                       restart), bouton déconnexion.
                     • KPI : capital, équité, PnL latent, nb positions.
                     • Graphique SVG « Évolution de l'équité » : courbe lisible + TOOLTIP AU SURVOL
                       affichant heure, équité, delta vs départ (% et $).
                     • Cartes « Signaux en direct » par paire : variation %, RSI, état LONG/SHORT
                       actif mis en évidence, badge position, chip countdown cooldown.
                     • Positions ouvertes : symbole, côté, entrée, prix courant, PnL latent, barre
                       SL→TP avec marker, heure d'entrée, DURÉE LIVE rafraîchie chaque seconde,
                       bouton « Fermer ».
                     • Historique des trades : colonnes Clôturé | Entrée (heure) | Durée (format
                       humain « 4 min 12 s ») | Symbole | Côté | Entrée | Sortie | Raison (TP/SL/
                       MANUAL) | PnL net (+ détail brut/frais).
                     • Journal d'événements horodaté (TRADE/WARN/INFO/ERROR).
                     • Tableau « Statistiques » sous le journal : Trades, Profit factor, Expectancy/
                       trade, Max drawdown, Frais cumulés, Slippage estimé, Mise à jour — repliable
                       avec résumé chips quand fermé.
                     • Panneau « ⚙️ Paramètres du bot » REPLIABLE (chevron animé, état mémorisé en
                       localStorage, ligne de résumé des valeurs clés + badge « n modif. non
                       appliquée(s) » visible quand replié) : formulaire GÉNÉRÉ depuis le schéma
                       serveur, grouped par sections (🪙 Marché & paires avec cases à cocher +
                       champ paire libre, 📡 Signal, 💰 Money, 🎯 Sorties, ⚙️ Exécution), boutons
                       Appliquer / ↺ Défauts, aperçu live marge/exposition/gain TP/perte SL,
                       erreurs de validation affichées en rouge. Un clic sur un bouton de l'en-tête
                       ne doit PAS déclencher le repli (e.target.closest).
                     • Panneau « 🔐 Clés API & sécurité » OCCULTABLE : quand il est replié, RIEN
                       des champs (clé API, secret, mot de passe maître, confirmation, bouton
                       enregistrer) ni de l'état sensible n'est affiché — utiliser display:none
                       avec !important sur tout le corps (attention : un style inline display:grid
                       écrase une règle CSS sans !important → bug classique où le contenu reste
                       visible). Boutons tester connexion / activer RÉEL (double confirmation) /
                       revenir en paper / verrouiller / effacer.
                     • Toasts de succès/erreur sur TOUTES les actions (un POST qui échoue ne doit
                       jamais rester silencieux).
                     • Sélecteur de timeframe segmenté au-dessus du graphique ; changer de timeframe
                       reconstruit proprement l'historique d'équité.
- test_strategy.js : suite de tests assertifs exécutables hors-ligne (~50 cas) : formules RSI
                     (valeurs connues, avgLoss nul ⇒ 100), variation sur 10 bougies, TP/SL déclenchés
                     aux niveaux exacts, priorité SL sur bougie ambigüe, frais nets, cooldown, position
                     unique, équité SANS marges, gate « une entrée par bougie close », agrégation
                     1m→3m, validation des patches (bornes, cohérences, symboles), e2e HTTP : 401 sans
                     login, 403 sans CSRF, start/pause/resume/stop/closeall répondent 200 (prévenir
                     les régressions type « bouton mort »).
- README.md        : installation (npm install OBLIGATOIRE avant premier lancement — exprès à
                     mentionner car « Cannot find module 'express' » est l'erreur n°1 des
                     utilisateurs), démarrage (--demo sans réseau ; MOMBOT_PASSWORD=... node bot.js),
                     mot de passe (aucun par défaut : soit env, soit généré et affiché une fois ;
                     oublié ⇒ supprimer auth.json), sécurité clés API (créer une clé SANS droit de
                     retrait), checklist prod (HTTPS/reverse proxy, pm2/systemd, limitation TP/SL par
                     polling : si le process meurt il n'y a pas de stop côté exchange → prévoir des
                     STOP_MARKET/OCO manuels ou améliorés), rôle de chaque fichier.
- .gitignore       : node_modules/, *.log, auth.json, secrets.json, params.overrides.json, .env.

════════ COMMANDES ════════
node bot.js            → mode réel possible (données live ccxt, trading paper par défaut)
node bot.js --demo     → données synthétiques, fonctionne sans internet
node test_strategy.js  → tests
Dashboard sur http://localhost:3000.

════════ CONTRAINTES DE QUALITÉ (non négociables) ════════
1. Ne jamais calculer un signal sur une bougie non close ; ne jamais entrer deux fois sur la même
   bougie clôturée. (Ces deux bugs transforment une stratégie momentum en machine à pertes : entrées
   sur spikes fictifs à RSI extrême puis stops en cascade.)
2. Toujours honorer le timeframe demandé (agrégation cliente si l'exchange ne le sert pas).
3. Sorties avant entrées dans chaque cycle ; priorité au SL ; exécution au prix exact du niveau.
4. Compter les frais partout (PnL net), sinon la simulation ment.
5. Équité = cash + PnL latent uniquement (jamais la marge).
6. Dashboard authentifié (session + CSRF) AVANT toute exposition réseau ; clés API chiffrées au
   repos, jamais exposées côté client ; en mode réel, lever plafonné à 5× et risque ≤ 25 %.
7. Toute action UI (start/pause/stop/paramètres/fermetures) doit produire un feedback visible
   (toast) et le middleware CSRF doit être branché en fabrique — vérifier par un test e2e que les
   boutons répondent réellement 200.
8. Livrer les fichiers complets, fonctionnels du premier coup, avec les tests.
```

---

## Version B — Prompt minimal (cœur stratégie, sans dashboard)

```text
Écris en JavaScript pur (Node.js, aucune dépendance) un module de signaux + moteur de paper
trading pour cette stratégie momentum, avec ses tests unitaires :

SIGNAL (bougies closes uniquement — retirer la dernière bougie en cours de formation) :
- var% = (close[-1] − close[-1−10]) / close[-1−10] × 100
- RSI(6) lissage Wilder
- LONG si var% > +0,55 ET RSI > 52 ; SHORT si var% < −0,55 ET RSI < 48
- max 1 évaluation d'entrée par nouvelle bougie clôturée (gate par timestamp)

POSITION : marge = capital × 8 %, levier 10 (plafond 12), notional = marge × levier,
quantité = notional / prix. Max 1 position/symbole, cooldown 5 min après chaque fermeture.

SORTIES : TP +2,8 % / SL −1,0 % du prix d'entrée, vérifiés à chaque clôture AVANT les entrées ;
si les deux sont franchis sur la même bougie, appliquer le SL ; exécuter au prix exact du niveau.

COMPTABILITÉ : PnL net = brut − frais taker 0,04 %/jambe sur les deux notionnels ;
équité = capital + Σ PnL latents (jamais la marge) ; stats : win rate, profit factor,
expectancy, max drawdown. Fournir rsi(), priceChangePct(), closedCandles() et une classe
TradingEngine avec openPosition/closePosition/canOpen/checkExit/equity/stats, plus les tests
assertifs des cas limites (avgLoss=0, double franchissement TP+SL, cooldown, équité stable
lors d'une ouverture).
```

---

## Conseils d'utilisation du prompt

- **Génère d'abord la Version B** et fais tourner les tests : c'est le cœur logique, il doit être
  prouvé correct avant l'interface.
- Puis donne la Version A en précisant « réutilise exactement les modules indicators/candles/engine
  validés précédemment » pour éviter que l'IA réinvente des variantes fausses des formules.
- Fais systématiquement relire par l'IA la section « CONTRAINTES DE QUALITÉ » en fin de génération :
  demande explicitement « montre-moi la ligne qui empêche une deuxième entrée sur la même bougie
  clôturée » — c'est le piège n°1 de cette stratégie.
- Si tu changes un seuil (ex. TP 3,5 %), ajuste le ratio gain/risque : la stratégie vit de son
  asymétrie ~1:2,8 ; un TP trop proche du SL annule l'avantage statistique.
