import { PreferenceStore } from './preference-store.service';

describe('PreferenceStore', () => {
  let store: PreferenceStore;

  beforeEach(() => {
    store = new PreferenceStore();
  });

  it('stores JSON values and removes them', async () => {
    expect(await store.get('device', 'missing')).toBeUndefined();

    await store.set('device', 'theme', { mode: 'dark' });
    expect(await store.get('device', 'theme')).toEqual({ mode: 'dark' });

    await store.remove('device', 'theme');
    expect(await store.get('device', 'theme')).toBeUndefined();
  });

  it('distinguishes missing lifecycle metadata from storage failure', async () => {
    expect(
      await store.getStrict('device', 'missing-lifecycle'),
    ).toBeUndefined();
    await store.set('device', 'lifecycle', { phase: 'ending' });
    expect(await store.getStrict('device', 'lifecycle')).toEqual({
      phase: 'ending',
    });
  });

  it('propagates strict read failures while preserving optional preference reads', async () => {
    const failure = new Error('Storage unavailable');
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(store.getStrict('device', 'lifecycle')).rejects.toBe(
        failure,
      );
      await expect(store.get('device', 'theme')).resolves.toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('isolates identical keys by scope', async () => {
    await store.set('global', 'setting', 'global-value');
    await store.set('account:7', 'setting', 'account-value');

    expect(await store.get('global', 'setting')).toBe('global-value');
    expect(await store.get('account:7', 'setting')).toBe('account-value');
    expect(await store.get('account:8', 'setting')).toBeUndefined();
  });
});
