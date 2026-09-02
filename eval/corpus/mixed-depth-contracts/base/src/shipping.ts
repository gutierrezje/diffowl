export function shippingFeeCents(subtotalCents: number): number {
  if (subtotalCents >= 5_000) {
    return 0;
  }
  return 799;
}
