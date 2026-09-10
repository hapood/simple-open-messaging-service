import { parseSwNotifMessage, SOMS_NOTIF_MSG } from './sw-notif-protocol';

describe('Push worker message boundaries', () => {
  it('requires the complete committed coordinate', () => {
    const message = { type: SOMS_NOTIF_MSG.COMMITTED, userId: 1, cursor: 0 };
    expect(parseSwNotifMessage(message)).toEqual(message);
    expect(parseSwNotifMessage({ type: message.type, userId: 1 })).toBeNull();
    expect(parseSwNotifMessage({ ...message, cursor: -1 })).toBeNull();
  });
  it('requires a positive integer thread and rejects unknown events', () => {
    expect(
      parseSwNotifMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7 }),
    ).toEqual({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7 });
    for (const threadId of [undefined, 0, '7', 0.5, 2147483648])
      expect(
        parseSwNotifMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId }),
      ).toBeNull();
    expect(parseSwNotifMessage({ type: 'unknown' })).toBeNull();
  });
});
