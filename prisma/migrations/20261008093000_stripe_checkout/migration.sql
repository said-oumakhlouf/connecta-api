CREATE TYPE "PaymentStatus" AS ENUM ('LEGACY', 'UNPAID', 'PAID', 'EXPIRED');
ALTER TABLE "Order" ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN "checkoutKey" TEXT, ADD COLUMN "checkoutFingerprint" TEXT,
ADD COLUMN "checkoutSessionId" TEXT, ADD COLUMN "reservedUntil" TIMESTAMP(3), ADD COLUMN "paidAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Order_checkoutKey_key" ON "Order"("checkoutKey");
CREATE UNIQUE INDEX "Order_checkoutSessionId_key" ON "Order"("checkoutSessionId");
CREATE INDEX "Order_paymentStatus_reservedUntil_idx" ON "Order"("paymentStatus", "reservedUntil");
