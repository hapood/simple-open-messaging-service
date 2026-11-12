/** Local login identity only; never a server credential or server session ID. */
declare const loginSessionIdBrand: unique symbol;
export type LoginSessionId = string & {
  readonly [loginSessionIdBrand]: true;
};

export type SessionCacheDescriptor = Readonly<{
  version: 1;
  id: LoginSessionId;
  indexedDbName: string;
  sqliteFileName: string;
}>;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate persisted/IPC identity before deriving filesystem or database names. */
export function parseLoginSessionId(value: unknown): LoginSessionId {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new Error('Invalid local login session UUID');
  }
  return value as LoginSessionId;
}

function descriptorFor(id: LoginSessionId): SessionCacheDescriptor {
  return Object.freeze({
    version: 1,
    id,
    indexedDbName: `soms-session-${id}`,
    sqliteFileName: `soms-session-${id}.sqlite`,
  });
}

/** Fresh login only. Restoration must retain the persisted identity instead. */
export function createSessionCacheDescriptor(): SessionCacheDescriptor {
  return descriptorFor(parseLoginSessionId(crypto.randomUUID()));
}

/**
 * Reject unknown versions and inconsistent names instead of repairing a persisted
 * descriptor into authority to open/delete an unrelated cache. Return a fresh
 * frozen object so the persistence caller cannot later change a validated name.
 */
export function restoreSessionCacheDescriptor(
  value: unknown,
): SessionCacheDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid session cache descriptor');
  }
  const saved = value as Record<string, unknown>;
  if (saved['version'] !== 1) {
    throw new Error('Unsupported session cache descriptor version');
  }
  const descriptor = descriptorFor(parseLoginSessionId(saved['id']));
  if (
    saved['indexedDbName'] !== descriptor.indexedDbName ||
    saved['sqliteFileName'] !== descriptor.sqliteFileName
  ) {
    throw new Error('Session cache names do not match login identity');
  }
  return descriptor;
}

/** Control flow: callers must not toast, retry or log out a successor session. */
export class SessionSupersededError extends Error {
  readonly code = 'SESSION_SUPERSEDED';

  constructor() {
    super('The local login session is no longer active');
    this.name = 'SessionSupersededError';
  }
}

/**
 * Boundary check, not a lock. Database admission must additionally exclude
 * teardown, and asynchronous continuations must check again before publication.
 * The source of activeId is the host authority, never a second local counter.
 */
export function assertActiveSession(
  capturedId: LoginSessionId,
  activeId: LoginSessionId | null,
): void {
  if (capturedId !== activeId) throw new SessionSupersededError();
}
