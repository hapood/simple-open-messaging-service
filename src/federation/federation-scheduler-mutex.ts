/** FIFO process-local mutation lock. Rejection never poisons the next caller. */
export class FederationSchedulerMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // Scheduler mutations are synchronous; no network or database work belongs here.
      return operation();
    } finally {
      release();
    }
  }
}
