// Only a dedicated PostgreSQL TEST database is allowed. Never point this at production.
import pg from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required; refusing to seed.');
const target = new URL(connectionString);
const database = decodeURIComponent(target.pathname.slice(1));
if (!database.endsWith('_test') || connectionString === process.env.DATABASE_URL) {
  throw new Error('Refusing to seed a non-test database. Use a separate *_test database.');
}
const client = new pg.Client({ connectionString });
await client.connect();
try {
  // Additive and idempotent: do not overwrite changed test stock or real products.
  const result = await client.query(`
    INSERT INTO "Product" ("name", "slug", "price", "stock", "active", "createdAt", "updatedAt")
    VALUES
      ('CONNECTA Câble USB-C (TEST)', 'connecta-cable-usb-c-test', 990, 20, true, NOW(), NOW()),
      ('CONNECTA Chargeur 20W (TEST)', 'connecta-chargeur-20w-test', 1990, 15, true, NOW(), NOW())
    ON CONFLICT ("slug") DO NOTHING
    RETURNING "slug"
  `);
  console.log(`Test catalogue ready: ${result.rowCount} new product(s).`);
} finally {
  await client.end();
}
