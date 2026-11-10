import { NEVER, of, Subject } from 'rxjs';
import {
  ChatBoxScroller,
  type CbItem,
} from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
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
      nav: { chatOpening: signal(null) },
      convList: { latestSeq: () => undefined },
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

  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'erases sender and payload while preserving date context when a mounted message becomes %s',
    (deletionType) => {
      const { component } = pane();
      const item = {
        id: 12,
        clientMessageId: 'old-send',
        data: {
          threadId: 6,
          isGroupConversation: true,
          creator: 'alice',
          name: 'Alice',
          sender: { account: 'alice' },
          text: 'erased text',
          time: '12:30',
          createdAtMs: 1700000000000,
          quote: { seq: 3, body: 'erased quote' },
        },
      };
      expect(component.deletedPlaceholder(item, 12, deletionType)).toEqual({
        id: 12,
        data: {
          type: 'system',
          contentType: 'SYSTEM',
          threadId: 6,
          msgId: 12,
          isGroupConversation: true,
          isSelf: false,
          name: '',
          text: '',
          time: '',
          createdAtMs: 1700000000000,
          images: null,
          file: null,
          deletionType,
        },
      });
    },
  );

  it('mutates a mounted album exactly once while the thread subscription cleans detached surfaces', async () => {
    const { component } = pane();
    const deletedLive$ = new Subject<{
      threadId: number;
      deletions: { seq: number; type: 'MODERATION_REMOVAL' }[];
    }>();
    let mounted: any[] = [
      {
        id: 10,
        ids: [10, 11, 12],
        boundary: 'both',
        data: {
          type: 'msg',
          contentType: 'IMAGE',
          msgId: 10,
          threadId: 6,
          creator: 'alice',
          name: 'Alice',
          text: '',
          time: '12:30',
          createdAtMs: 1234,
          images: [10, 11, 12].map((msgId) => ({
            msgId,
            kind: 'image',
            src: `/${msgId}`,
            w: 10,
            h: 10,
          })),
        },
      },
    ];
    Object.assign(component, {
      msgRepo: { deletedLive$, getMessageDeletions: vi.fn().mockResolvedValue([]) },
      galleryViewer: { closeIfDeleted: vi.fn() },
      fileDetail: { closeIfDeleted: vi.fn() },
      messageInteraction: { removeMessage: vi.fn() },
      openMessageWindow: vi.fn(),
      reload: vi.fn(),
    });
    component.scroller.mutateItem = vi.fn((id, mutate) => {
      const index = mounted.findIndex(
        (item) => item.id === id || item.ids?.includes(id),
      );
      if (index < 0) return false;
      const replacement = mutate(mounted[index]);
      mounted.splice(
        index,
        1,
        ...(Array.isArray(replacement) ? replacement : [replacement]),
      );
      return true;
    });
    component.bind();
    delete component.initScroller;
    component.initScroller(component.userMsgTrd());
    const rendered = { el: document.createElement('div'), update: vi.fn(), destroy: vi.fn() };
    component.scroller.getMountedGeometry = (seq: number) =>
      mounted.some((item) => item.id === seq || item.ids?.includes(seq)) ? { el: rendered.el } : null;
    component.bindMessageDeletion(rendered, mounted[0]);
    deletedLive$.next({
      threadId: 99,
      deletions: [{ seq: 11, type: 'MODERATION_REMOVAL' }],
    });
    expect(component.scroller.mutateItem).not.toHaveBeenCalled();
    deletedLive$.next({
      threadId: 6,
      deletions: [{ seq: 11, type: 'MODERATION_REMOVAL' }],
    });
    // Cleanup is synchronous, but only the mounted observer may mutate the row.
    expect(component.scroller.mutateItem).not.toHaveBeenCalled();
    expect(component.galleryViewer.closeIfDeleted).toHaveBeenCalledExactlyOnceWith(6, 11);
    expect(component.fileDetail.closeIfDeleted).toHaveBeenCalledExactlyOnceWith(6, 11);
    expect(component.messageInteraction.removeMessage).toHaveBeenCalledExactlyOnceWith(11);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.scroller.mutateItem).toHaveBeenCalledTimes(1);
    expect(mounted.map((item) => item.id)).toEqual([10, 11, 12]);
    expect(mounted[1].data).toMatchObject({
      type: 'system',
      name: '',
      text: '',
      time: '',
      createdAtMs: 1234,
      deletionType: 'MODERATION_REMOVAL',
    });
    expect(mounted[1].data.creator).toBeUndefined();
    expect(mounted[0].boundary).toBe('oldest');
    expect(mounted[2].boundary).toBe('newest');
    expect(component.reload).not.toHaveBeenCalled();
    rendered.destroy();
    mounted = [];
    component.scroller.mutateItem.mockClear();
    component.galleryViewer.closeIfDeleted.mockClear();
    component.fileDetail.closeIfDeleted.mockClear();
    component.messageInteraction.removeMessage.mockClear();
    // An open gallery/file/menu can still own an unmounted message.
    deletedLive$.next({
      threadId: 6,
      deletions: [{ seq: 12, type: 'MODERATION_REMOVAL' }],
    });
    await Promise.resolve();
    expect(mounted).toEqual([]);
    expect(component.scroller.mutateItem).not.toHaveBeenCalled();
    expect(component.galleryViewer.closeIfDeleted).toHaveBeenCalledExactlyOnceWith(6, 12);
    expect(component.fileDetail.closeIfDeleted).toHaveBeenCalledExactlyOnceWith(6, 12);
    expect(component.messageInteraction.removeMessage).toHaveBeenCalledExactlyOnceWith(12);
    component.deletionSurfaceSubscription.unsubscribe();
    expect(deletedLive$.observed).toBe(false);
  });

  it('does not run a second deletion path from a withdrawal HTTP acknowledgement', () => {
    const { component } = pane();
    Object.assign(component, {
      threadAdapter: { withdrawMessage: vi.fn(() => of({ code: BusinessCode.OK })) },
      replaceMountedDeletedMessage: vi.fn(),
      closeDeletedMessageSurfaces: vi.fn(),
    });
    component.withdrawMessage(6, 10);
    expect(component.threadAdapter.withdrawMessage).toHaveBeenCalledExactlyOnceWith({ threadId: 6, seq: 10 });
    expect(component.replaceMountedDeletedMessage).not.toHaveBeenCalled();
    expect(component.closeDeletedMessageSurfaces).not.toHaveBeenCalled();
  });

  it('rechecks after real scroller mounting when deletion raced an earlier body read', async () => {
    const { component } = pane();
    component.bind();
    const deletedLive$ = new Subject<{
      threadId: number;
      deletions: { seq: number; type: 'MODERATION_REMOVAL' }[];
    }>();
    const fact = { seq: 10, type: 'MODERATION_REMOVAL' } as const;
    const stale = {
      id: 10,
      boundary: 'both',
      data: {
        type: 'msg',
        msgId: 10,
        threadId: 6,
        name: 'Alice',
        text: 'private',
        createdAtMs: 1234,
      },
    } as CbItem<ChatItemData>;
    const viewport = document.createElement('div');
    const content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', { get: () => 600 });
    const getMessageDeletions = vi.fn(async () => {
      expect(scroller.getMountedGeometry(10)?.el.parentNode).toBe(content);
      // A duplicate event racing the durable result must not revive or reapply the body.
      deletedLive$.next({ threadId: 6, deletions: [fact] });
      return [fact];
    });
    Object.assign(component, {
      msgRepo: { deletedLive$, getMessageDeletions },
      galleryViewer: { closeIfDeleted: vi.fn() },
      fileDetail: { closeIfDeleted: vi.fn() },
      messageInteraction: { removeMessage: vi.fn() },
    });
    const scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      config: { deferInitFill: true, followBottom: false },
      hooks: {
        createItem: () => {
          const el = document.createElement('div');
          Object.defineProperty(el, 'offsetHeight', { get: () => 24 });
          return {
            el,
            update: () => {},
            destroy: () => {},
            onHeightChange: () => () => {},
          };
        },
      },
      onItemMounted: (item, element) =>
        component.bindMessageDeletion(element, item),
    });
    component.scroller = scroller;
    let firstRead = true;
    const source = () => ({
      init: async () => {
        if (!firstRead) return [];
        firstRead = false;
        // The body has been read, but the DOM has not mounted and misses this signal.
        deletedLive$.next({ threadId: 6, deletions: [fact] });
        return [stale];
      },
      requestOlder: () => of({ kind: 'boundary' as const }),
      requestNewer: () => NEVER,
      getPending: () => [],
      pushLive: () => {},
      destroy: () => {},
    });
    try {
      scroller.bind(source());
      await scroller.init();
      await Promise.resolve();
      await Promise.resolve();
      expect(getMessageDeletions).toHaveBeenCalledExactlyOnceWith(6, [10]);
      expect(scroller.getMountedGeometry(10)?.item.data).toMatchObject({
        type: 'system',
        deletionType: 'MODERATION_REMOVAL',
        name: '',
        text: '',
        time: '',
      });
      // The mounted observer owns only the row, not detached UI surfaces.
      expect(component.messageInteraction.removeMessage).not.toHaveBeenCalled();
      scroller.unbind();
      scroller.bind(source());
      await scroller.init();
      expect(scroller.getInfo().mounted).toBe(0);
      expect(deletedLive$.observed).toBe(false);
    } finally {
      scroller.destroy();
      viewport.remove();
    }
  });

  it('rechecks the mounted body and rejects a stale result after DOM ownership changes', async () => {
    const { component } = pane();
    component.bind();
    const deletedLive$ = new Subject();
    let resolve!: (value: unknown) => void;
    component.msgRepo = {
      deletedLive$,
      getMessageDeletions: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    };
    component.replaceMountedDeletedMessage = vi.fn();
    const rendered = {
      el: document.createElement('div'),
      update: vi.fn(),
      destroy: vi.fn(),
    };
    const item = { id: 10, data: { type: 'msg' } };
    let mountedEl = rendered.el;
    component.scroller.getMountedGeometry = () => ({ el: mountedEl });
    component.bindMessageDeletion(rendered, item);
    resolve([{ seq: 10, type: 'MODERATION_REMOVAL' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.replaceMountedDeletedMessage).toHaveBeenCalledExactlyOnceWith(
      10,
      'MODERATION_REMOVAL',
    );
    rendered.destroy();
    component.replaceMountedDeletedMessage.mockClear();
    const replacement = {
      el: document.createElement('div'),
      update: vi.fn(),
      destroy: vi.fn(),
    };
    mountedEl = replacement.el;
    component.bindMessageDeletion(replacement, item);
    const staleResolve = resolve;
    replacement.destroy();
    const successor = {
      el: document.createElement('div'),
      update: vi.fn(),
      destroy: vi.fn(),
    };
    mountedEl = successor.el;
    component.bindMessageDeletion(successor, item);
    staleResolve([{ seq: 10, type: 'MODERATION_REMOVAL' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.replaceMountedDeletedMessage).not.toHaveBeenCalled();
    resolve([{ seq: 10, type: 'USER_RETRACTION' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.replaceMountedDeletedMessage).toHaveBeenCalledExactlyOnceWith(
      10,
      'USER_RETRACTION',
    );
    successor.destroy();
    expect(deletedLive$.observed).toBe(false);
  });

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

  it('refreshes a warm source from reactive opening and live heads without remounting or scrolling', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    try {
      const { component, thread } = pane();
      const latest = signal(10);
      component.convList.latestSeq = () => latest();
      const refreshLatest = vi.fn();
      component.source = { refreshLatest };
      component.scroller.scrollToBottom = vi.fn();
      component.bind();
      thread.update((value) => ({ ...value, messageEndSeq: 10 }));
      TestBed.runInInjectionContext(() =>
        effect(() => component.synchronizeKernel()),
      );
      await TestBed.inject(ApplicationRef).whenStable();
      expect(refreshLatest).toHaveBeenLastCalledWith(10);
      latest.set(13);
      await TestBed.inject(ApplicationRef).whenStable();
      expect(refreshLatest).toHaveBeenLastCalledWith(13);
      component.nav.chatOpening.set({ threadId: 6, latestSeq: 15 });
      await TestBed.inject(ApplicationRef).whenStable();
      expect(refreshLatest).toHaveBeenLastCalledWith(15);
      component.nav.chatOpening.set({ threadId: 7, latestSeq: 100 });
      await TestBed.inject(ApplicationRef).whenStable();
      expect(refreshLatest).toHaveBeenLastCalledWith(13);
      expect(component.initScroller).toHaveBeenCalledTimes(1);
      expect(component.scroller.scrollToBottom).not.toHaveBeenCalled();
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

  it('teardown cancels the re-anchor timer and releases the deletion subscription', () => {
    vi.useFakeTimers();
    try {
      const { component } = pane();
      delete component.teardown;
      const reanchor = vi.fn();
      const unsubscribe = vi.fn();
      Object.assign(component, {
        deletionSurfaceSubscription: { unsubscribe },
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
      expect(component.deletionSurfaceSubscription).toBeUndefined();
      expect(component.unreadReanchorTimer).toBeUndefined();
      vi.runAllTimers();
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
      deletionSurfaceSubscription: { unsubscribe: deletionRelease },
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
