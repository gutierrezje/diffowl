export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
}

export function paginate<T>(source: readonly T[], offset: number, pageSize: number): Page<T> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }
  const start = Math.max(0, offset);
  // Read one extra row so hasMore reflects the source without a second scan.
  const window = source.slice(start, start + pageSize + 1);
  const hasMore = window.length > pageSize;
  const items = hasMore ? window.slice(0, pageSize) : window;
  return {
    items,
    hasMore,
    nextOffset: hasMore ? start + pageSize : null,
  };
}

export function pageCount(totalItems: number, pageSize: number): number {
  if (totalItems <= 0) {
    return 0;
  }
  return Math.ceil(totalItems / pageSize);
}
