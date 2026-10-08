# CONNECTA API

Backend NestJS + Prisma 7 + PostgreSQL.

## Installation

Créer un fichier `.env` local (ne pas le committer) avec `DATABASE_URL`, puis :

```bash
npm ci
npm run prisma:generate
npx prisma migrate deploy
npm run start:dev
```

Le serveur écoute sur **http://localhost:3001** par défaut (`PORT` permet de le changer).
Le client Prisma est généré localement et ignoré par Git. `npm run build` le régénère automatiquement.

## Connexion du frontend

Les requêtes du navigateur sont autorisées depuis `http://localhost:3000` et
`http://127.0.0.1:3000` par défaut. Pour changer ces origines, définir
`CORS_ORIGINS` dans `.env` avec des adresses séparées par des virgules.
En production, renseigner l'origine HTTPS exacte du site CONNECTA puis redémarrer l'API.
Le frontend utilise sa propre variable `NEXT_PUBLIC_API_URL` pour joindre ce backend.

## Produits

- `GET /products` : produits actifs.
- `GET /products/:slug` : produit actif, ou `404`.

## Administration

Dans le `.env` du **backend**, ajouter `ADMIN_PASSWORD` avec un mot de passe privé
de **16 à 256 caractères**, puis redémarrer l'API. Aucun mot de passe par défaut
n'est fourni. Sans cette configuration, la connexion admin est désactivée (`503`).
Ne jamais committer ce mot de passe ni le placer dans une variable `NEXT_PUBLIC_*`.

Ouvrir **http://localhost:3000/admin** dans le frontend CONNECTA et se connecter.

- `POST /admin/login` avec `{ "password": "..." }` : session opaque valable 8 heures.
- `GET /admin/orders?page=1&limit=20` : commandes de la plus récente à la plus ancienne,
  coordonnées, statut et lignes historiques. Maximum 100 commandes par page.
- `POST /admin/orders/:id/status` avec `{ "status": "CONFIRMED" }` ou `{ "status": "CANCELLED" }` : traiter une commande.
- `GET /admin/analytics?month=2026-10` : bilan de toutes les commandes du mois (heure de Paris), montants en centimes.
- `GET /admin/products` : catalogue complet, y compris les produits inactifs.
- `POST /admin/products/:id/restock` avec `{ "quantity": 20 }` : **ajoute** 20 unités
  au stock existant, sans changer les tarifs ou l'état actif du produit.
- `POST /admin/logout` : invalide la session.

Toutes les routes sauf la connexion exigent `Authorization: Bearer <token>`.
Les réponses contenant les sessions, clients et produits admin utilisent `Cache-Control: no-store`.
Le frontend garde le token uniquement en mémoire : un rechargement demande une
nouvelle connexion. Le mot de passe est effacé du formulaire après connexion.
Les sessions et la limitation des tentatives sont en mémoire dans **une instance**
de l'API : un redémarrage invalide les sessions. Pour plusieurs instances, prévoir
un stockage de sessions et de limitation partagé avant ce changement d'architecture.
Cinq échecs de connexion par adresse entraînent un blocage jusqu'à la fin de la
fenêtre de 15 minutes. En production, utiliser HTTPS pour le site et l'API.

Les quantités de réapprovisionnement sont des entiers de 1 à 10 000. L'incrément
est atomique et conserve les commandes et ajouts de stock simultanés. Le stock ne
peut pas dépasser la limite entière de PostgreSQL (`409`). Un produit épuisé actif
redevient commandable dès qu'il reçoit du stock ; un produit inactif reste inactif.
Ne pas répéter automatiquement un ajout si la connexion est interrompue : actualiser
le stock pour vérifier le résultat avant de réessayer.

Les anciennes commandes (`paymentStatus: LEGACY`) restent traitées manuellement :
confirmation ou annulation avec restitution atomique du stock, une seule fois.
Une confirmation manuelle ne prouve aucun paiement pour ces commandes.
Pour Stripe, seul un paiement vérifié confirme la commande. Annuler une réservation
expire d'abord sa session Stripe. Une commande `PAID` refuse cette annulation :
le remboursement n'est pas encore implémenté.

## Bilan mensuel

Le bilan regroupe les commandes créées pendant le mois choisi, du premier jour
à minuit jusqu’au premier jour du mois suivant, en `Europe/Paris` (changements
d’heure compris). Il couvre toutes les commandes, indépendamment de la pagination.
Le mois est obligatoire au format `YYYY-MM` entre 2000 et 2099.

Les commandes `PENDING` et `CONFIRMED` contribuent au total, aux unités et au panier
moyen. Les commandes `CANCELLED` sont affichées séparément et exclues des totaux
et du classement. Une annulation recalcule le mois de création de la commande.
Ces sommes ne représentent ni des paiements encaissés ni un bénéfice.

Le classement regroupe les lignes par identifiant produit et les trie par quantité,
puis montant, puis identifiant. Les montants et remises viennent des lignes historiques,
avec le nom actuel du produit pour éviter de séparer un produit renommé. Les produits
inactifs ayant des commandes restent dans le classement. Les unités désignent les
quantités physiques : un Duo compte deux unités. Une transaction en lecture répétable
assure un bilan cohérent pendant les modifications concurrentes.

## Créer une ancienne commande de développement

`POST /orders` est réservé au développement sans clé Stripe configurée. Cette
route renvoie `503` en production ou dès que `STRIPE_SECRET_KEY` est renseigné.

```json
{
  "customerName": "Saïd",
  "customerEmail": "client@example.com",
  "items": [{ "productId": 1, "quantity": 2 }]
}
```

Réponse `201` : commande avec identifiant, statut `PENDING`, montant total et lignes.
Les quantités sont des entiers de 1 à 100, avec au maximum 100 lignes.
Les lignes répétées sont regroupées (maximum 100 unités par produit).

Les montants sont des entiers **en centimes** : `3500 = 35 €`.
Vérifier cette convention pour les produits déjà présents en base : aucune migration ne convertit leurs prix.
Le serveur calcule le montant depuis `Product.price` et `Product.duoPrice`.
L'offre Duo s'applique automatiquement à chaque paire du même produit, après regroupement des lignes répétées.
Pour le Hoco EW75 : **1 = 35 €, 2 = 60 €, 3 = 95 €, 4 = 120 €**.
Le stock diminue du nombre réel d'écouteurs commandés, soit deux unités par Duo.

La migration active `duoPrice: 6000` sur le produit existant dont le slug est `hoco-ew75`.
Les autres produits gardent `duoPrice: null` et leur tarif normal.
Pour un Hoco ajouté après la migration, renseigner `duoPrice: 6000` en base pour activer l'offre.
Une offre plus chère que deux unités au tarif normal est ignorée.

Chaque ligne conserve le nom, le prix unitaire normal (`unitPrice`), la remise totale (`discount`) et le montant après remise (`lineTotal`).
Pour deux Hoco : `unitPrice: 3500`, `discount: 1000`, `lineTotal: 6000`.
Ces montants restent inchangés si le tarif ou l'offre du produit évolue ensuite.
Les commandes créées avant cette migration conservent leurs montants avec `discount: 0`.

La création et le retrait du stock se font dans une transaction.
Un décrément conditionné par le stock disponible empêche de vendre un stock négatif, même avec plusieurs commandes simultanées.
Si une ligne échoue, les autres décréments sont annulés et aucune commande n'est créée.

- `400` : données invalides, quantité excessive, prix/total fourni par le client.
- `404` : produit absent ou inactif.
- `409` : stock insuffisant ou produit modifié pendant la commande.

Cette route de développement enregistre une commande LEGACY sans paiement et retire
immédiatement les quantités du stock. Elle ne bénéficie pas des réservations
temporaires Stripe. Ne pas l'utiliser pour une vente réelle.

## Vérifications

```bash
npm run build
npm run lint
npm test
```

Pour les tests HTTP et PostgreSQL, utiliser une **base de test séparée**.
Sous bash :

```bash
export TEST_DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/connecta_test"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm run test:e2e
```

Sans `TEST_DATABASE_URL`, les tests e2e sont ignorés.
GitHub Actions exécute les migrations et tous les tests avec PostgreSQL 17,
y compris cinq commandes concurrentes pour le dernier exemplaire en stock.


## Stripe Checkout — mode test

Cette première intégration refuse les clés `sk_live_` et les sessions réelles.
Elle ne débite pas d'argent réel. La livraison facturée et les remboursements
restent à développer avant d'activer des ventes réelles.

Après récupération du code :

```bash
npm ci
npx prisma migrate deploy
```

La migration préserve les commandes existantes et les marque `LEGACY`.
Configurer le `.env` du backend, jamais une variable `NEXT_PUBLIC_*` :

```dotenv
STRIPE_SECRET_KEY=sk_test_votre_cle_privee_de_test
STRIPE_WEBHOOK_SECRET=whsec_secret_fourni_par_stripe
CHECKOUT_SITE_URL=http://localhost:3000
```

Utiliser la clé privée d'un environnement de test Stripe. En local, installer
[Stripe CLI](https://docs.stripe.com/stripe-cli), puis dans un terminal séparé :

```bash
stripe login
stripe listen --forward-to localhost:3001/payments/webhook
```

Copier le secret `whsec_...` affiché par cette commande dans `.env`, puis redémarrer
le backend. Laisser le terminal d'écoute ouvert. Le secret du CLI est différent
de celui d'un endpoint configuré dans le Dashboard. Aucun secret ne va dans le front.
Les tests automatisés simulent Stripe ; un essai Checkout dans votre environnement
Stripe reste nécessaire après configuration.

- `POST /payments/checkout` : corps de commande + `checkoutKey` UUID v4. Les quantités
  identiques sont regroupées, les prix sont calculés en base. Une même tentative
  avec le même contenu réutilise sa commande et sa session. Un contenu différent
  avec la même clé est refusé. Dix nouvelles tentatives par IP sur 15 minutes.
- `GET /payments/checkout/:sessionId` : statut minimal sans coordonnées client ;
  une session en attente est revérifiée auprès de Stripe. Le retour navigateur
  ne constitue jamais une preuve de paiement.
- `POST /payments/checkout/:sessionId/cancel` : expire une session ouverte avant
  de remettre le stock. En cas d'incertitude réseau, le stock reste réservé.
- `POST /payments/webhook` : corps brut et signature Stripe vérifiée. Les événements
  répétés et reçus dans le désordre sont traités à partir de l'état actuel Stripe.
  Le montant, la devise et l'identifiant de commande doivent correspondre en base.

États : `UNPAID` réserve le stock, `PAID` confirme, `EXPIRED` annule et restitue
une seule fois. La session expire après environ 31 minutes. Le webhook d'expiration
ou le contrôle périodique restitue le stock ; l'API doit rester allumée et pouvoir
joindre Stripe. Elle vérifie aussi les réservations échues au démarrage. Un paiement
vérifié gagne sur une demande d'annulation : une commande payée conserve son stock
consommé et ne peut pas être annulée sans remboursement.

Checkout collecte l'adresse de livraison française dans Stripe. Elle est consultable
dans le Dashboard Stripe et n'est pas encore copiée dans la base CONNECTA. Le bilan
mensuel conserve sa définition : commandes en attente et confirmées, anciennes et
de test, hors annulées. Il ne représente pas des encaissements réels.
