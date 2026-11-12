import {
  restoreSessionCacheDescriptor,
  SessionSupersededError,
  type LoginSessionId,
  type SessionCacheDescriptor,
} from './session-identity';

export const SESSION_STORE_KEY = 'soms.login-session.v1';

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

export type SessionStoreRecord = Readonly<{
  version: 1;
  phase: 'preparing' | 'active' | 'revoking' | 'ending' | 'signed-out';
  session: SessionCacheDescriptor | null;
  identity: ServerSessionIdentity | null;
  pendingCleanup: readonly SessionCacheDescriptor[];
}>;

/** Strict reads must reject on storage failure, rather than return absence. */
export interface SessionStoreStorage {
  getStrict<T>(scope: 'device', key: string): Promise<T | undefined>;
  set<T>(scope: 'device', key: string, value: T): Promise<void>;
}

function record(
  phase: SessionStoreRecord['phase'],
  session: SessionCacheDescriptor | null,
  pendingCleanup: readonly SessionCacheDescriptor[],
  identity: ServerSessionIdentity | null = null,
): SessionStoreRecord {
  return Object.freeze({
    version: 1,
    phase,
    session,
    identity,
    pendingCleanup: Object.freeze([...pendingCleanup]),
  });
}

/** Validate everything before allowing metadata to select caches for deletion. */
export function parseSessionStore(value: unknown): SessionStoreRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session store');
  }
  const saved = value as Record<string, unknown>;
  if (saved['version'] !== 1 || !Array.isArray(saved['pendingCleanup'])) {
    throw new Error('Invalid session store version or cleanup list');
  }
  const phase = saved['phase'];
  if (
    phase !== 'preparing' &&
    phase !== 'active' &&
    phase !== 'revoking' &&
    phase !== 'ending' &&
    phase !== 'signed-out'
  ) {
    throw new Error('Invalid session store phase');
  }
  const session =
    saved['session'] === null
      ? null
      : restoreSessionCacheDescriptor(saved['session']);
  const pending = saved['pendingCleanup'].map(restoreSessionCacheDescriptor);
  if (new Set(pending.map((item) => item.id)).size !== pending.length) {
    throw new Error('Duplicate session cleanup identity');
  }
  if (phase === 'preparing' || phase === 'active' || phase === 'revoking') {
    if (session === null || pending.length !== 0) {
      throw new Error('Live session cannot have pending cleanup');
    }
  } else if (
    session !== null ||
    (phase === 'signed-out' && pending.length !== 0)
  ) {
    throw new Error('Ended session cannot retain live resources');
  }
  // Older v1 records remain restorable; only a server-confirmed handshake may fill identity.
  const identity =
    saved['identity'] == null
      ? null
      : parseServerSessionIdentity(saved['identity']);
  if (identity && phase !== 'active' && phase !== 'revoking')
    throw new Error('Inactive session retains server identity');
  return record(phase, session, pending, identity);
}

/**
 * Durable transition log, not a second authentication authority. The owning host
 * serializes transitions through one instance. Workers may read but never write
 * this log. Native hosts implement the equivalent transitions in Rust.
 *
 * No cached record is trusted after a failed write. Each mutation rereads strict
 * durable state, so retry/restart cannot silently bypass incomplete cleanup.
 */
export class SessionStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: SessionStoreStorage) {}

  read(): Promise<SessionStoreRecord | null> {
    return this.serialize(() => this.load());
  }

  prepare(descriptor: SessionCacheDescriptor): Promise<SessionStoreRecord> {
    // Snapshot before enqueueing so a caller cannot mutate resource names later.
    const session = restoreSessionCacheDescriptor(descriptor);
    return this.serialize(async () => {
      const previous = await this.load();
      if (
        previous?.phase === 'preparing' &&
        previous.session?.id === session.id
      ) {
        return previous;
      }
      if (previous !== null && previous.phase !== 'signed-out') {
        throw new Error(
          'Previous session must finish cleanup before preparation',
        );
      }
      return this.save(record('preparing', session, []));
    });
  }

  activate(id: LoginSessionId): Promise<SessionStoreRecord> {
    return this.serialize(async () => {
      const previous = await this.load();
      if (previous?.session?.id !== id) throw new SessionSupersededError();
      if (previous.phase === 'active') return previous;
      if (previous.phase !== 'preparing') throw new SessionSupersededError();
      return this.save(record('active', previous.session, []));
    });
  }

  /** Bind a server-confirmed identity to the original login, never a mutable current account. */
  bindIdentity(
    id: LoginSessionId,
    value: ServerSessionIdentity,
  ): Promise<SessionStoreRecord> {
    const identity = parseServerSessionIdentity(value);
    return this.serialize(async () => {
      const previous = await this.load();
      if (previous?.phase !== 'active' || previous.session?.id !== id) {
        throw new SessionSupersededError();
      }
      if (previous.identity) {
        if (
          previous.identity.userId !== identity.userId ||
          previous.identity.serverSessionId !== identity.serverSessionId
        ) {
          throw new SessionSupersededError();
        }
        return previous;
      }
      return this.save(record('active', previous.session, [], identity));
    });
  }

  /** Disable background admission while retaining the original login for explicit revocation. */
  beginRevocation(id: LoginSessionId): Promise<SessionStoreRecord> {
    return this.serialize(async () => {
      const previous = await this.load();
      if (previous?.session?.id !== id ||
          (previous.phase !== 'active' && previous.phase !== 'revoking')) {
        throw new SessionSupersededError();
      }
      if (previous.phase === 'revoking') return previous;
      return this.save(record('revoking', previous.session, [], previous.identity));
    });
  }

  /** Call after synchronous in-memory invalidation, before deleting resources. */
  end(id: LoginSessionId | null): Promise<SessionStoreRecord> {
    return this.serialize(async () => {
      const previous = await this.load();
      if (previous?.phase === 'ending') {
        if (
          id !== null &&
          !previous.pendingCleanup.some((item) => item.id === id)
        ) {
          throw new SessionSupersededError();
        }
        return previous;
      }
      if (previous?.phase === 'signed-out') return previous;
      if ((previous?.session?.id ?? null) !== id) {
        throw new SessionSupersededError();
      }
      return this.save(
        previous?.session
          ? record('ending', null, [previous.session])
          : record('signed-out', null, []),
      );
    });
  }

  /** Invoke only after all stores/resources for this descriptor were removed. */
  completeCleanup(id: LoginSessionId): Promise<SessionStoreRecord> {
    return this.serialize(async () => {
      const previous = await this.load();
      if (
        !previous ||
        (previous.phase !== 'ending' && previous.phase !== 'signed-out')
      ) {
        throw new SessionSupersededError();
      }
      const pending = previous.pendingCleanup.filter((item) => item.id !== id);
      return this.save(
        record(pending.length ? 'ending' : 'signed-out', null, pending),
      );
    });
  }

  private async load(): Promise<SessionStoreRecord | null> {
    const value = await this.storage.getStrict<unknown>(
      'device',
      SESSION_STORE_KEY,
    );
    return value === undefined ? null : parseSessionStore(value);
  }

  private async save(value: SessionStoreRecord): Promise<SessionStoreRecord> {
    await this.storage.set('device', SESSION_STORE_KEY, value);
    return value;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
