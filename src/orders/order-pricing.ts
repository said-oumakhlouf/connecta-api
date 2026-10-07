export function calculateLinePrice(
  unitPrice: number,
  quantity: number,
  duoPrice: number | null,
) {
  const regularTotal = unitPrice * quantity;
  const pairPrice = Math.min(duoPrice ?? unitPrice * 2, unitPrice * 2);
  const lineTotal =
    Math.floor(quantity / 2) * pairPrice + (quantity % 2) * unitPrice;

  return { lineTotal, discount: regularTotal - lineTotal };
}
