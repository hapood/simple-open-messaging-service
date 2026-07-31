import { messageOpenOptions } from './message-open-position';

describe('messageOpenOptions', () => {
  it('keeps latest mode on the normal newest init path', () => {
    expect(messageOpenOptions('latest', 42)).toBeUndefined();
  });

  it('anchors last-read mode at the first unread message with a latest fallback', () => {
    expect(messageOpenOptions('last-read', 42)).toEqual({
      startMsgId: 42,
      anchor: 'top',
      fallbackToLatest: true,
    });
  });

  it('opens newest when there is no unread boundary', () => {
    expect(messageOpenOptions('last-read', null)).toBeUndefined();
  });
});
