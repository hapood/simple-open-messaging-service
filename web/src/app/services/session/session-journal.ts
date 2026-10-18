import {
  restoreSessionCacheDescriptor,
  SessionSupersededError,
  type LoginSessionId,
  type SessionCacheDescriptor,
} from './session-identity';

export const SESSION_JOURNAL_KEY = 'soms.login-session.v1';

export type SessionJournalRecord = Readonly<{
  version: 1;
  phase: 'preparing' | 'active' | 'ending' | 'signed-out';
  session: SessionCacheDescriptor | null;
  pendingCleanup: readonly SessionCacheDescriptor[];
}>;

/** Strict reads must reject on storage failure, rather than return absence. */
export interface SessionJournalStorage {
  getStrict<T>(scope: 'device', key: string): Promise<T | undefined>;
  set<T>(scope: 'device', key: string, value: T): Promise<void>;
}

function record(
  phase: SessionJournalRecord['phase'],
  session: SessionCacheDescriptor | null,
  pendingCleanup: readonly SessionCacheDescriptor[],
): SessionJournalRecord {
  return Object.freeze({
    version: 1,
    phase,
    session,
    pendingCleanup: Object.freeze([...pendingCleanup]),
  });
}

/** Validate everything before allowing metadata to select caches for deletion. */
export function parseSessionJournal(value: unknown): SessionJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session journal');
  }
  const saved = value as Record<string, unknown>;
  if (saved['version'] !== 1 || !Array.isArray(saved['pendingCleanup'])) {
    throw new Error('Invalid session journal version or cleanup list');
  }
  const phase = saved['phase'];
  if (
    phase !== 'preparing' &&
    phase !== 'active' &&
    phase !== 'ending' &&
    phase !== 'signed-out'
  ) {
    throw new Error('Invalid session journal phase');
  }
  const session =
    saved['session'] === null
      ? null
      : restoreSessionCacheDescriptor(saved['session']);
  const pending = saved['pendingCleanup'].map(restoreSessionCacheDescriptor);
  if (new Set(pending.map((item) => item.id)).size !== pending.length) {
    throw new Error('Duplicate session cleanup identity');
  }
  if (phase === 'preparing' || phase === 'active') {
    if (session === null || pending.length !== 0) {
      throw new Error('Live session cannot have pending cleanup');
    }
  } else if (
    session !== null ||
    (phase === 'signed-out' && pending.length !== 0)
  ) {
    throw new Error('Ended session cannot retain live resources');
  }
  return record(phase, session, pending);
}

/**
 * Durable transition log, not a second authentication authority. The owning host
 * serializes transitions through one instance. Workers may read but never write
 * this log. Native hosts implement the equivalent transitions in Rust.
 *
 * No cached record is trusted after a failed write. Each mutation rereads strict
 * durable state, so retry/restart cannot silently bypass incomplete cleanup.
 */
export class SessionJournal {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: SessionJournalStorage) {}

  read(): Promise<SessionJournalRecord | null> {
    return this.serialize(() => this.load());
  }

  prepare(descriptor: SessionCacheDescriptor): Promise<SessionJournalRecord> {
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

  activate(id: LoginSessionId): Promise<SessionJournalRecord> {
    return this.serialize(async () => {
      const previous = await this.load();
      if (previous?.session?.id !== id) throw new SessionSupersededError();
      if (previous.phase === 'active') return previous;
      if (previous.phase !== 'preparing') throw new SessionSupersededError();
      return this.save(record('active', previous.session, []));
    });
  }

  /** Call after synchronous in-memory invalidation, before deleting resources. */
  end(id: LoginSessionId | null): Promise<SessionJournalRecord> {
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
  completeCleanup(id: LoginSessionId): Promise<SessionJournalRecord> {
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

  private async load(): Promise<SessionJournalRecord | null> {
    const value = await this.storage.getStrict<unknown>(
      'device',
      SESSION_JOURNAL_KEY,
    );
    return value === undefined ? null : parseSessionJournal(value);
  }

  private async save(
    value: SessionJournalRecord,
  ): Promise<SessionJournalRecord> {
    await this.storage.set('device', SESSION_JOURNAL_KEY, value);
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
