import { ThreadNavigationIntentCoordinator, type ThreadNavigationIntent } from './thread-navigation-intent';
import { parseSwNotifMessage, SOMS_NOTIF_MSG } from './sw-notif-protocol';

describe('required session notification identity', () => {
  let coordinator: ThreadNavigationIntentCoordinator;
  const acknowledge = vi.fn();
  const open = vi.fn(() => true);
  const tap = (extra: Partial<ThreadNavigationIntent> = {}): ThreadNavigationIntent => ({ source: 'android', id: 'tap', threadId: 7, sessionId: 11, acknowledge, ...extra });
  beforeEach(() => { coordinator = new ThreadNavigationIntentCoordinator(); acknowledge.mockClear(); open.mockClear(); });
  it('waits for authoritative HELLO and hydration', () => {
    coordinator.offer(tap());
    coordinator.select(null, true, open);
    coordinator.select(11, false, open);
    expect(open).not.toHaveBeenCalled();
    coordinator.select(11, true, open);
    expect(open).toHaveBeenCalledExactlyOnceWith(7);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('rejects another session even on the same account', () => {
    coordinator.offer(tap());
    coordinator.select(12, true, open);
    coordinator.select(11, true, open);
    expect(open).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('latest distinct tap wins; exact accepted tap is acknowledged once', () => {
    const oldAck = vi.fn();
    coordinator.offer(tap({ acknowledge: oldAck }));
    coordinator.offer(tap({ id: 'new' }));
    coordinator.select(11, true, open);
    coordinator.offer(tap({ id: 'new' }));
    coordinator.select(11, true, open);
    expect(oldAck).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('invalidation retires a pre-HELLO intent', () => {
    coordinator.offer(tap()); coordinator.invalidate(); coordinator.offer(tap());
    coordinator.select(11, true, open);
    expect(open).not.toHaveBeenCalled();
  });
  it('requires valid explicit session and thread coordinates', () => {
    for (const sessionId of [undefined, null, '11', 0, -1, 1.5, 2147483648]) {
      coordinator.offer(tap({ sessionId } as unknown as Partial<ThreadNavigationIntent>));
      expect(parseSwNotifMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7, sessionId })).toBeNull();
    }
    coordinator.offer({ source: 'web', id: 'old', threadId: 7, userId: 11 } as unknown as ThreadNavigationIntent);
    for (const threadId of [0, -1, 1.5, NaN, 2147483648]) coordinator.offer(tap({ threadId }));
    coordinator.select(11, true, open);
    expect(open).not.toHaveBeenCalled();
    expect(parseSwNotifMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7, sessionId: 11 })).toEqual({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7, sessionId: 11 });
  });
  it('does not acknowledge before the navigator accepts the target', () => {
    coordinator.offer(tap());
    coordinator.select(11, true, () => false);
    expect(acknowledge).not.toHaveBeenCalled();
    coordinator.select(11, true, open);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
