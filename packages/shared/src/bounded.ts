/** Insertion-ordered set that forgets its oldest entries beyond `limit`. */
export class BoundedSet<T> {
  private readonly items = new Set<T>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  has(value: T): boolean {
    return this.items.has(value);
  }

  /** Returns false if the value was already present. */
  add(value: T): boolean {
    if (this.items.has(value)) return false;
    this.items.add(value);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}

/** Fixed-capacity array that drops the oldest entries. */
export function pushBounded<T>(list: readonly T[], item: T, limit: number): T[] {
  const next = list.length >= limit ? list.slice(list.length - limit + 1) : list.slice();
  next.push(item);
  return next;
}
