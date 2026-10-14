# CONNECTA — catalogue multi-produits (test uniquement)

Cette branche conserve les parcours existants (Solo/Duo, comptes membres, livraison, administration) et prépare la boutique multi-références. **Aucune migration de schéma n'est nécessaire** : `Product`, `OrderItem` et `Order` supportent déjà des commandes mixtes.

## Préparer la base isolée
Utiliser une base PostgreSQL **distincte** finissant par `_test` (par exemple `connecta_multi_test`). Ne jamais utiliser les identifiants de production.

```bash
export TEST_DATABASE_URL='postgresql://connecta:motdepasse@localhost:5432/connecta_multi_test'
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm run seed:multi-products:test
```

La commande de seed refuse l'absence de `TEST_DATABASE_URL`, une base dont le nom ne finit pas par `_test`, ou une URL identique à `DATABASE_URL`. Elle n'ajoute les produits qu'une fois, sans écraser leur stock.

| Référence | Slug | Prix | Stock initial |
| --- | --- | ---: | ---: |
| CONNECTA Câble USB-C (TEST) | `connecta-cable-usb-c-test` | 9,90 € | 20 |
| CONNECTA Chargeur 20W (TEST) | `connecta-chargeur-20w-test` | 19,90 € | 15 |

Il faut également que le produit Hoco EW75 existe dans cette **base de test**, avec le slug `hoco-ew75`. Les deux références sont fictives, sans images commerciales : le frontend affiche des pictogrammes.

## Tests automatisés
```bash
npm run build
npm test
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:e2e
```

Les tests e2e Stripe utilisent un client **simulé**, des webhooks signés de test et la base `TEST_DATABASE_URL`. Ils vérifient un panier Hoco ×2 + câble ×1 + chargeur ×1 = **89,80 € hors livraison** (sous la configuration frais de port à zéro du banc de tests), trois lignes Stripe, trois stocks séparés, paiement idempotent, et restitution de stock après annulation d'une réservation mixte.

## Essai navigateur à exécuter avant fusion
Démarrer l'API sur la base de test, avec `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` et une adresse de retour locale. Utiliser un frontend de la branche `feat/multi-products-test` avec `NEXT_PUBLIC_API_URL` dirigé vers cette API de test.

Vérifier la route `/boutique`, l'offre Hoco Duo, les références fictives, les frais de livraison selon destination, la limite de 10 articles, les ruptures de stock, la reprise de réservation et le retour de paiement `PAID`. Ne jamais remplacer `sk_test_` par une clé réelle, et ne pas déployer les produits fictifs en production.
