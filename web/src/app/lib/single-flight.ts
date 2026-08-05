/** Shares one in-progress Promise per key. A settled operation is removed only if it is still the
 * operation registered for that key, so an older completion can never clear a newer retry. */
export class SingleFlight<K, V> {
  private readonly inflight = new Map<K, Promise<V>>();

  run(key: K, factory: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    let created: Promise<V>;
    try {
      created = factory();
    } catch (error) {
      return Promise.reject(error);
    }
    this.inflight.set(key, created);
    void created.then(
      () => this.removeIfCurrent(key, created),
      () => this.removeIfCurrent(key, created),
    );
    return created;
  }

  clear(): void {
    this.inflight.clear();
  }

  private removeIfCurrent(key: K, operation: Promise<V>): void {
    if (this.inflight.get(key) === operation) this.inflight.delete(key);
  }
}
