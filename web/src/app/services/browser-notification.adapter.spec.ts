import {
  BrowserNotificationAdapter,
  clearBrowserMessageNotifications,
} from './browser-notification.adapter';

describe('browser notification cleanup', () => {
  const closeCurrent = vi.fn();
  const closeOther = vi.fn();
  const closeForeign = vi.fn();
  const getNotifications = vi.fn();
  const getRegistration = vi.fn();

  beforeEach(() => {
    closeCurrent.mockClear();
    closeOther.mockClear();
    closeForeign.mockClear();
    getNotifications.mockImplementation(async () => [
      { tag: 'soms-thread-7', close: closeCurrent },
      { tag: 'soms-thread-8', close: closeOther },
      { tag: 'other-app', close: closeForeign },
    ]);
    getRegistration.mockResolvedValue({ getNotifications });
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockImplementation(
      getRegistration,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('closes only the active conversation card on chat open', async () => {
    await new BrowserNotificationAdapter().clearThread(7);
    expect(closeCurrent).toHaveBeenCalledOnce();
    expect(closeOther).not.toHaveBeenCalled();
    expect(closeForeign).not.toHaveBeenCalled();
  });

  it('clears all app cards, but not other notifications, on session end', async () => {
    await clearBrowserMessageNotifications();
    expect(closeCurrent).toHaveBeenCalledOnce();
    expect(closeOther).toHaveBeenCalledOnce();
    expect(closeForeign).not.toHaveBeenCalled();
  });
});
