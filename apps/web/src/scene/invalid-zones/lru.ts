/** Insertion-ordered LRU map; `onEvict` releases resources (WASM objects) that GC cannot see. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (value: V) => void,
  ) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: V): void {
    const previous = this.entries.get(key);
    if (previous !== undefined && previous !== value) this.onEvict?.(previous);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value[0]);
      this.onEvict?.(oldest.value[1]);
    }
  }

  clear(): void {
    for (const value of this.entries.values()) this.onEvict?.(value);
    this.entries.clear();
  }
}
