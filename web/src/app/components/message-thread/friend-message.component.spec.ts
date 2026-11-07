import { Subject } from 'rxjs';
import {
  ApplicationRef,
  effect,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MessageThreadComponent } from './friend-message.component';
import { ChatSurfaceLifecycle } from './chat-surface-lifecycle';
import { createP2PConversation } from '../../services/model';
import { ThreadScrollController } from './thread-scroll.controller';
import { BusinessCode } from '../../services/biz-code';

describe('MessageThreadComponent binding lifecycle', () => {
  function pane(blocked = false) {
    const thread = signal(
      createP2PConversation({
        threadId: 6,
        account: 'liam',
        publisherNamespaceId: 1,
        profileRev: 1,
        blocked,
      }),
    );
    const component = Object.create(MessageThreadComponent.prototype);
    const lifecycle = new ChatSurfaceLifecycle();
    Object.assign(component, {
      lifecycle,
      windowJumpState: signal('idle'),
      presentation: signal('unbound'),
      userMsgTrd: thread,
      viewportRef: () => ({ nativeElement: {} }),
      contentRef: () => ({ nativeElement: {} }),
      scroller: { unbind: vi.fn(), destroy: vi.fn() },
      chatInput: () => ({ unbind: vi.fn() }),
      hideNativeComposer: vi.fn(),
      blockedPeer: () => thread().blocked,
      initialLoading: signal(true),
      initialLoadFailed: signal(false),
      unreadDividerReady: signal(false),
      ready: { emit: vi.fn() },
      teardown: vi.fn(),
      initScroller: vi.fn(),
    });
    lifecycle.state$.subscribe((state) => component.applyLifecycle(state));
    return { component, thread, lifecycle };
  }

  it('does not bind from reactive metadata, even when a different thread arrives', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    try {
      const { component, thread, lifecycle } = pane();
      TestBed.runInInjectionContext(() =>
        effect(() => component.synchronizeKernel()),
      );
      await TestBed.inject(ApplicationRef).whenStable();
      expect(component.initScroller).not.toHaveBeenCalled();
      component.bind();
      expect(component.initScroller).toHaveBeenCalledTimes(1);
      const old = lifecycle.binding!;
      component.unbind();
      expect(old.signal.aborted).toBe(true);
      thread.update((value) => ({ ...value, muted: true, messageEndSeq: 12 }));
      await TestBed.inject(ApplicationRef).whenStable();
      expect(component.initScroller).toHaveBeenCalledTimes(1);
      thread.update((value) => ({ ...value, threadId: 7 }));
      await TestBed.inject(ApplicationRef).whenStable();
      expect(component.initScroller).toHaveBeenCalledTimes(1);
      component.bind();
      expect(component.initScroller).toHaveBeenCalledTimes(2);
      expect(lifecycle.binding?.threadId).toBe(7);
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('blocked binds settle without a source and unblock initializes the existing surface', async () => {
    const { component, thread, lifecycle } = pane(true);
    component.bind();
    await Promise.resolve();
    expect(component.ready.emit).toHaveBeenCalledWith(6);
    expect(component.isWarm()).toBe(true);
    expect(component.initScroller).not.toHaveBeenCalled();
    thread.update((value) => ({ ...value, blocked: false }));
    component.synchronizeKernel();
    expect(component.initScroller).toHaveBeenCalledTimes(1);
    expect(lifecycle.state().phase).toBe('bound');
    expect(component.presentation()).toBe('loading');
  });

  it('reports blocked presentation synchronously and does not queue stale ready events', async () => {
    const { component } = pane(true);
    component.bind();
    expect(component.ready.emit).toHaveBeenCalledExactlyOnceWith(6);
    component.ready.emit.mockClear();
    component.unbind();
    await Promise.resolve();
    expect(component.ready.emit).not.toHaveBeenCalled();
    component.bind();
    expect(component.ready.emit).toHaveBeenCalledExactlyOnceWith(6);
  });

  it.each(['resolve', 'reject'] as const)(
    'unbind cancels init delivery before a late %s',
    async (outcome) => {
      const { component, thread } = pane();
      delete component.initScroller;
      delete component.teardown;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const source = { getPending: () => [], finishLocalInit: vi.fn() };
      const deleted = new Subject();
      const scroller = {
        bind: vi.fn(),
        init: () => pending,
        unbind: vi.fn(),
        backfillOlder: vi.fn(() => Promise.resolve()),
      };
      Object.assign(component, {
        scroller,
        msgRepo: { deletedLive$: deleted },
        threadAdapter: { createSource: () => source },
        optimistic: { bind: vi.fn(), reset: vi.fn() },
        transferStackRef: () => undefined,
        contentRef: () => ({ nativeElement: { querySelector: () => null } }),
        convList: { previewUnreadEntryBoundary: () => null },
        scrollState: { open: vi.fn(), reset: vi.fn() },
        cancelPaste: vi.fn(),
        nativeDraft: { reset: vi.fn() },
        messageInteraction: { reset: vi.fn() },
        stableRead: { flush: vi.fn(), reset: vi.fn() },
        stickyOverlays: () => undefined,
      });
      component.bind();
      expect(deleted.observed).toBe(true);
      component.unbind();
      expect(deleted.observed).toBe(false);
      expect(scroller.unbind).toHaveBeenCalled();
      expect(component.initializationSubscription).toBeUndefined();
      if (outcome === 'resolve') resolve();
      else reject(new Error('cancelled initial load'));
      await Promise.resolve();
      await Promise.resolve();
      expect(component.presentation()).toBe('unbound');
      expect(component.initialLoadFailed()).toBe(false);
      expect(component.ready.emit).not.toHaveBeenCalled();
      expect(source.finishLocalInit).not.toHaveBeenCalled();
      expect(scroller.backfillOlder).not.toHaveBeenCalled();
    },
  );

  it('local navigation bypasses asynchronous coordinate resolution and cancelled search stays silent', async () => {
    const { component } = pane();
    const resolveHistoryAnchor = vi.fn();
    const scrollToIndex = vi.fn().mockResolvedValue(false);
    const warn = vi.fn();
    Object.assign(component, {
      source: { resolveHistoryAnchor },
      scroller: { scrollToIndex },
      toast: { warn },
    });
    await component.onSearchJump(10);
    expect(resolveHistoryAnchor).not.toHaveBeenCalled();
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(10, 'center', true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a local jump cancels pending origin resolution synchronously', async () => {
    const { component } = pane();
    let signal!: AbortSignal;
    let resolve!: (seq: number) => void;
    const scrollToIndex = vi.fn().mockResolvedValue(true);
    const warn = vi.fn();
    Object.assign(component, {
      scroller: { scrollToIndex },
      toast: { warn },
      source: {
        resolveHistoryAnchor: (_anchor: object, cancellation: AbortSignal) => {
          signal = cancellation;
          return new Promise<number>((yes) => {
            resolve = yes;
          });
        },
      },
    });
    const old = component.jumpToHistoryAnchor({
      kind: 'origin',
      namespaceId: 1,
      originSeq: 2,
    });
    const latest = component.jumpToMessage(20);
    expect(signal.aborted).toBe(true);
    expect(await old).toBe(false);
    expect(await latest).toBe(true);
    resolve(10);
    await Promise.resolve();
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(20, 'center', true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'only the latest origin navigation receives a late %s',
    async (outcome) => {
      const { component } = pane();
      const pending: Array<{
        resolve(seq: number): void;
        reject(error: Error): void;
        signal: AbortSignal;
      }> = [];
      const scrollToIndex = vi.fn().mockResolvedValue(true);
      const warn = vi.fn();
      Object.assign(component, {
        scroller: { scrollToIndex },
        toast: { warn },
        source: {
          resolveHistoryAnchor: (_anchor: object, signal: AbortSignal) =>
            new Promise<number>((resolve, reject) => {
              pending.push({ resolve, reject, signal });
            }),
        },
      });
      const first = component.jumpToHistoryAnchor({
        kind: 'origin',
        namespaceId: 1,
        originSeq: 10,
      });
      const second = component.jumpToHistoryAnchor({
        kind: 'origin',
        namespaceId: 1,
        originSeq: 20,
      });
      expect(await first).toBe(false);
      expect(pending[0].signal.aborted).toBe(true);
      expect(pending[1].signal.aborted).toBe(false);
      pending[1].resolve(200);
      expect(await second).toBe(true);
      if (outcome === 'resolve') pending[0].resolve(100);
      else pending[0].reject(new Error('old origin failure'));
      await Promise.resolve();
      expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(
        200,
        'center',
        true,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(component.anchorSubscription).toBeUndefined();
      expect(component.anchorRequest).toBeUndefined();
    },
  );

  it('a synchronous origin error cannot overwrite the subscription of a reentrant successor', async () => {
    const { component } = pane();
    let resolve!: (seq: number) => void;
    const scrollToIndex = vi.fn().mockResolvedValue(true);
    const lookup = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('synchronous lookup failure');
      })
      .mockImplementationOnce(
        () =>
          new Promise<number>((yes) => {
            resolve = yes;
          }),
      );
    let successor!: Promise<boolean>;
    Object.assign(component, {
      scroller: { scrollToIndex },
      source: { resolveHistoryAnchor: lookup },
      transloco: { translate: (key: string) => key },
      toast: {
        warn: vi.fn(() => {
          successor = component.jumpToHistoryAnchor({
            kind: 'origin',
            namespaceId: 1,
            originSeq: 20,
          });
        }),
      },
    });
    expect(
      await component.jumpToHistoryAnchor({
        kind: 'origin',
        namespaceId: 1,
        originSeq: 10,
      }),
    ).toBe(false);
    component.stopAnchorResolution();
    expect(await successor).toBe(false);
    resolve(200);
    await Promise.resolve();
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(component.toast.warn).toHaveBeenCalledExactlyOnceWith(
      'chat.messageJumpFailed',
    );
  });

  it('does not restart a binding that is already loading', () => {
    const { component } = pane();
    component.bind();
    component.bind();
    expect(component.initScroller).toHaveBeenCalledTimes(1);
  });

  it('teardown cancels deletion/re-anchor timers and releases the deletion subscription', () => {
    vi.useFakeTimers();
    try {
      const { component } = pane();
      delete component.teardown;
      const reload = vi.fn();
      const reanchor = vi.fn();
      const unsubscribe = vi.fn();
      Object.assign(component, {
        deletionSubscription: { unsubscribe },
        deletionReloadTimer: setTimeout(reload, 0),
        unreadReanchorTimer: setTimeout(reanchor, 0),
        cancelPaste: vi.fn(),
        nativeDraft: { reset: vi.fn() },
        messageInteraction: { reset: vi.fn() },
        stableRead: { flush: vi.fn(), reset: vi.fn() },
        scrollState: { reset: vi.fn() },
        stickyOverlays: () => undefined,
        optimistic: { reset: vi.fn() },
      });
      component.teardown();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(component.deletionSubscription).toBeUndefined();
      expect(component.deletionReloadTimer).toBeUndefined();
      expect(component.unreadReanchorTimer).toBeUndefined();
      vi.runAllTimers();
      expect(reload).not.toHaveBeenCalled();
      expect(reanchor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('window replacement settles cancelled navigation and keeps the same conversation', async () => {
    const { component, lifecycle } = pane();
    component.bind();
    const binding = lifecycle.binding;
    Object.assign(component, {
      openMessageWindow: vi.fn(),
      stableRead: { flush: vi.fn(), reset: vi.fn() },
      scrollState: { reset: vi.fn() },
      stickyOverlays: () => undefined,
      optimistic: { reset: vi.fn() },
    });
    const first = component.replaceMessageWindow({ startMsgId: 10 });
    const second = component.replaceMessageWindow({ startMsgId: 20 });
    expect(await first).toBe(false);
    expect(component.windowJumpState()).toBe('loading');
    expect(lifecycle.binding).toBe(binding);
    expect(binding?.signal.aborted).toBe(false);
    expect(component.openMessageWindow).toHaveBeenCalledTimes(2);
    component.closeMessageWindow();
    expect(await second).toBe(false);
    expect(component.windowJumpState()).toBe('idle');
  });

  it('closing only the message window keeps conversation and composer ownership', () => {
    const { component, lifecycle } = pane();
    component.bind();
    const binding = lifecycle.binding;
    const resetDraft = vi.fn();
    const cancelPaste = vi.fn();
    const deletionRelease = vi.fn();
    const initRelease = vi.fn();
    Object.assign(component, {
      initializationSubscription: { unsubscribe: initRelease },
      deletionSubscription: { unsubscribe: deletionRelease },
      cancelPaste,
      nativeDraft: { reset: resetDraft },
      stableRead: { flush: vi.fn(), reset: vi.fn() },
      scrollState: { reset: vi.fn() },
      stickyOverlays: () => undefined,
      optimistic: { reset: vi.fn() },
    });
    const kernel = component.scroller;
    // Ignore the lifecycle's initial Unbound replay before this operation.
    component.hideNativeComposer.mockClear();
    component.closeMessageWindow();
    expect(initRelease).toHaveBeenCalledOnce();
    expect(kernel.unbind).toHaveBeenCalledOnce();
    expect(component.scroller).toBe(kernel);
    expect(lifecycle.binding).toBe(binding);
    expect(binding?.signal.aborted).toBe(false);
    expect(deletionRelease).not.toHaveBeenCalled();
    expect(resetDraft).not.toHaveBeenCalled();
    expect(cancelPaste).not.toHaveBeenCalled();
    expect(component.hideNativeComposer).not.toHaveBeenCalled();
  });

  it('releases messages but retains the prepared kernel during teardown', () => {
    const { component } = pane();
    delete component.teardown;
    Object.assign(component, {
      cancelPaste: vi.fn(),
      nativeDraft: { reset: vi.fn() },
      messageInteraction: { reset: vi.fn() },
      stableRead: { flush: vi.fn(), reset: vi.fn() },
      scrollState: { reset: vi.fn() },
      stickyOverlays: () => undefined,
      optimistic: { reset: vi.fn() },
    });
    const kernel = component.scroller;
    component.teardown();
    expect(kernel.unbind).toHaveBeenCalledOnce();
    expect(kernel.destroy).not.toHaveBeenCalled();
    expect(component.scroller).toBe(kernel);
  });

  it('presents initialization failure as a bound retry surface', async () => {
    const { component, thread, lifecycle } = pane();
    delete component.initScroller;
    const error = new Error('history unavailable');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(component, {
      msgRepo: { deletedLive$: new Subject() },
      threadAdapter: {
        createSource: () => ({ getPending: () => [], destroy: vi.fn() }),
      },
      scroller: { bind: vi.fn(), init: () => Promise.reject(error) },
      optimistic: { bind: vi.fn() },
      transferStackRef: () => undefined,
      contentRef: () => undefined,
      convList: { previewUnreadEntryBoundary: () => undefined },
      scrollState: { open: vi.fn(), firstUnreadSeq: null },
    });
    lifecycle.bind(6);
    await vi.waitFor(() => expect(component.initialLoadFailed()).toBe(true));
    expect(component.isWarm()).toBe(true);
    expect(component.ready.emit).toHaveBeenCalledWith(6);
    component.reload = vi.fn();
    component.closeMessageWindow = vi.fn();
    component.openMessageWindow = vi.fn();
    const binding = lifecycle.binding;
    component.retryInitialLoad();
    expect(component.reload).not.toHaveBeenCalled();
    expect(component.closeMessageWindow).toHaveBeenCalledOnce();
    expect(component.openMessageWindow).toHaveBeenCalledExactlyOnceWith(
      component.userMsgTrd(),
    );
    expect(lifecycle.binding).toBe(binding);
    expect(binding?.signal.aborted).toBe(false);
    expect(component.initialLoading()).toBe(true);
    expect(component.initialLoadFailed()).toBe(false);
    warning.mockRestore();
  });
});

describe('MessageThreadComponent independent contracts', () => {
  it.each([BusinessCode.FRIEND_NOT_FOUND, BusinessCode.GROUP_DISSOLVED])(
    'reports business failure %s without altering relationship projections',
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
      component.surfaceSendFailure({ code, message: 'business refusal' });
      expect(warn).toHaveBeenCalledOnce();
      expect(applyThreadMeta).not.toHaveBeenCalled();
      expect(applyGroupUpdate).not.toHaveBeenCalled();
    },
  );

  it('does not replay native draft events through draft-store signal dependencies', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    try {
      const component = Object.create(MessageThreadComponent.prototype);
      const event = signal<{ kind: 'draft'; text: string } | null>(null);
      const stored = signal(0);
      const save = vi.fn(() => {
        stored();
        stored.update((value) => value + 1);
      });
      Object.assign(component, {
        nativeComposerThreadId: 42,
        nativeDraft: { set: vi.fn(), save },
      });
      TestBed.runInInjectionContext(() =>
        effect(() => {
          const value = event();
          if (value) component.handleNativeComposerEvent(value as never);
        }),
      );
      event.set({ kind: 'draft', text: 'hello' });
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      await TestBed.inject(ApplicationRef).whenStable();
      expect(stored()).toBe(1);
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('saves native text before sending and clears the persisted draft', () => {
    const component = Object.create(MessageThreadComponent.prototype);
    const text = signal('');
    const save = vi.fn(() => text());
    Object.assign(component, {
      nativeComposerThreadId: 42,
      nativeDraft: { set: text.set.bind(text), clearLink: vi.fn(), save },
      nativeComposer: { acknowledge: vi.fn() },
      onSendIntent: vi.fn(),
    });
    component.handleNativeComposerEvent({ kind: 'draft', text: 'hello' });
    expect(save).toHaveReturnedWith('hello');
    component.handleNativeComposerEvent({
      kind: 'sendText',
      text: 'hello',
      actionId: 1,
    });
    expect(save).toHaveReturnedWith('');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a native attachment picker %s after same-thread rebind',
    async (outcome) => {
      const component = Object.create(MessageThreadComponent.prototype);
      const lifecycle = new ChatSurfaceLifecycle();
      lifecycle.bind(42);
      let resolve!: (value: unknown[]) => void;
      let reject!: (error: Error) => void;
      const onSendIntent = vi.fn();
      const acknowledge = vi.fn();
      const warn = vi.fn();
      Object.assign(component, {
        lifecycle,
        onSendIntent,
        nativeUploads: {
          pick: () =>
            new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        },
        nativeComposer: { acknowledge },
        toast: { warn },
        transloco: { translate: (key: string) => key },
      });
      const pending = component.pickNativeComposerAttachment({
        source: 'gallery',
        actionId: 1,
      });
      lifecycle.unbind();
      lifecycle.bind(42);
      if (outcome === 'resolve') resolve([{ path: 'old' }]);
      else reject(new Error('old picker failure'));
      await pending;
      expect(onSendIntent).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'failure'] as const)(
    'does not display an old quote navigation %s after unbind',
    async (outcome) => {
      const component = Object.create(MessageThreadComponent.prototype);
      let resolve!: (value: null) => void;
      let reject!: (error: Error) => void;
      const warn = vi.fn();
      Object.assign(component, {
        scroller: { scrollToIndex: vi.fn() },
        source: {
          resolveHistoryAnchor: () =>
            new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        },
        toast: { warn },
        transloco: { translate: (key: string) => key },
      });
      const pending = component.jumpToQuoteAnchor({
        kind: 'origin',
        namespaceId: 1,
        originSeq: 1,
      });
      component.stopAnchorResolution();
      component.source = undefined;
      if (outcome === 'missing') resolve(null);
      else reject(new Error('cancelled'));
      await pending;
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(['sendChosenWebAttachments', 'sendChosenNativeAttachments'])(
    'does not submit %s when confirmation outlives its binding',
    async (method) => {
      const component = Object.create(MessageThreadComponent.prototype);
      const lifecycle = new ChatSurfaceLifecycle();
      lifecycle.bind(42);
      let confirm!: (value: boolean) => void;
      const submit = vi.fn();
      Object.assign(component, {
        lifecycle,
        chooseCombinedSend: () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
        sendWebGallery: submit,
        sendNativeGallery: submit,
        sendAttachments: submit,
        sendNativeAttachments: submit,
      });
      const pending = component[method]([{}, {}]);
      lifecycle.unbind();
      lifecycle.bind(42);
      confirm(true);
      await pending;
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('replaces unread dividers in place', () => {
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
    component.applyUnreadDivider(42);
    expect(scrollState.firstUnreadSeq).toBeNull();
    expect(mutateItem.mock.calls[0][0]).toBe(11);
    captureUnreadEntryBoundary.mockReturnValue({ firstUnreadSeq: 20 });
    component.applyUnreadDivider(42);
    component.applyUnreadDivider(42);
    expect(mutateItem).toHaveBeenCalledTimes(2);
  });
});
