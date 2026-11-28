/** Business work completed outside its renderer lifetime cannot publish a result. */
export class DatabaseOperationLifetimeEndedError extends Error {
  constructor(options?: ErrorOptions) {
    super('database operation lifetime ended', options);
    this.name = 'DatabaseOperationLifetimeEndedError';
  }
}

/** Terminal admission and result fence for database operations.
 *
 * Draining waits for the underlying work, including failed work. Ending a lifetime
 * does not pretend to abort an IndexedDB transaction or a native Rust command.
 * Resource owners run their explicit close/delete paths after drain(), outside run().
 */
export class DatabaseOperationGate {
  private lifetime: AbortSignal | undefined;
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  /** A storage owner may bind once; standalone workers/tests need no renderer lifetime. */
  bind(lifetime: AbortSignal): void {
    if (this.lifetime && this.lifetime !== lifetime)
      throw new Error('database operation lifetime is already bound');
    this.lifetime = lifetime;
  }

  get ended(): boolean {
    return this.lifetime?.aborted ?? false;
  }

  assertActive(): void {
    if (this.ended) throw new DatabaseOperationLifetimeEndedError();
  }

  /** Fence owner transitions and network work without adding them to the DB drain.
   * A transition may itself drain admitted work, so counting it would deadlock. */
  async fence<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    try {
      const result = await operation();
      this.assertActive();
      return result;
    } catch (error) {
      if (this.ended && !(error instanceof DatabaseOperationLifetimeEndedError))
        throw new DatabaseOperationLifetimeEndedError({ cause: error });
      throw error;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    this.active++;
    try {
      return await this.fence(operation);
    } finally {
      this.active--;
      if (this.active === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  drain(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
