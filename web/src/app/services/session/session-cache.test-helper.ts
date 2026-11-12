import { PreferenceStorage } from '../preference-storage';
import { SessionStore, SESSION_STORE_KEY } from './session-store';
import {
  createSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session-identity';

/** Establish an isolated, durably active browser login for storage integration tests. */
export async function prepareTestSessionCache(): Promise<SessionCacheDescriptor> {
  const preferences = new PreferenceStorage();
  try {
    await preferences.remove('device', SESSION_STORE_KEY);
    const cache = createSessionCacheDescriptor();
    const sessionStore = new SessionStore(preferences);
    await sessionStore.prepare(cache);
    await sessionStore.activate(cache.id);
    return cache;
  } finally {
    await preferences.close();
  }
}
