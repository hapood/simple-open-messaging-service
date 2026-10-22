interface LockEntry {
  locked: boolean;
  users: number;
  waiters: Array<() => void>;
}

/** FIFO, process-local mutual exclusion for work keyed by an immutable identity. */
export class KeyedMutex {
  private readonly entries = new Map<string, LockEntry>();

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { locked: false, users: 0, waiters: [] };
      this.entries.set(key, entry);
    }
    entry.users++;

    if (entry.locked) {
      await new Promise<void>((resolve) => entry!.waiters.push(resolve));
    } else {
      entry.locked = true;
    }

    try {
      return await work();
    } finally {
      const next = entry.waiters.shift();
      if (next) next();
      else entry.locked = false;
      entry.users--;
      if (
        entry.users === 0 &&
        !entry.locked &&
        this.entries.get(key) === entry
      ) {
        this.entries.delete(key);
      }
    }
  }
}
