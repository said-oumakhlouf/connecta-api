CREATE TYPE "FulfillmentStatus" AS ENUM ('UNFULFILLED', 'PREPARING', 'SHIPPED', 'DELIVERED');
ALTER TABLE "Order"
  ADD COLUMN "shippingAddress" JSONB,
  ADD COLUMN "shippingFee" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'UNFULFILLED',
  ADD COLUMN "trackingCarrier" TEXT,
  ADD COLUMN "trackingNumber" TEXT,
  ADD COLUMN "shippedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD CONSTRAINT "Order_shippingFee_check" CHECK ("shippingFee" >= 0 AND "shippingFee" <= "total");
