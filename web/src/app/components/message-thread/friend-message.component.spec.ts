import { effect, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MessageThreadComponent } from './friend-message.component';
import { createP2PConversation } from '../../services/model';
import { ThreadScrollController } from './thread-scroll.controller';
import { BusinessCode } from '../../services/biz-code';

describe('MessageThreadComponent relationship business failures', () => {
  it.each([BusinessCode.FRIEND_NOT_FOUND, BusinessCode.GROUP_DISSOLVED])(
    'only reports business failure %s without refreshing or patching relationship state',
    (code) => {
      const component = Object.create(MessageThreadComponent.prototype);
      const applyThreadMeta = vi.fn();
      const applyGroupUpdate = vi.fn();
      const warn = vi.fn();
      Object.assign(component, {
        convList: { applyThreadMeta, applyGroupUpdate },
        toast: { warn },
        transloco: { translate: (key: string) => key },
      });
      component['surfaceSendFailure']({ code, message: 'business refusal' });
      expect(warn).toHaveBeenCalledOnce();
      expect(applyThreadMeta).not.toHaveBeenCalled();
      expect(applyGroupUpdate).not.toHaveBeenCalled();
    },
  );
});

describe('MessageThreadComponent native draft persistence', () => {
  it('does not replay a native draft event when saving changes the draft signal', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    try {
      const component = Object.create(MessageThreadComponent.prototype);
      const event = signal<{ kind: 'draft'; text: string } | null>(null);
      const stored = signal(0);
      const save = vi.fn(() => {
        stored(); // the draft store reads its existing map before replacing it
        stored.update((value) => value + 1);
      });
      Object.assign(component, {
        nativeComposerThreadId: 42,
        nativeDraft: { set: vi.fn(), save },
      });
      TestBed.runInInjectionContext(() => {
        effect(() => {
          const value = event();
          if (value) component['handleNativeComposerEvent'](value as never);
        });
      });
      event.set({ kind: 'draft', text: 'hello' });
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stored()).toBe(1);
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('persists text changes before hide can clear the native EditText, and clears after send', () => {
    const component = Object.create(MessageThreadComponent.prototype);
    const text = signal('');
    const save = vi.fn((threadId: number) => {
      expect(threadId).toBe(42);
      return text();
    });
    Object.assign(component, {
      nativeComposerThreadId: 42,
      nativeDraft: { set: text.set.bind(text), clearLink: vi.fn(), save },
      nativeComposer: { acknowledge: vi.fn() },
      onSendIntent: vi.fn(),
    });
    component['handleNativeComposerEvent']({
      kind: 'draft',
      text: 'hello',
    } as never);
    expect(save).toHaveReturnedWith('hello');
    component['handleNativeComposerEvent']({
      kind: 'sendText',
      text: 'hello',
      actionId: 1,
    } as never);
    expect(save).toHaveReturnedWith('');
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('MessageThreadComponent blocked presentation', () => {
  it('settles a blocked cold pane without starting a message kernel, and leaves unblock eligible for reinit', () => {
    const component = Object.create(MessageThreadComponent.prototype);
    const destroy = vi.fn();
    Object.assign(component, {
      currentTrdId: 42,
      blockedReadyTrdId: null,
      scroller: { destroy },
      source: { destroy: vi.fn() },
      cancelPaste: vi.fn(),
      nativeDraft: { reset: vi.fn() },
      messageInteraction: { reset: vi.fn() },
      stableRead: { flush: vi.fn(), reset: vi.fn() },
      unreadDividerReady: signal(true),
      pendingDividerRefresh: [1],
      scrollState: { reset: vi.fn() },
      stickyOverlays: () => ({ clear: vi.fn() }),
      optimistic: { reset: vi.fn() },
      initialLoading: signal(true),
      initialLoadFailed: signal(true),
      kernelReady: true,
      ready: { emit: vi.fn() },
    });

    component['presentBlockedThread'](42);

    expect(destroy).toHaveBeenCalledOnce();
    expect(component['currentTrdId']).toBeNull();
    expect(component['scroller']).toBeUndefined();
    expect(component['source']).toBeUndefined();
    expect(component.initialLoading()).toBe(false);
    expect(component.initialLoadFailed()).toBe(false);
    expect(component['kernelReady']).toBe(false);
    expect(component['unreadDividerReady']()).toBe(false);
    expect(component.ready.emit).toHaveBeenCalledWith(42);

    component.ready.emit.mockClear();
    component['presentBlockedThread'](42);
    expect(component.ready.emit).not.toHaveBeenCalled();

    component['blockedReadyTrdId'] = null;
    expect(component['currentTrdId']).toBeNull();
  });
});

describe('MessageThreadComponent initial failure presentation', () => {
  it('reveals a reusable retry surface when initialization fails', async () => {
    const error = new Error('history unavailable');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thread = createP2PConversation({
      threadId: 42,
      account: 'peer',
      publisherNamespaceId: 0,
      profileRev: 1,
    });
    // Exercise the real kernel initialization with a failing source. Rendering,
    // transport, and the A/B coordinator have their own tests; no constructor effects run here.
    const component = Object.create(MessageThreadComponent.prototype);
    Object.assign(component, {
      threadAdapter: {
        createSource: () => ({
          init: () => Promise.reject(error),
          getPending: () => [],
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
      unreadDividerReady: signal(false),
      convList: {
        previewUnreadEntryBoundary: () => undefined,
        captureUnreadEntryBoundary: () => undefined,
      },
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
    // init() rejects asynchronously — wait for the failure presentation to land instead of sleeping.
    await vi.waitFor(() => {
      expect(component.initialLoading()).toBe(false);
      expect(component.initialLoadFailed()).toBe(true);
      expect(component.ready.emit).toHaveBeenCalledWith(42);
    });
    expect(component.isWarm()).toBe(true);
    component.reinit = vi.fn();
    component.retryInitialLoad();
    expect(component.reinit).toHaveBeenCalledOnce();
    expect(component.initialLoading()).toBe(true);
    expect(component.initialLoadFailed()).toBe(false);
    component.scroller.destroy();
    warning.mockRestore();
  });

  it('replaces a mounted divider in place and only removes it when there is no unread', () => {
    const component = Object.create(MessageThreadComponent.prototype);
    const scrollState = new ThreadScrollController();
    scrollState.open(11);
    const mutateItem = vi.fn().mockReturnValue(true);
    const captureUnreadEntryBoundary = vi.fn().mockReturnValue(undefined);
    Object.assign(component, {
      scrollState,
      scroller: {
        getMountedGeometry: (seq: number) => ({ item: { id: seq } }),
        mutateItem,
      },
      convList: { captureUnreadEntryBoundary },
      updateStickyOverlays: vi.fn(),
      pendingDividerRefresh: [],
    });

    component['applyUnreadDivider'](42);
    expect(scrollState.firstUnreadSeq).toBeNull();
    expect(mutateItem).toHaveBeenCalledTimes(1);
    expect(mutateItem.mock.calls[0][0]).toBe(11);

    captureUnreadEntryBoundary.mockReturnValue({ firstUnreadSeq: 20 });
    component['applyUnreadDivider'](42);
    expect(scrollState.firstUnreadSeq).toBe(20);
    expect(mutateItem.mock.calls[1][0]).toBe(20);
    component['applyUnreadDivider'](42);
    expect(mutateItem).toHaveBeenCalledTimes(2);
  });
});
