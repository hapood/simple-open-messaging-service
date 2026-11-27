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

  it('replaces an old format with an empty current database', async () => {
    const old = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('preferences', { keyPath: 'key' });
      },
    });
    await old.put('preferences', {
      key: 'theme',
      value: 'dark',
      updatedAt: 123,
    });
    old.close();

    expect(await settings.getStrict('theme')).toBeUndefined();
    expect(await appState.get('schemaVersion')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const replaced = await openDB(DB_NAME);
    try {
      expect(replaced.version).toBe(2);
      expect(Array.from(replaced.objectStoreNames)).toEqual([
        'app_state',
        'settings',
      ]);
    } finally {
      replaced.close();
    }
  });

  it('replaces an unsupported structure at the current IDB version', async () => {
    const unsupported = await openDB(DB_NAME, 2, {
      upgrade(db) {
        db.createObjectStore('preferences', { keyPath: 'key' });
      },
    });
    await unsupported.put('preferences', { key: 'language', value: 'en' });
    unsupported.close();

    await settings.set('language', 'fr');
    const replaced = await openDB(DB_NAME);
    try {
      expect(Array.from(replaced.objectStoreNames)).toEqual([
        'app_state',
        'settings',
      ]);
      expect((await replaced.get('settings', 'language')).value).toBe('fr');
    } finally {
      replaced.close();
    }
  });

  it('replaces an unsupported app-state schema version', async () => {
    await settings.set('theme', 'dark');
    await appState.set('schemaVersion', 99);
    await settings.close();

    expect(await settings.getStrict('theme')).toBeUndefined();
    expect(await appState.get('schemaVersion')).toBe(1);
  });
});
