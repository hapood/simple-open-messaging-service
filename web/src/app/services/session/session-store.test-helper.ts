import { AppStateStorage } from '../preference-storage';
import type { SessionStoreStorage } from './session-store';

/** Clear test lifecycle records, not the storage-owned format marker. */
export async function resetTestAppState(
  storage: SessionStoreStorage = new AppStateStorage(),
): Promise<void> {
  await storage.update((state) => {
    for (const key of state.keys()) {
      if (key !== 'schemaVersion') state.delete(key);
    }
  });
}

export class MemorySessionStorage implements SessionStoreStorage {
  state = new Map<string, unknown>([['schemaVersion', 1]]);
  failReads = false;
  failWrites = false;
  private tail: Promise<unknown> = Promise.resolve();

  async readSnapshot(): Promise<ReadonlyMap<string, unknown>> {
    if (this.failReads) throw new Error('Read failed');
    return structuredClone(this.state);
  }

  update<T>(change: (state: Map<string, unknown>) => T): Promise<T> {
    const result = this.tail.then(async () => {
      const state = new Map(await this.readSnapshot());
      const value = change(state);
      if (this.failWrites) throw new Error('Metadata unavailable');
      this.state = structuredClone(state);
      return value;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
