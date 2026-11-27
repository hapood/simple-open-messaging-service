import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isTauri, tauriInvoke } from './runtime';

interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

interface AppStateRecord {
  key: string;
  value: unknown;
}

interface ClientStorageSchema extends DBSchema {
  settings: { key: string; value: SettingRecord };
  app_state: { key: string; value: AppStateRecord };
}

const DB_NAME = 'soms-client-preferences';
const DB_VERSION = 2;

let sharedDbPromise: Promise<IDBPDatabase<ClientStorageSchema>> | null = null;

function openClientDb(): Promise<IDBPDatabase<ClientStorageSchema>> {
  if (sharedDbPromise) return sharedDbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  let unsupportedFormat = false;
  sharedDbPromise = openDB<ClientStorageSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion !== 0) {
        unsupportedFormat = true;
        // idb also rejects tx.done when the upgrade aborts; consume that promise
        // while the open request reports the unsupported format to the caller.
        void tx.done.catch(() => undefined);
        tx.abort();
        return;
      }
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('app_state', { keyPath: 'key' });
      tx.objectStore('app_state').put({ key: 'schemaVersion', value: 1 });
    },
  })
    .then(async (db) => {
      try {
        if (
          db.objectStoreNames.length !== 2 ||
          !db.objectStoreNames.contains('settings') ||
          !db.objectStoreNames.contains('app_state')
        )
          throw new Error('Unsupported client preferences format');
        const tx = db.transaction(['settings', 'app_state'], 'readonly');
        const validKeys =
          tx.objectStore('settings').keyPath === 'key' &&
          tx.objectStore('app_state').keyPath === 'key';
        const version = await tx.objectStore('app_state').get('schemaVersion');
        await tx.done;
        if (!validKeys || version?.value !== 1)
          throw new Error('Unsupported client preferences format');
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })
    .catch((error: unknown) => {
      sharedDbPromise = null;
      if (
        unsupportedFormat ||
        (error instanceof DOMException && error.name === 'VersionError')
      )
        throw new Error('Unsupported client preferences format');
      throw error;
    });
  return sharedDbPromise;
}

/**
 * Persistence API for user settings. Browser/PWA writes IndexedDB `settings`;
 * Tauri writes the shared native SQLite `settings` table.
 */
export class PreferenceStorage {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await this.getStrict<T>(key);
    } catch {
      return undefined;
    }
  }

  /** Safety-critical metadata must distinguish a missing record from failed storage. */
  async getStrict<T>(key: string): Promise<T | undefined> {
    if (isTauri()) {
      return (
        (await tauriInvoke<T | null>('native_db_get_preference', { key })) ??
        undefined
      );
    }
    return (await (await openClientDb()).get('settings', key))?.value as
      | T
      | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_put_preference', { key, value });
      return;
    }
    await (
      await openClientDb()
    ).put('settings', {
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  async remove(key: string): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_delete_preference', { key });
      return;
    }
    await (await openClientDb()).delete('settings', key);
  }

  async close(): Promise<void> {
    const db = sharedDbPromise;
    sharedDbPromise = null;
    if (db) (await db).close();
  }
}

/**
 * Persistence API for installation and lifecycle state (`app_state`).
 */
export class AppStateStorage {
  /** One coherent browser snapshot, including lifecycle and its bound identity. */
  async readSnapshot(): Promise<ReadonlyMap<string, unknown>> {
    if (isTauri())
      throw new Error(
        'Browser app-state transactions require the browser host',
      );
    const db = await openClientDb();
    const tx = db.transaction('app_state', 'readonly');
    const rows = await tx.store.getAll();
    await tx.done;
    return new Map(rows.map(({ key, value }) => [key, value]));
  }

  /** Synchronous mutation inside one IDB transaction; never perform external work here. */
  async update<T>(change: (state: Map<string, unknown>) => T): Promise<T> {
    if (isTauri())
      throw new Error(
        'Browser app-state transactions require the browser host',
      );
    const db = await openClientDb();
    const tx = db.transaction('app_state', 'readwrite');
    try {
      const rows = await tx.store.getAll();
      const state = new Map(rows.map(({ key, value }) => [key, value]));
      const result = change(state);
      for (const { key } of rows)
        if (!state.has(key)) await tx.store.delete(key);
      for (const [key, value] of state) await tx.store.put({ key, value });
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (isTauri()) {
      return (
        (await tauriInvoke<T | null>('native_db_get_app_state', { key })) ??
        undefined
      );
    }
    return (await (await openClientDb()).get('app_state', key))?.value as
      | T
      | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_put_app_state', { key, value });
      return;
    }
    await (await openClientDb()).put('app_state', { key, value });
  }

  async remove(key: string): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_delete_app_state', { key });
      return;
    }
    await (await openClientDb()).delete('app_state', key);
  }
}
