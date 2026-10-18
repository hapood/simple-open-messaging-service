import { describe, expect, it } from 'vitest';
import {
  assertActiveSession,
  createSessionCacheDescriptor,
  parseLoginSessionId,
  restoreSessionCacheDescriptor,
  SessionSupersededError,
} from './session-identity';

const FIRST = '37f3902c-abd9-4b90-9209-d83f981c019c';
const SECOND = '6e79983d-a337-43ab-a1e7-53dc7fe737b0';

function persisted(id = FIRST) {
  return {
    version: 1,
    id,
    indexedDbName: `soms-session-${id}`,
    messageIndexedDbName: `soms-session-messages-${id}`,
    sqliteFileName: `soms-session-${id}.sqlite`,
  };
}

describe('local login identity', () => {
  it('creates a distinct identity and cache for every fresh login', () => {
    const first = createSessionCacheDescriptor();
    const second = createSessionCacheDescriptor();
    expect(first.id).not.toBe(second.id);
    expect(first.indexedDbName).not.toBe(second.indexedDbName);
    expect(first.sqliteFileName).not.toBe(second.sqliteFileName);
    expect(first.messageIndexedDbName).not.toBe(second.messageIndexedDbName);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('restores the same identity without keeping a mutable persistence object', () => {
    const saved = persisted();
    const restored = restoreSessionCacheDescriptor(saved);
    saved.id = SECOND;
    saved.sqliteFileName = 'unrelated.sqlite';
    expect(restored).toEqual(persisted());
    expect(Object.isFrozen(restored)).toBe(true);
    expect(
      restoreSessionCacheDescriptor(JSON.parse(JSON.stringify(restored))),
    ).toEqual(restored);
  });

  it.each([null, undefined, 1, [], {}, { ...persisted(), version: 2 }])(
    'rejects invalid persisted descriptor %j',
    (value) => expect(() => restoreSessionCacheDescriptor(value)).toThrow(),
  );

  it.each(['../other', '', FIRST.toUpperCase(), 4, null])(
    'rejects invalid identity %j before constructing resource names',
    (value) => expect(() => parseLoginSessionId(value)).toThrow(),
  );

  it.each([
    { ...persisted(), indexedDbName: `soms-session-${SECOND}` },
    { ...persisted(), sqliteFileName: '../device.sqlite' },
    { ...persisted(), messageIndexedDbName: `soms-session-messages-${SECOND}` },
  ])('rejects resource names not belonging to the UUID', (saved) => {
    expect(() => restoreSessionCacheDescriptor(saved)).toThrow(
      'Session cache names do not match login identity',
    );
  });

  it('rejects obsolete work both while signed out and after a successor login', () => {
    const first = parseLoginSessionId(FIRST);
    expect(() => assertActiveSession(first, first)).not.toThrow();
    expect(() => assertActiveSession(first, null)).toThrow(
      SessionSupersededError,
    );
    expect(() =>
      assertActiveSession(first, parseLoginSessionId(SECOND)),
    ).toThrow(SessionSupersededError);
  });
});
