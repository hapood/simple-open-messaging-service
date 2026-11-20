import { firstValueFrom, Subject } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  MessageRepository,
  type NativeMessageHistoryResult,
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
  );
  return { source, query, empty };
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

  it('retains a server gap as a gap item rather than an edge spinner', async () => {
    const { source, query } = setup();
    query.mockResolvedValueOnce({
      items: [
        { kind: 'serverGap', left: 90, right: 110, state: 'SERVER_PENDING' },
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

  it('reuses a gap-only projection without treating it as an empty cache', async () => {
    const { source, query } = setup();
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
      const result = await source.loadWindow({
        kind: 'around',
        messageId: 100,
        olderCount: 50,
        newerCount: 50,
      });
      expect(result).toHaveLength(1);
      expect(result[0].data.serverGap).toEqual({
        left: 90,
        right: 110,
        state: 'SERVER_PENDING',
      });
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
