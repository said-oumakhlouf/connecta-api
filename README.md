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

Cette version permet de consulter les statuts ; elle ne les modifie pas et n'annule
pas les commandes. Les commandes de test existantes restent visibles.

## Créer une commande

`POST /orders`

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

Cette étape enregistre une commande sans paiement et retire immédiatement les quantités du stock.
Les transitions de statut, l'annulation avec restitution du stock, la livraison et la protection contre une soumission répétée restent à implémenter.
Aucune route publique de consultation des commandes n'est exposée.

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
