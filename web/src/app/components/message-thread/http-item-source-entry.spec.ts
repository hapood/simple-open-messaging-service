import { firstValueFrom, Subject, of } from 'rxjs';
import { ProfileRepository } from '../../services/profile-store.service';
import { ProfileWatchService } from '../../services/profile-watch.service';
import { HttpItemSource } from './http-item-source';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  MessageRepository,
  type NativeMessageHistoryResult,
  type MessageHistoryIntervalPage,
} from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { MsgService } from '../../services/message.service';
import { createP2PConversation, type Message } from '../../services/model';
import { ChatBoxScroller } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';

function message(seq: number): Message {
  return {
    seq,
    originSeq: null,
    namespaceId: 0,
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    profileRev: 1,
    threadId: 42,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: `message ${seq}` }),
    creator: { account: 'alice', namespaceId: 0 },
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    isDeleted: false,
    localState: 'READY',
  };
}

afterEach(() => TestBed.resetTestingModule());

function setup(readSeq = 100) {
  const empty = (): NativeMessageHistoryResult => ({
    items: [],
    hasOlder: true,
    hasNewer: true,
    failed: false,
  });
  const query = vi.fn().mockImplementation(async () => empty());
  const pages = new Subject<MessageHistoryIntervalPage>();
  const watchHistoryInterval = vi.fn(() => pages);
  const repo = {
    slotsChanged$: new Subject<number>(),
    deletedLive$: new Subject(),
    historyHead$: new Subject(),
    reconnectSignal$: new Subject(),
    mediaStatusLive$: new Subject(),
    newestKnownSeq: () => 250,
    retainNewestSeq: vi.fn(),
    queryBrowserMessageHistory: query,
    queryNativeMessageHistory: query,
    watchHistoryInterval,
  };
  const users = {
    sessionProfile:
      signal<ReturnType<UserService['sessionProfile']>>(undefined),
  } satisfies Pick<UserService, 'sessionProfile'>;
  const outbox = {
    forThread: () => [],
    confirm: vi.fn(async () => {}),
  } satisfies Pick<ThreadSendOutbox, 'forThread' | 'confirm'>;
  TestBed.configureTestingModule({
    providers: [
      { provide: MessageRepository, useValue: repo },
      { provide: UserService, useValue: users },
      { provide: ThreadSendOutbox, useValue: outbox },
      { provide: MsgService, useValue: {} },
      ProfileRepository,
      { provide: ProfileWatchService, useValue: { watchProfile: () => of(null) } },
    ],
  });
  const conversation = createP2PConversation({
    threadId: 42,
    account: 'alice',
    publisherNamespaceId: 0,
    profileRev: 1,
  });
  conversation.messageEndSeq = 250;
  const source = new HttpItemSource(
    conversation,
    readSeq,
    TestBed.inject(MessageRepository),
    TestBed.inject(UserService),
    TestBed.inject(ThreadSendOutbox),
    {},
    TestBed.inject(MsgService),
    TestBed.inject(ProfileRepository),
  );
  return { source, query, empty, pages, watchHistoryInterval };
}

function mountKernel(source: HttpItemSource, height = 200) {
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  viewport.style.cssText = `height:${height}px;overflow:auto;`;
  viewport.append(content);
  document.body.append(viewport);
  const kernel = new ChatBoxScroller<ChatItemData>({
    viewport,
    content,
    config: { edge: 1, thresholdFloor: 20000 },
    hooks: {
      messageSeqs: (item) =>
        item.data.serverGap ? [] : (item.ids ?? [item.id]),
      createItem: (item, _previous, presentation) => {
        const el = document.createElement('div');
        el.style.height = '40px';
        el.dataset['presentation'] = presentation.kind;
        el.dataset['kind'] = item.data.serverGap ? 'gap' : 'message';
        if (item.data.serverGap) el.textContent = item.data.serverGap.state;
        return {
          el,
          update: () => {},
          destroy: () => el.remove(),
        };
      },
    },
  });
  kernel.bind(source, { chatId: 42 });
  return {
    kernel,
    viewport,
    content,
    destroy: () => {
      kernel.destroy();
      viewport.remove();
    },
  };
}

describe('HttpItemSource to kernel entry', () => {
  it('mounts the retained cache once and centers the read message before edge demand', async () => {
    const { source, query } = setup();
    query.mockResolvedValueOnce({
      items: Array.from({ length: 21 }, (_, index) => ({
        kind: 'message',
        message: message(90 + index),
      })),
      hasOlder: true,
      hasNewer: true,
      failed: false,
    });
    const mounted = mountKernel(source);
    try {
      const entry = await source.prepareEntry();
      await mounted.kernel.openWindow({
        kind: 'message',
        messageId: entry.lastReadSeq,
        anchor: 'center',
      });
      const target =
        mounted.content.querySelector<HTMLElement>('[data-cb-id="100"]');
      expect(target).not.toBeNull();
      const offset =
        target!.getBoundingClientRect().top -
        mounted.viewport.getBoundingClientRect().top;
      expect(offset).toBe(80);
      expect(mounted.kernel.getMountedGeometry(90)).not.toBeNull();
      expect(mounted.kernel.getMountedGeometry(110)).not.toBeNull();
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      mounted.destroy();
    }
  });

  it('retains an older server gap beside real cached messages', async () => {
    const { source, query } = setup();
    query.mockResolvedValueOnce({
      items: [
        { kind: 'serverGap', left: 90, right: 110, state: 'SERVER_PENDING' },
        { kind: 'message', message: message(111) },
      ],
      hasOlder: true,
      hasNewer: true,
      failed: false,
    });
    query.mockImplementation(
      () => new Promise<NativeMessageHistoryResult>(() => {}),
    );
    const mounted = mountKernel(source);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await source.prepareEntry();
      await mounted.kernel.openWindow({
        kind: 'message',
        messageId: 100,
        anchor: 'center',
      });
      const gap =
        mounted.content.querySelector<HTMLElement>('[data-kind="gap"]');
      expect(gap).not.toBeNull();
      expect(gap?.dataset['presentation']).toBe('message');
    } finally {
      warning.mockRestore();
      mounted.destroy();
    }
  });

  it('replaces a pending gap with an unavailable label at unchanged bounds without subscription churn', async () => {
    const { source, query, pages, watchHistoryInterval } = setup();
    const unavailable = new Subject<MessageHistoryIntervalPage>();
    watchHistoryInterval.mockReturnValueOnce(pages).mockReturnValue(unavailable);
    query.mockResolvedValueOnce({
      items: [
        { kind: 'serverGap', left: 90, right: 110, state: 'SERVER_PENDING' },
        { kind: 'message', message: message(111) },
      ],
      hasOlder: false, hasNewer: false, failed: false,
    });
    query.mockImplementation(() => new Promise<NativeMessageHistoryResult>(() => {}));
    const mounted = mountKernel(source);
    try {
      await mounted.kernel.openWindow({ kind: 'cached' });
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledOnce());
      const pending = mounted.content.querySelector<HTMLElement>('[data-kind="gap"]')!;
      const messageElement = mounted.kernel.getMountedGeometry(111)!.el;
      expect(pending.textContent).toBe('SERVER_PENDING');
      const unchangedBounds: MessageHistoryIntervalPage = {
        left: 90, right: 110,
        items: [{ kind: 'serverGap', left: 90, right: 110, state: 'SERVER_UNAVAILABLE' }],
      };
      pages.next(unchangedBounds);
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledTimes(2));
      const replacement = mounted.content.querySelector<HTMLElement>('[data-kind="gap"]')!;
      expect(replacement.textContent).toBe('SERVER_UNAVAILABLE');
      expect(replacement.dataset['cbId']).not.toBe(pending.dataset['cbId']);
      expect(pending.isConnected).toBe(false);
      expect(pages.observed).toBe(false);
      expect(unavailable.observed).toBe(true);
      expect(mounted.kernel.getMountedGeometry(111)!.el).toBe(messageElement);
      unavailable.next(unchangedBounds);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.content.querySelector('[data-kind="gap"]')).toBe(replacement);
      expect(watchHistoryInterval).toHaveBeenCalledTimes(2);
    } finally {
      mounted.destroy();
      expect(unavailable.observed).toBe(false);
    }
  });

  it('a short truncated cache starts both ordinary edges at its actual cursors', async () => {
    const { source, query } = setup();
    query.mockResolvedValueOnce({
      items: [99, 100, 101].map((seq) => ({
        kind: 'message',
        message: message(seq),
      })),
      hasOlder: true,
      hasNewer: true,
      failed: false,
    });
    query.mockImplementation(
      () => new Promise<NativeMessageHistoryResult>(() => {}),
    );
    const mounted = mountKernel(source, 400);
    try {
      await source.prepareEntry();
      await mounted.kernel.openWindow({
        kind: 'message',
        messageId: 100,
        anchor: 'center',
      });
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3));
      expect(query.mock.calls.slice(1).map((call) => call[1])).toEqual(
        expect.arrayContaining([
          { kind: 'older', before: 99, count: 50 },
          { kind: 'newer', after: 101, count: 50 },
        ]),
      );
      expect(
        mounted.content.querySelectorAll('[data-presentation="loading"]'),
      ).toHaveLength(2);
      const olderCall = query.mock.calls.find(
        (call) => call[1].kind === 'older',
      );
      mounted.kernel.unbind();
      expect(olderCall?.[2].aborted).toBe(true);
    } finally {
      mounted.destroy();
    }
  });
});

describe('HttpItemSource entry cache', () => {
  it.each([0, 100])(
    'retains a pure cache window around frozen R=%s',
    async (read) => {
      const { source, query } = setup(read);
      const seqs = read === 0 ? [1, 2] : [99, 100, 101];
      query.mockResolvedValue({
        items: seqs.map((seq) => ({ kind: 'message', message: message(seq) })),
        hasOlder: read > 0,
        hasNewer: true,
        failed: false,
      });
      try {
        const entry = await source.prepareEntry();
        expect(entry.lastReadSeq).toBe(read);
        expect(entry.hasCachedMessages).toBe(true);
        expect(query).toHaveBeenCalledExactlyOnceWith(
          42,
          {
            kind: 'localAround',
            anchor: read,
            olderCount: read > 0 ? 50 : 0,
            newerCount: 50,
          },
          expect.any(AbortSignal),
        );
        const result = await source.loadWindow(
          read === 0
            ? { kind: 'start', count: 100 }
            : {
                kind: 'around',
                messageId: read,
                olderCount: 50,
                newerCount: 50,
              },
        );
        expect(result.map((item) => item.id)).toEqual(seqs);
        expect(query).toHaveBeenCalledTimes(1);
      } finally {
        source.destroy();
      }
    },
  );

  it('waits for a real page when the retained seed contains only a gap', async () => {
    const { source, query, pages, watchHistoryInterval } = setup();
    query.mockResolvedValue({
      items: [
        { kind: 'serverGap', left: 90, right: 110, state: 'SERVER_PENDING' },
      ],
      hasOlder: true,
      hasNewer: true,
      failed: false,
    });
    try {
      await source.prepareEntry();
      const load = source.loadWindow({
        kind: 'around',
        messageId: 100,
        olderCount: 50,
        newerCount: 50,
      });
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledOnce());
      pages.next({ left: 100, right: 110, items: [{ kind: 'message', message: message(110) }] });
      const result = await load;
      expect(result).toHaveLength(2);
      expect(result[0].data.serverGap).toEqual({
        left: 90,
        right: 100,
        state: 'SERVER_PENDING',
      });
      expect(result[1].id).toBe(110);
      expect(pages.observed).toBe(false);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      source.destroy();
    }
  });

  it('consumes the local seed once and preserves surrounding rows when R is absent', async () => {
    const { source, query, empty } = setup();
    query.mockResolvedValueOnce({
      items: [99, 101].map((seq) => ({
        kind: 'message',
        message: message(seq),
      })),
      hasOlder: true,
      hasNewer: true,
      failed: false,
    });
    try {
      await source.prepareEntry();
      const request = {
        kind: 'around' as const,
        messageId: 100,
        olderCount: 50,
        newerCount: 50,
      };
      const result = await source.loadWindow(request);
      expect(result.map((item) => item.id)).toEqual([99, 101]);
      expect(query).toHaveBeenCalledTimes(1);
      query.mockResolvedValue(empty());
      await source.loadWindow(request);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1][1]).toEqual({
        kind: 'around',
        anchor: 100,
        olderCount: 50,
        newerCount: 50,
      });
    } finally {
      source.destroy();
    }
  });

  it('aborts a pending cache read on source destruction without publishing a late seed', async () => {
    const { source, query, empty } = setup();
    let resolve!: (result: NativeMessageHistoryResult) => void;
    query.mockImplementationOnce(
      () =>
        new Promise<NativeMessageHistoryResult>((done) => {
          resolve = done;
        }),
    );
    const preparation = source.prepareEntry();
    const rejected = expect(preparation).rejects.toMatchObject({
      name: 'AbortError',
    });
    source.destroy();
    resolve(empty());
    await rejected;
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses an ordinary around load only after an empty local read', async () => {
    const { source, query } = setup();
    try {
      expect((await source.prepareEntry()).hasCachedMessages).toBe(false);
      await source.loadWindow({
        kind: 'around',
        messageId: 100,
        olderCount: 50,
        newerCount: 50,
      });
      expect(query.mock.calls.map((call) => call[1])).toEqual([
        { kind: 'localAround', anchor: 100, olderCount: 50, newerCount: 50 },
        { kind: 'around', anchor: 100, olderCount: 50, newerCount: 50 },
      ]);
    } finally {
      source.destroy();
    }
  });

  it('does not treat a failed cache read as empty or request remote history', async () => {
    const { source, query } = setup();
    try {
      query.mockRejectedValueOnce(new Error('cache unavailable'));
      await expect(source.prepareEntry()).rejects.toThrow('cache unavailable');
      expect(query).toHaveBeenCalledTimes(1);
      await source.prepareEntry();
      expect(query.mock.calls[1][1].kind).toBe('localAround');
    } finally {
      source.destroy();
    }
  });
});

describe('HttpItemSource interval lifecycle', () => {
  const gap = (left: number, right: number) => ({
    kind: 'serverGap' as const, left, right, state: 'SERVER_PENDING' as const,
  });

  it('accumulates deleted scans instead of resurrecting an exhausted residual', async () => {
    const { source, query, pages, watchHistoryInterval } = setup();
    query.mockResolvedValue({ items: [gap(0, 100)], hasOlder: false, hasNewer: false, failed: false });
    try {
      const load = source.loadWindow({ kind: 'latest', count: 50 });
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledOnce());
      pages.next({ left: 50, right: 100, items: [] });
      pages.next({ left: 0, right: 50, items: [] });
      expect(await load).toEqual([]);
      expect(pages.observed).toBe(false);
    } finally { source.destroy(); }
  });

  it('does not discard sibling gaps when one cold interval is exhausted', async () => {
    const { source, query, watchHistoryInterval } = setup();
    const older = new Subject<MessageHistoryIntervalPage>();
    const newer = new Subject<MessageHistoryIntervalPage>();
    watchHistoryInterval.mockReturnValueOnce(older).mockReturnValueOnce(newer);
    query.mockResolvedValue({ items: [gap(0, 40), gap(60, 100)], hasOlder: false, hasNewer: false, failed: false });
    try {
      let resolved = false;
      const load = source.loadWindow({ kind: 'latest', count: 50 }).then((items) => { resolved = true; return items; });
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledTimes(2));
      older.next({ left: 0, right: 40, items: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
      newer.next({ left: 90, right: 100, items: [{ kind: 'message', message: message(100) }] });
      expect((await load).map((item) => item.displayInterval ?? item.id)).toEqual([{ left: 60, right: 90 }, 100]);
      expect(older.observed || newer.observed).toBe(false);
    } finally { source.destroy(); }
  });

  it.each(['error', 'abort', 'unavailable'] as const)('releases a cold interval on %s', async (reason) => {
    const { source, query, pages, watchHistoryInterval } = setup();
    query.mockResolvedValue({ items: [gap(0, 100)], hasOlder: false, hasNewer: false, failed: false });
    try {
      const load = source.loadWindow({ kind: 'latest', count: 50 });
      const rejection = expect(load).rejects.toBeDefined();
      await vi.waitFor(() => expect(watchHistoryInterval).toHaveBeenCalledOnce());
      if (reason === 'abort') source.destroy();
      else if (reason === 'error') pages.error(new Error('offline'));
      else pages.next({ left: 0, right: 100, items: [{ ...gap(0, 100), state: 'SERVER_UNAVAILABLE' }] });
      await rejection;
      expect(pages.observed).toBe(false);
    } finally { source.destroy(); }
  });

  it('does not create a transport consumer after source destruction', async () => {
    const { source, query, watchHistoryInterval } = setup();
    query.mockResolvedValue({ items: [gap(0, 100), { kind: 'message', message: message(101) }], hasOlder: false, hasNewer: false, failed: false });
    const [item] = await source.loadWindow({ kind: 'latest', count: 50 });
    const interval = source.watchInterval(item);
    source.destroy();
    const delivery = vi.fn();
    const subscription = interval.subscribe(delivery);
    expect(subscription.closed).toBe(true);
    expect(watchHistoryInterval).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });

  it('unsubscribing one interval preserves its sibling and suppresses queued shaping', async () => {
    const { source, query, pages } = setup();
    query.mockResolvedValue({ items: [gap(0, 100), { kind: 'message', message: message(101) }], hasOlder: false, hasNewer: false, failed: false });
    try {
      const [item] = await source.loadWindow({ kind: 'latest', count: 50 });
      const delivery = vi.fn();
      const siblingDelivery = vi.fn();
      const retired = source.watchInterval(item).subscribe(delivery);
      const sibling = source.watchInterval(item).subscribe(siblingDelivery);
      pages.next({ left: 20, right: 80, items: [{ kind: 'message', message: message(80) }] });
      retired.unsubscribe();
      await vi.waitFor(() => expect(siblingDelivery).toHaveBeenCalledOnce());
      expect(delivery).not.toHaveBeenCalled();
      expect(siblingDelivery.mock.calls[0][0].map((entry: { displayInterval?: unknown; id: number }) => entry.displayInterval ?? entry.id)).toEqual([{ left: 0, right: 20 }, 80, { left: 80, right: 100 }]);
      expect(pages.observed).toBe(true);
      sibling.unsubscribe();
      expect(pages.observed).toBe(false);
    } finally { source.destroy(); }
  });
});

describe('HttpItemSource request ownership', () => {
  it.each(['browser', 'native'] as const)(
    'retiring a gap aborts only its %s query consumer',
    async (host) => {
      const previous = Object.getOwnPropertyDescriptor(
        window,
        '__TAURI_INTERNALS__',
      );
      if (host === 'native')
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          value: {},
          configurable: true,
        });
      const { source, query, empty } = setup();
      try {
        const pending: Array<(result: NativeMessageHistoryResult) => void> = [];
        query.mockImplementation(
          () =>
            new Promise<NativeMessageHistoryResult>((resolve) =>
              pending.push(resolve),
            ),
        );
        const retiredDelivery = vi.fn();
        const siblingDelivery = vi.fn();
        const retired = source.requestOlder(101, 50).subscribe(retiredDelivery);
        const sibling = source.requestOlder(51, 50).subscribe(siblingDelivery);
        const retiredSignal = query.mock.calls[0][2] as AbortSignal;
        const siblingSignal = query.mock.calls[1][2] as AbortSignal;
        expect(query.mock.calls[0][1]).toEqual({
          kind: 'older',
          before: 101,
          count: 50,
        });
        retired.unsubscribe();
        expect(retiredSignal.aborted).toBe(true);
        expect(siblingSignal.aborted).toBe(false);
        pending[0](empty());
        pending[1](empty());
        await vi.waitFor(() => expect(siblingDelivery).toHaveBeenCalledOnce());
        expect(retiredDelivery).not.toHaveBeenCalled();
        expect(sibling.closed).toBe(true);
        const next = source.requestOlder(31, 50).subscribe();
        const nextSignal = query.mock.calls[2][2] as AbortSignal;
        expect(nextSignal.aborted).toBe(false);
        source.destroy();
        expect(nextSignal.aborted).toBe(true);
        next.unsubscribe();
      } finally {
        source.destroy();
        if (previous === undefined)
          Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        else Object.defineProperty(window, '__TAURI_INTERNALS__', previous);
      }
    },
  );

  it('retiring a newer request aborts its query and lets a replacement advance', async () => {
    const { source, query } = setup();
    try {
      await source.loadWindow({ kind: 'cached', count: 50 });
      query.mockImplementationOnce(() => new Promise<NativeMessageHistoryResult>(() => {}));
      const delivery = vi.fn();
      const retired = source.requestNewer(100, 50).subscribe(delivery);
      const retiredSignal = query.mock.calls[1][2] as AbortSignal;
      retired.unsubscribe();
      expect(retiredSignal.aborted).toBe(true);
      query.mockResolvedValueOnce({
        items: [{ kind: 'message', message: message(102) }],
        hasOlder: true, hasNewer: false, failed: false,
      });
      const result = await firstValueFrom(source.requestNewer(101, 50));
      expect(result.kind).toBe('items');
      if (result.kind === 'items') expect(result.items[0].id).toBe(102);
      expect(delivery).not.toHaveBeenCalled();
    } finally { source.destroy(); }
  });

  it('reports query errors and permits an independent retry', async () => {
    const { source, query } = setup();
    try {
      const error = new Error('offline');
      query.mockRejectedValueOnce(error);
      expect(await firstValueFrom(source.requestOlder(101, 50))).toEqual({
        kind: 'error',
        error,
      });
      expect(await firstValueFrom(source.requestOlder(101, 50))).toEqual({
        kind: 'boundary',
      });
      expect(query.mock.calls.map((call) => call[1])).toEqual([
        { kind: 'older', before: 101, count: 50 },
        { kind: 'older', before: 101, count: 50 },
      ]);
    } finally {
      source.destroy();
    }
  });
});
