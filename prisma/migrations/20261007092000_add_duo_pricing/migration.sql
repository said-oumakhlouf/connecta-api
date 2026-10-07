-- Duo offers are opt-in for each product; amounts are in cents.
ALTER TABLE "Product" ADD COLUMN "duoPrice" INTEGER;
ALTER TABLE "Product" ADD CONSTRAINT "Product_duo_price_nonnegative"
    CHECK ("duoPrice" IS NULL OR "duoPrice" >= 0);

-- Activate the 60 EUR offer on the existing Hoco EW75 only.
UPDATE "Product"
SET "duoPrice" = 6000, "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'hoco-ew75';

-- Existing order lines keep their original prices and totals.
ALTER TABLE "OrderItem" ADD COLUMN "discount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_line_total_valid";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_discount_valid"
    CHECK ("discount" >= 0 AND "discount"::bigint <= "unitPrice"::bigint * "quantity");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_line_total_valid"
    CHECK ("lineTotal"::bigint = "unitPrice"::bigint * "quantity" - "discount"::bigint);
