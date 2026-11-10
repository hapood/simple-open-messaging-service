import { parseSwNotifMessage, SOMS_NOTIF_MSG } from './sw-notif-protocol';

describe('Push worker message boundaries', () => {
  it('requires the complete committed coordinate', () => {
    const message = { type: SOMS_NOTIF_MSG.COMMITTED, userId: 1, cursor: 0 };
    expect(parseSwNotifMessage(message)).toEqual(message);
    expect(parseSwNotifMessage({ type: message.type, userId: 1 })).toBeNull();
    expect(parseSwNotifMessage({ ...message, cursor: -1 })).toBeNull();
  });
  it('requires a validated target and positive session ID, never a flattened thread ID', () => {
    const message = {
      type: SOMS_NOTIF_MSG.OPEN,
      target: { kind: 'thread', threadId: 7 },
      sessionId: 11,
    };
    expect(parseSwNotifMessage(message)).toEqual(message);
    for (const invalid of [undefined, 0, '7', 0.5, 2147483648]) {
      expect(
        parseSwNotifMessage({
          ...message,
          target: { kind: 'thread', threadId: invalid },
        }),
      ).toBeNull();
      expect(
        parseSwNotifMessage({ ...message, sessionId: invalid }),
      ).toBeNull();
    }
    expect(
      parseSwNotifMessage({
        type: SOMS_NOTIF_MSG.OPEN,
        threadId: 7,
        sessionId: 11,
      }),
    ).toBeNull();
    expect(
      parseSwNotifMessage({
        type: SOMS_NOTIF_MSG.OPEN,
        target: { kind: 'friend-requests' },
      }),
    ).toBeNull();
    expect(parseSwNotifMessage({ type: 'unknown' })).toBeNull();
  });
});
