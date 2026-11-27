import { AppStateStorage, PreferenceStorage } from '../preference-storage';
import { SessionStore } from './session-store';
import { resetTestAppState } from './session-store.test-helper';
import {
  createSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session-identity';

/** Establish an isolated, durably active browser login for storage integration tests. */
export async function prepareTestSessionCache(): Promise<SessionCacheDescriptor> {
  const appState = new AppStateStorage();
  try {
    await resetTestAppState(appState);
    const store = new SessionStore(appState);
    await store.initialize();
    await store.configure({ primary: location.origin });
    const cache = createSessionCacheDescriptor();
    await store.activate(cache.id);
    return cache;
  } finally {
    await new PreferenceStorage().close();
  }
}
