import { AppStateStorage } from '../preference-storage';
import {
  sessionCacheDescriptor,
  parseLoginSessionId,
  SessionSupersededError,
  type LoginSessionId,
  type SessionCacheDescriptor,
} from './session-identity';

export interface ServerSessionIdentity {
  readonly userId: number;
  readonly serverSessionId: number;
}

export function parseServerSessionIdentity(
  value: unknown,
): ServerSessionIdentity {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid server session identity');
  const identity = value as ServerSessionIdentity;
  if (
    !Number.isSafeInteger(identity.userId) ||
    identity.userId <= 0 ||
    !Number.isSafeInteger(identity.serverSessionId) ||
    identity.serverSessionId <= 0
  ) {
    throw new Error('Invalid server session identity');
  }
  return Object.freeze({
    userId: identity.userId,
    serverSessionId: identity.serverSessionId,
  });
}

export type LifecycleState =
  | 'unconfigured'
  | 'signed-out'
  | 'active'
  | 'cleaning';
export type SessionStoreRecord = Readonly<{
  lifecycleState: LifecycleState;
  session: SessionCacheDescriptor | null;
  identity: ServerSessionIdentity | null;
}>;
export interface SessionStoreStorage {
  readSnapshot(): Promise<ReadonlyMap<string, unknown>>;
  update<T>(change: (state: Map<string, unknown>) => T): Promise<T>;
}

/** Workers read lifecycle, UUID and server-confirmed notification identity atomically. */
export function parseSessionState(
  state: ReadonlyMap<string, unknown>,
): SessionStoreRecord {
  if (state.get('schemaVersion') !== 1)
    throw new Error('Invalid app-state version');
  const lifecycleState = state.get('lifecycleState');
  if (
    lifecycleState !== 'unconfigured' &&
    lifecycleState !== 'signed-out' &&
    lifecycleState !== 'active' &&
    lifecycleState !== 'cleaning'
  ) {
    throw new Error('Invalid login lifecycle');
  }
  const uuid = state.get('sessionUuid');
  const session =
    uuid === undefined
      ? null
      : sessionCacheDescriptor(parseLoginSessionId(uuid));
  if (
    (lifecycleState === 'active' && !session) ||
    ((lifecycleState === 'signed-out' || lifecycleState === 'unconfigured') &&
      session)
  ) {
    throw new Error('Inconsistent login lifecycle');
  }
  // Server IDs fence notification clicks across logins; the local UUID is not a
  // substitute for the identity carried by server-generated notification targets.
  const identityValue = state.get('notificationSessionIdentity');
  const identity =
    identityValue === undefined
      ? null
      : parseServerSessionIdentity(identityValue);
  if (identity && lifecycleState !== 'active')
    throw new Error('Inactive notification identity');
  return Object.freeze({ lifecycleState, session, identity });
}

/** Browser-only durable lifecycle. Preparation and revocation decisions are not persisted. */
export class SessionStore {
  constructor(
    private readonly storage: SessionStoreStorage = new AppStateStorage(),
  ) {}

  initialize(): Promise<SessionStoreRecord> {
    return this.storage.update((state) => {
      if (state.get('schemaVersion') !== 1)
        throw new Error('Invalid app-state version');
      if (!state.has('lifecycleState')) {
        state.set(
          'lifecycleState',
          state.has('serverConfig') ? 'signed-out' : 'unconfigured',
        );
      }
      return parseSessionState(state);
    });
  }

  configure(serverConfig: unknown): Promise<SessionStoreRecord> {
    return this.storage.update((state) => {
      const previous = parseSessionState(state);
      if (
        previous.lifecycleState !== 'unconfigured' &&
        previous.lifecycleState !== 'signed-out'
      ) {
        throw new SessionSupersededError();
      }
      state.set('serverConfig', serverConfig);
      state.set('lifecycleState', 'signed-out');
      return parseSessionState(state);
    });
  }

  async read(): Promise<SessionStoreRecord> {
    return parseSessionState(await this.storage.readSnapshot());
  }

  activate(
    id: LoginSessionId,
    signal?: AbortSignal,
  ): Promise<SessionStoreRecord> {
    parseLoginSessionId(id);
    return this.storage.update((state) => {
      if (signal?.aborted) throw new SessionSupersededError();
      if (parseSessionState(state).lifecycleState !== 'signed-out')
        throw new SessionSupersededError();
      state.set('sessionUuid', id);
      state.set('lifecycleState', 'active');
      state.delete('notificationSessionIdentity');
      return parseSessionState(state);
    });
  }

  /** A HELLO can bind once, and never rebind a successor or a different server login. */
  bindIdentity(
    id: LoginSessionId,
    value: ServerSessionIdentity,
  ): Promise<SessionStoreRecord> {
    const identity = parseServerSessionIdentity(value);
    return this.storage.update((state) => {
      const previous = parseSessionState(state);
      if (
        previous.lifecycleState !== 'active' ||
        previous.session?.id !== id ||
        (previous.identity &&
          (previous.identity.userId !== identity.userId ||
            previous.identity.serverSessionId !== identity.serverSessionId))
      ) {
        throw new SessionSupersededError();
      }
      state.set('notificationSessionIdentity', identity);
      return parseSessionState(state);
    });
  }

  beginCleaning(id: LoginSessionId | null): Promise<SessionStoreRecord> {
    return this.storage.update((state) => {
      const previous = parseSessionState(state);
      if ((previous.session?.id ?? null) !== id)
        throw new SessionSupersededError();
      state.set('lifecycleState', 'cleaning');
      state.delete('notificationSessionIdentity');
      state.delete('forwardRecentThreads');
      state.delete('cacheRebuild');
      return parseSessionState(state);
    });
  }

  finishCleaning(id: LoginSessionId | null): Promise<SessionStoreRecord> {
    return this.storage.update((state) => {
      const previous = parseSessionState(state);
      if (
        previous.lifecycleState !== 'cleaning' ||
        (previous.session?.id ?? null) !== id
      ) {
        throw new SessionSupersededError();
      }
      state.delete('sessionUuid');
      state.set(
        'lifecycleState',
        state.has('serverConfig') ? 'signed-out' : 'unconfigured',
      );
      return parseSessionState(state);
    });
  }
}
