type CacheRecord<T> = {
  expiresAt: number;
  value: T;
};

/**
 * Simple typed in-memory TTL cache for API and compute intensive results.
 */
export class Cache<T> {
  private readonly store = new Map<string, CacheRecord<T>>();

  public constructor(private readonly ttlMs: number) {}

  public get(key: string): T | undefined {
    const item = this.store.get(key);

    if (!item) {
      return undefined;
    }

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return item.value;
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  public invalidate(key?: string): void {
    if (key) {
      this.store.delete(key);
      return;
    }

    this.store.clear();
  }
}
