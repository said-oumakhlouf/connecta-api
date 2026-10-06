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

## Produits

- `GET /products` : produits actifs.
- `GET /products/:slug` : produit actif, ou `404`.

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
Le serveur calcule le montant depuis `Product.price` et conserve le nom et le prix au moment de la commande.
Pour le moment, le montant est le prix unitaire multiplié par la quantité :
**l'offre Duo à 60 € n'est pas encore appliquée par cette API**.

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
