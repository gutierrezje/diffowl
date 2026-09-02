import { OutOfStockError, reserveStock, type InventoryGateway } from "./inventory.js";

export interface PaymentGateway {
  charge(customerId: string, amountCents: number): Promise<string>;
}

export type CheckoutResult = { kind: "placed"; paymentId: string } | { kind: "out-of-stock" };

export async function checkout(
  inventory: InventoryGateway,
  payments: PaymentGateway,
  customerId: string,
  sku: string,
  quantity: number,
  amountCents: number,
): Promise<CheckoutResult> {
  try {
    await reserveStock(inventory, sku, quantity);
  } catch (error) {
    if (error instanceof OutOfStockError) {
      return { kind: "out-of-stock" };
    }
    throw error;
  }

  const paymentId = await payments.charge(customerId, amountCents);
  return { kind: "placed", paymentId };
}
