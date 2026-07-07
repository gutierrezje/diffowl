export interface LineItem {
  price: number;
  quantity: number;
}

export function invoiceTotal(lines: readonly LineItem[], taxRate: number): number {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const tax = subtotal * taxRate;
  return subtotal + tax;
}
