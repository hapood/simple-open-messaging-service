import { signal } from '@angular/core';
import { MessageThreadComponent } from './friend-message.component';
import { createP2PConversation } from '../../services/model';

describe('MessageThreadComponent initial failure presentation', () => {
  it('reveals a reusable retry surface when initialization fails', async () => {
    const error = new Error('history unavailable');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thread = createP2PConversation(42, {
      id: 2,
      account: 'peer',
      name: 'Peer',
    });
    // Exercise the real kernel initialization with a failing source. Rendering,
    // transport, and the A/B coordinator have their own tests; no constructor effects run here.
    const component = Object.create(MessageThreadComponent.prototype);
    Object.assign(component, {
      threadAdapter: {
        createSource: () => ({
          init: () => Promise.reject(error),
          destroy: vi.fn(),
        }),
        scrollerConfig: () => ({}),
        configureScroller: vi.fn(),
      },
      optimistic: { bind: vi.fn() },
      transferStackRef: () => undefined,
      contentRef: () => undefined,
      initialLoading: signal(false),
      initialLoadFailed: signal(false),
      convList: { unreadEntryBoundary: () => undefined },
      scrollState: { open: vi.fn(), firstUnreadSeq: null },
      chatAppearance: { openPosition: () => 'latest' },
      ready: { emit: vi.fn() },
      userMsgTrd: () => thread,
      currentTrdId: 42,
    });
    component.initScroller(
      document.createElement('div'),
      document.createElement('div'),
      thread,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(component.initialLoading()).toBe(false);
    expect(component.initialLoadFailed()).toBe(true);
    expect(component.ready.emit).toHaveBeenCalledWith(42);
    expect(component.isWarm()).toBe(true);
    component.reinit = vi.fn();
    component.retryInitialLoad();
    expect(component.reinit).toHaveBeenCalledOnce();
    expect(component.initialLoading()).toBe(true);
    expect(component.initialLoadFailed()).toBe(false);
    component.scroller.destroy();
    warning.mockRestore();
  });
});
