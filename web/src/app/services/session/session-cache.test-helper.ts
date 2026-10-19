import { PreferenceStorage } from '../preference-storage';
import { SessionJournal, SESSION_JOURNAL_KEY } from './session-journal';
import {
  createSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session-identity';

/** Establish an isolated, durably active browser login for storage integration tests. */
export async function prepareTestSessionCache(): Promise<SessionCacheDescriptor> {
  const preferences = new PreferenceStorage();
  try {
    await preferences.remove('device', SESSION_JOURNAL_KEY);
    const cache = createSessionCacheDescriptor();
    const journal = new SessionJournal(preferences);
    await journal.prepare(cache);
    await journal.activate(cache.id);
    return cache;
  } finally {
    await preferences.close();
  }
}
