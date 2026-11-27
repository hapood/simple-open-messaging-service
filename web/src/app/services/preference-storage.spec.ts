import { deleteDB, openDB } from 'idb';
import { AppStateStorage, PreferenceStorage } from './preference-storage';

const DB_NAME = 'soms-client-preferences';

describe('client preference storage format', () => {
  let settings: PreferenceStorage;
  let appState: AppStateStorage;

  beforeEach(async () => {
    settings = new PreferenceStorage();
    appState = new AppStateStorage();
    await settings.close();
    await deleteDB(DB_NAME);
  });

  afterEach(async () => {
    await settings.close();
    await deleteDB(DB_NAME);
  });

  it('initializes only the current stores on a fresh installation', async () => {
    expect(await settings.getStrict('theme')).toBeUndefined();
    expect(await appState.get('schemaVersion')).toBe(1);
    await settings.set('theme', 'dark');
    await settings.close();

    const db = await openDB(DB_NAME);
    try {
      expect(db.version).toBe(2);
      expect(Array.from(db.objectStoreNames)).toEqual([
        'app_state',
        'settings',
      ]);
      expect(db.transaction('settings').store.keyPath).toBe('key');
      expect(db.transaction('app_state').store.keyPath).toBe('key');
      expect((await db.get('settings', 'theme')).value).toBe('dark');
    } finally {
      db.close();
    }
  });

  it('reopens the current format without resetting settings or lifecycle state', async () => {
    await settings.set('theme', { mode: 'dark' });
    await appState.set('lifecycle', { phase: 'ending', generation: 7 });
    await settings.close();

    expect(await settings.getStrict('theme')).toEqual({ mode: 'dark' });
    expect(await appState.get('lifecycle')).toEqual({
      phase: 'ending',
      generation: 7,
    });
    expect(await appState.get('schemaVersion')).toBe(1);
  });

  it('rejects an old format without deleting preferences or committing an upgrade', async () => {
    const old = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('preferences', { keyPath: 'key' });
      },
    });
    const preference = { key: 'theme', value: 'dark', updatedAt: 123 };
    await old.put('preferences', preference);
    old.close();

    await expect(settings.getStrict('theme')).rejects.toThrow(
      'Unsupported client preferences format',
    );
    await expect(appState.set('lifecycle', { phase: 'idle' })).rejects.toThrow(
      'Unsupported client preferences format',
    );
    // Flush abort-related promise reactions: the runner must not receive an
    // unhandled rejection from the aborted upgrade transaction's done promise.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const unchanged = await openDB(DB_NAME);
    try {
      expect(unchanged.version).toBe(1);
      expect(Array.from(unchanged.objectStoreNames)).toEqual(['preferences']);
      expect(await unchanged.get('preferences', 'theme')).toEqual(preference);
    } finally {
      unchanged.close();
    }
  });

  it('rejects an unsupported structure at the current IDB version without changing it', async () => {
    const unsupported = await openDB(DB_NAME, 2, {
      upgrade(db) {
        db.createObjectStore('preferences', { keyPath: 'key' });
      },
    });
    await unsupported.put('preferences', { key: 'language', value: 'en' });
    unsupported.close();

    await expect(settings.set('language', 'fr')).rejects.toThrow(
      'Unsupported client preferences format',
    );
    const unchanged = await openDB(DB_NAME);
    try {
      expect(Array.from(unchanged.objectStoreNames)).toEqual(['preferences']);
      expect(await unchanged.get('preferences', 'language')).toEqual({
        key: 'language',
        value: 'en',
      });
    } finally {
      unchanged.close();
    }
  });

  it('rejects unsupported app-state schema versions without overwriting the marker', async () => {
    await settings.set('theme', 'dark');
    await appState.set('schemaVersion', 99);
    await settings.close();

    await expect(settings.getStrict('theme')).rejects.toThrow(
      'Unsupported client preferences format',
    );
    const unchanged = await openDB(DB_NAME);
    try {
      expect((await unchanged.get('app_state', 'schemaVersion')).value).toBe(
        99,
      );
      expect((await unchanged.get('settings', 'theme')).value).toBe('dark');
    } finally {
      unchanged.close();
    }
  });
});
