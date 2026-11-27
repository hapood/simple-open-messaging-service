import { PreferenceStore } from './preference-store.service';

describe('PreferenceStore', () => {
  let store: PreferenceStore;

  beforeEach(() => {
    store = new PreferenceStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('stores JSON values and removes them', async () => {
    expect(await store.get('missing')).toBeUndefined();

    await store.set('theme', { mode: 'dark' });
    expect(await store.get('theme')).toEqual({ mode: 'dark' });

    await store.remove('theme');
    expect(await store.get('theme')).toBeUndefined();
  });

  it('distinguishes missing lifecycle metadata from storage failure', async () => {
    expect(await store.getStrict('missing-lifecycle')).toBeUndefined();
    await store.set('lifecycle', { phase: 'ending' });
    expect(await store.getStrict('lifecycle')).toEqual({
      phase: 'ending',
    });
  });

  it('propagates strict read failures while preserving optional preference reads', async () => {
    const failure = new Error('Storage unavailable');
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(store.getStrict('lifecycle')).rejects.toBe(failure);
      await expect(store.get('theme')).resolves.toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('keeps distinct keys independent', async () => {
    await store.set('setting:a', 'value-a');
    await store.set('setting:b', 'value-b');

    expect(await store.get('setting:a')).toBe('value-a');
    expect(await store.get('setting:b')).toBe('value-b');
    expect(await store.get('setting:c')).toBeUndefined();
  });
});
