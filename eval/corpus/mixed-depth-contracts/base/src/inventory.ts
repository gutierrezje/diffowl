export interface InventoryGateway {
  reserve(sku: string, quantity: number): Promise<boolean>;
}

export class OutOfStockError extends Error {}

export async function reserveStock(
  inventory: InventoryGateway,
  sku: string,
  quantity: number,
): Promise<void> {
  const reserved = await inventory.reserve(sku, quantity);
  if (!reserved) {
    throw new OutOfStockError(`Could not reserve ${quantity} units of ${sku}.`);
  }
}
