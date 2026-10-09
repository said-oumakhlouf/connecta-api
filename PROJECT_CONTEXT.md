# CONNECTA API — contexte court pour ChatGPT Work

## Projet
- Backend du site `said-oumakhlouf/connecta`.
- Stack : NestJS 12, TypeScript, Prisma 7, PostgreSQL ; API locale généralement sur le port 3001.
- Modules présents : `products`, `orders`, `admin`, `payments`, `members` dans `src/`.

## État constaté dans le dépôt
- Produits : `GET /products`, `GET /products/:slug` ; administration des commandes, stock et statistiques.
- Commandes : montants calculés côté serveur, prix en centimes, remise Duo et stock transactionnel.
- Stripe Checkout **en test uniquement** : réservation `UNPAID`, validation de paiement `PAID` via Stripe, expiration `EXPIRED` ; ne jamais confirmer sur simple retour navigateur.
- Ancien `POST /orders` sans paiement réservé au développement ; anciennes commandes `LEGACY`.
- Membres : connexion par lien email, sessions et historique des commandes vérifiées (voir `README.md`).
- Limite panier : 10 unités physiques ; réservation et restitution de stock à préserver.
- Modèles et migrations : `prisma/schema.prisma` et `prisma/migrations/`.
- Secrets (`DATABASE_URL`, Stripe, admin, envoi email) : seulement dans `.env` local, jamais dans Git ni dans le frontend.

## Commandes
- Développement : `npm run start:dev` ; génération : `npm run prisma:generate`.
- Vérifications : `npm run build`, `npm run lint`, `npm test`.
- Tests e2e : `npm run test:e2e` avec **base PostgreSQL de test séparée**, jamais la base de production.

## Consignes Work
- Une fonctionnalité par tâche ; lire ce résumé, puis seulement les modules concernés.
- Préserver la logique de paiement vérifié, l'idempotence, les limites et les transactions de stock.
- Pas de migration destructive, refactor global ou changement d'API hors demande explicite.
- Finir par : fichiers changés, tests exécutés, limites et prochaine étape (5 lignes maximum).
- Mettre à jour ce résumé si l'architecture ou l'état livré change réellement.
