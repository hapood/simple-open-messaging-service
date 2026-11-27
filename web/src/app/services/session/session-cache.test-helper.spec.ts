import { AppStateStorage, PreferenceStorage } from '../preference-storage';
import { prepareTestSessionCache } from './session-cache.test-helper';
import { SessionStore } from './session-store';
import { resetTestAppState } from './session-store.test-helper';

describe('session storage test isolation', () => {
  const preferences = new PreferenceStorage();

  afterEach(async () => {
    try {
      await resetTestAppState();
      await preferences.remove('session-helper-probe');
    } finally {
      await preferences.close();
    }
  });

  it('preserves the format marker and settings across resets and physical reopen', async () => {
    const state = new AppStateStorage();
    await preferences.set('session-helper-probe', 'retain');
    await state.set('lifecycleState', 'cleaning');
    await resetTestAppState(state);
    await preferences.close();

    expect(await state.readSnapshot()).toEqual(new Map([['schemaVersion', 1]]));
    expect(await preferences.getStrict('session-helper-probe')).toBe('retain');
    expect((await new SessionStore(state).initialize()).lifecycleState).toBe(
      'unconfigured',
    );
  });

  it('prepares distinct active logins without invalidating the shared preference format', async () => {
    const first = await prepareTestSessionCache();
    expect((await new SessionStore().read()).session?.id).toBe(first.id);
    const second = await prepareTestSessionCache();
    expect(second.id).not.toBe(first.id);
    expect((await new SessionStore().read()).session?.id).toBe(second.id);
    expect(await new AppStateStorage().get('schemaVersion')).toBe(1);
  });
});
