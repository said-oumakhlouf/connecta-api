ALTER TABLE "Order" ADD COLUMN "checkoutIpHash" TEXT;
CREATE INDEX "Order_customerEmail_paymentStatus_idx" ON "Order"("customerEmail", "paymentStatus");
CREATE INDEX "Order_checkoutIpHash_createdAt_idx" ON "Order"("checkoutIpHash", "createdAt");
