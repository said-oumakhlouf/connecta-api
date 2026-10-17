-- Optional fields, preserving existing products and orders.
ALTER TABLE "Product" ADD COLUMN "description" TEXT;
ALTER TABLE "Product" ADD COLUMN "imageUrl" TEXT;
