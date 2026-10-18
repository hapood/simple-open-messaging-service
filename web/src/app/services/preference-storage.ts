import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isTauri, tauriInvoke } from './runtime';

export type PreferenceScope = 'global' | 'device' | `account:${number}`;

interface PreferenceRecord {
  id: string;
  scope: PreferenceScope;
  key: string;
  value: unknown;
  updatedAt: number;
}

interface PreferenceSchema extends DBSchema {
  preferences: { key: string; value: PreferenceRecord };
}

const DB_NAME = 'soms-client-preferences';
const DB_VERSION = 1;

function recordId(scope: PreferenceScope, key: string): string {
  return `${scope}:${key}`;
}

/**
 * The only persistence API for non-secret client preferences. Browser/PWA writes IndexedDB; Tauri writes
 * the shared native SQLite database. This is intentionally independent of the signed-in Webdb lifecycle,
 * because boot preferences such as theme, language and API origin are needed before authentication.
 */
export class PreferenceStorage {
  private dbPromise: Promise<IDBPDatabase<PreferenceSchema>> | null = null;

  async get<T>(scope: PreferenceScope, key: string): Promise<T | undefined> {
    try {
      return await this.getStrict<T>(scope, key);
    } catch {
      return undefined;
    }
  }

  /** Safety-critical metadata must distinguish a missing record from failed storage. */
  async getStrict<T>(
    scope: PreferenceScope,
    key: string,
  ): Promise<T | undefined> {
    if (isTauri()) {
      return (
        (await tauriInvoke<T | null>('native_db_get_preference', {
          scope,
          key,
        })) ?? undefined
      );
    }
    return (await (await this.db()).get('preferences', recordId(scope, key)))
      ?.value as T | undefined;
  }

  async set<T>(scope: PreferenceScope, key: string, value: T): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_put_preference', { scope, key, value });
      return;
    }
    await (
      await this.db()
    ).put('preferences', {
      id: recordId(scope, key),
      scope,
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  async remove(scope: PreferenceScope, key: string): Promise<void> {
    if (isTauri()) {
      await tauriInvoke('native_db_delete_preference', { scope, key });
      return;
    }
    await (await this.db()).delete('preferences', recordId(scope, key));
  }

  private db(): Promise<IDBPDatabase<PreferenceSchema>> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB unavailable'));
    this.dbPromise = openDB<PreferenceSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'id' });
        }
      },
    });
    return this.dbPromise;
  }
}
