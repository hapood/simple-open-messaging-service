import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of } from 'rxjs';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { MessageRepository } from './message-repository.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import { UserService } from './user.service';
import { createP2PConversation, type Message } from './model';
import { HttpItemSource } from '../components/message-thread/http-item-source';
import { MessageThreadComponent } from '../components/message-thread/friend-message.component';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import type { ChatBoxScroller } from '../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../components/message-cards/chat-item';
import { threadFeedSnapshot } from './thread-feed.test-helper';

/** A minimal Message row (seq is the IDB key second component + the cursor the kernel uses). */
function msg(threadId: number, seq: number, content = `m${seq}`): Message {
  return {
    seq,
    contentType: 'PURE_TEXT',
    content,
    threadId,
    creator: { account: 'me', namespaceId: 0 },
    profileRev: 1,
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    isDeleted: false,
  } as unknown as Message;
}

describe('MessageRepository', () => {
  let repo: MessageRepository;
  let webdb: WebdbService;
  let eventSubject: Subject<{
    event: string;
    status: number;
    data?: unknown;
  }>;
  let reconnect$: Subject<void>;
  let queryMessageHistoryPageSpy: ReturnType<typeof vi.fn>;
  let queryDeletedMessagesSpy: ReturnType<typeof vi.fn>;
  /** The sessionProfile signal the repo's session-end effect watches (logout = set undefined). */
  let sessionProfile: ReturnType<
    typeof signal<
      | {
          id: number;
        }
      | undefined
    >
  >;

  beforeEach(async () => {
    eventSubject = new Subject();
    reconnect$ = new Subject();
    sessionProfile = signal<
      | {
          id: number;
        }
      | undefined
    >({ id: 1 });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MessageRepository,
        WebdbService,
        { provide: WebsocketService, useValue: { eventSubject, reconnect$ } },
        {
          provide: MsgService,
          useValue: {
            queryDeletedMessages: (queryDeletedMessagesSpy = vi
              .fn()
              .mockName('queryDeletedMessages')
              .mockReturnValue(
                of({
                  code: 0,
                  message: '',
                  data: {
                    tombstones: [],
                    scannedThrough: 0,
                    hasMore: false,
                  },
                }),
              )),
            queryMessageHistoryPage: (queryMessageHistoryPageSpy = vi
              .fn()
              .mockName('queryMessageHistoryPage')),
          },
        },
        { provide: UserService, useValue: { sessionProfile } },
      ],
    });
    repo = TestBed.inject(MessageRepository);
    webdb = TestBed.inject(WebdbService);
    const session = await prepareTestSessionCache();
    TestBed.inject(SessionLifecycleService).bindSession(session.id);
    webdb.bindSessionCache(session);
    await webdb.openForUser('1');
    await webdb.mergeThreadStates([
      threadFeedSnapshot(42, {
        publisherNamespaceId: 0,
        profileAccount: 'peer',
        profileRev: 1,
      }),
    ]);
  });

  it('preserves deletion types and rejects a deletion check from an expired account session', async () => {
    const facts = [{ seq: 10, type: 'MODERATION_REMOVAL' as const }];
    const query = vi
      .spyOn(webdb, 'getMessageDeletions')
      .mockResolvedValue(facts);
    expect(await repo.getMessageDeletions(42, [10])).toEqual(facts);
    expect(query).toHaveBeenCalledWith(42, [10]);
    let resolve!: (value: typeof facts) => void;
    query.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = repo.getMessageDeletions(42, [10]);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    resolve(facts);
    await expect(pending).rejects.toThrow();
  });

  it('resolves origin navigation to local seq without extending coverage', async () => {
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          messages: [msg(42, 104)],
          gaps: [],
          scannedThrough: 1,
          hasMore: false,
          resolvedAnchorSeq: 104,
        },
      }),
    );
    expect(
      await repo.resolveHistoryAnchor(42, {
        kind: 'origin',
        namespaceId: 3,
        originSeq: 4,
        localSeq: 999,
      }),
    ).toBe(104);
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledWith({
      threadId: 42,
      take: 1,
      anchorNamespaceId: 3,
      anchorOriginSeq: 4,
    });
    expect((await webdb.getMessage(42, 104))?.seq).toBe(104);
    expect(await webdb.getMessageRanges(42)).toEqual([]);
  });

  it('reads the resolved local anchor from the response rather than trusting the input', async () => {
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          messages: [msg(42, 104)],
          gaps: [],
          scannedThrough: 1,
          hasMore: false,
          resolvedAnchorSeq: 104,
        },
      }),
    );
    expect(await repo.resolveHistoryAnchor(42, { kind: 'local', seq: 4 })).toBe(
      104,
    );
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledWith({
      threadId: 42,
      take: 1,
      anchorSeq: 4,
    });
  });

  it('does not cache an unresolved anchor', async () => {
    const put = vi.spyOn(webdb, 'putCachedMessages');
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          messages: [],
          gaps: [],
          scannedThrough: 0,
          hasMore: false,
          resolvedAnchorSeq: null,
        },
      }),
    );
    expect(
      await repo.resolveHistoryAnchor(42, {
        kind: 'origin',
        namespaceId: 3,
        originSeq: 4,
      }),
    ).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('cancels anchor HTTP without ending a sibling lookup or committing cache data', async () => {
    const requests: Array<{ closed: boolean }> = [];
    queryMessageHistoryPageSpy.mockImplementation(
      () =>
        new Observable(() => {
          const entry = { closed: false };
          requests.push(entry);
          return () => {
            entry.closed = true;
          };
        }),
    );
    const put = vi.spyOn(webdb, 'putCachedMessages');
    const first = new AbortController();
    const second = new AbortController();
    const anchor = { kind: 'origin' as const, namespaceId: 3, originSeq: 4 };
    const pending = repo.resolveHistoryAnchor(42, anchor, first.signal);
    const sibling = repo.resolveHistoryAnchor(42, anchor, second.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    const siblingRejected = expect(sibling).rejects.toMatchObject({
      name: 'AbortError',
    });
    first.abort();
    expect(requests.map((request) => request.closed)).toEqual([true, false]);
    await rejected;
    expect(put).not.toHaveBeenCalled();
    second.abort();
    await siblingRejected;
  });

  it('rejects anchor slots from another thread before caching', async () => {
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          messages: [msg(99, 104)],
          gaps: [],
          scannedThrough: 1,
          hasMore: false,
          resolvedAnchorSeq: 104,
        },
      }),
    );
    await expect(
      repo.resolveHistoryAnchor(42, { kind: 'local', seq: 4 }),
    ).rejects.toThrow('different thread');
    expect(await webdb.getMessage(99, 104)).toBeUndefined();
  });

  it.each(['bootstrap', 'page'] as const)(
    'cancels owned HTTP at %s without cancelling another consumer',
    async (phase) => {
      const requests: Array<{ closed: boolean }> = [];
      queryMessageHistoryPageSpy.mockImplementation((request) => {
        if (phase === 'page' && request.before === undefined)
          return of({
            code: 30006,
            data: { resumeAfter: 0, resumeBefore: 11 },
          });
        return new Observable(() => {
          const entry = { closed: false };
          requests.push(entry);
          return () => {
            entry.closed = true;
          };
        });
      });
      const first = new AbortController();
      const second = new AbortController();
      const one = repo.queryBrowserMessageHistory(
        42,
        { kind: 'latest', count: 10 },
        first.signal,
      );
      const oneRejected = expect(one).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const two = repo.queryBrowserMessageHistory(
        42,
        { kind: 'latest', count: 10 },
        second.signal,
      );
      const twoRejected = expect(two).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      first.abort();
      await oneRejected;
      expect(requests.map((entry) => entry.closed)).toEqual([true, false]);
      expect(webdb.captureMessageLifetime().aborted).toBe(false);
      second.abort();
      await twoRejected;
      expect(requests[1].closed).toBe(true);
    },
  );

  it('stops cursor recovery when the server returns unchanged bounds', async () => {
    queryMessageHistoryPageSpy.mockReturnValue(
      of({ code: 30006, data: { resumeAfter: 0, resumeBefore: 11 } }),
    );
    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'latest',
      count: 10,
    });
    expect(result.failed).toBe(true);
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledTimes(2);
  });

  it('accepts a backward scan clipped by the server to cleared history', async () => {
    queryMessageHistoryPageSpy.mockImplementation((request) => {
      if (request.before === undefined)
        return of({ code: 30006, data: { resumeAfter: 5, resumeBefore: 11 } });
      return of({
        code: 0,
        data: {
          messages: [msg(42, 10), msg(42, 6)],
          gaps: [],
          scannedThrough: Math.max(request.through, 6),
          hasMore: false,
        },
      });
    });
    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'latest',
      count: 10,
    });
    expect(result.failed).toBe(false);
    expect(result.items).toEqual([
      { kind: 'message', message: msg(42, 6) },
      { kind: 'message', message: msg(42, 10) },
    ]);
    expect(queryMessageHistoryPageSpy).toHaveBeenLastCalledWith({
      threadId: 42,
      before: 11,
      through: 5,
      take: 10,
    });
  });

  it.each([false, true])(
    'localLatest returns immediately without HTTP (cached=%s)',
    async (cached) => {
      if (cached)
        await webdb.commitBrowserMessagePage({
          threadId: 42,
          scan: { left: 8, right: 10 },
          messages: [msg(42, 9), msg(42, 10)],
          gaps: [],
          knownNewestSeq: 100,
        });
      const result = await repo.queryBrowserMessageHistory(42, {
        kind: 'localLatest',
        count: 20,
      });
      expect(result.items).toEqual(
        cached
          ? [
              { kind: 'message', message: msg(42, 9) },
              { kind: 'message', message: msg(42, 10) },
            ]
          : [],
      );
      expect(result).toMatchObject({
        hasOlder: true,
        hasNewer: true,
        failed: false,
      });
      expect(queryMessageHistoryPageSpy).not.toHaveBeenCalled();
    },
  );

  it('uses the locally persisted message head for the first browser page', async () => {
    await webdb.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 10 },
      messages: [msg(42, 9), msg(42, 10)],
      gaps: [],
      knownNewestSeq: 10,
    });

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'latest',
      count: 20,
    });

    expect(result.failed).toBe(false);
    expect(result.items).toEqual([
      { kind: 'message', message: msg(42, 9) },
      { kind: 'message', message: msg(42, 10) },
    ]);
    expect(queryMessageHistoryPageSpy).not.toHaveBeenCalled();
  });

  it('bootstraps the first browser page when the local cache is empty', async () => {
    queryMessageHistoryPageSpy
      .mockReturnValueOnce(
        of({
          code: 30006,
          message: 'cursor required',
          data: { resumeAfter: 0, resumeBefore: 3 },
        }),
      )
      .mockReturnValueOnce(
        of({
          code: 0,
          message: 'ok',
          data: {
            messages: [msg(42, 2), msg(42, 1, 'friend added')],
            gaps: [],
            scannedThrough: 1,
            hasMore: false,
          },
        }),
      );

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'latest',
      count: 20,
    });

    expect(result.failed).toBe(false);
    expect(result.items).toEqual([
      { kind: 'message', message: msg(42, 1, 'friend added') },
      { kind: 'message', message: msg(42, 2) },
    ]);
    expect(queryMessageHistoryPageSpy).toHaveBeenNthCalledWith(2, {
      threadId: 42,
      before: 3,
      through: 0,
      take: 20,
    });
  });

  it('walks a mixed browser page and commits its message/gap ranges', async () => {
    queryMessageHistoryPageSpy
      .mockReturnValueOnce(
        of({
          code: 30006,
          message: 'cursor required',
          data: { resumeAfter: 0, resumeBefore: 51 },
        }),
      )
      .mockReturnValueOnce(
        of({
          code: 0,
          message: 'ok',
          data: {
            messages: [msg(42, 50), msg(42, 40), msg(42, 10), msg(42, 1)],
            gaps: [{ startSeq: 20, endSeq: 30, recoverable: true }],
            scannedThrough: 1,
            hasMore: false,
          },
        }),
      );

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'latest',
      count: 5,
    });

    expect(result.failed).toBe(false);
    expect(result.hasOlder).toBe(false);
    expect(
      result.items.map((item) =>
        item.kind === 'message'
          ? item.message.seq
          : `${item.left}-${item.right}`,
      ),
    ).toEqual([1, 10, '19-30', 40, 50]);
    expect(queryMessageHistoryPageSpy).toHaveBeenNthCalledWith(2, {
      threadId: 42,
      before: 51,
      through: 0,
      take: 5,
    });
    expect(await webdb.getMessageRanges(42)).toEqual([
      { threadId: 42, left: 0, right: 19, state: 'LOCAL_COVERED' },
      { threadId: 42, left: 19, right: 30, state: 'SERVER_PENDING' },
      { threadId: 42, left: 30, right: 50, state: 'LOCAL_COVERED' },
    ]);
  });

  it('recurses entirely through cached ranges and counts a server gap once', async () => {
    await webdb.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 50 },
      messages: [msg(42, 50), msg(42, 40), msg(42, 10), msg(42, 1)],
      gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
      knownNewestSeq: 50,
    });

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'older',
      before: 51,
      count: 5,
    });

    expect(result.failed).toBe(false);
    expect(result.hasOlder).toBe(false);
    expect(
      result.items.map((item) =>
        item.kind === 'message'
          ? item.message.seq
          : `${item.left}-${item.right}`,
      ),
    ).toEqual([1, 10, '19-30', 40, 50]);
    expect(queryMessageHistoryPageSpy).not.toHaveBeenCalled();
  });

  it('gives an around seam gap only to the right-hand directional page', async () => {
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 30006,
        message: 'cursor required',
        data: { resumeAfter: 0, resumeBefore: 41 },
      }),
    );
    await webdb.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 40 },
      messages: [msg(42, 10), msg(42, 40)],
      gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
      knownNewestSeq: 40,
    });

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'around',
      anchor: 25,
      olderCount: 1,
      newerCount: 2,
    });

    expect(
      result.items.map((item) =>
        item.kind === 'message'
          ? item.message.seq
          : `${item.left}-${item.right}`,
      ),
    ).toEqual([10, '19-30', 40]);
    expect(queryMessageHistoryPageSpy).not.toHaveBeenCalled();
  });

  async function mountedHistory(localSeqs: number[], initBatch = 10) {
    const message = (seq: number) => ({
      ...msg(42, seq, JSON.stringify({ text: `message ${seq}` })),
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
    });
    await webdb.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 10 },
      messages: localSeqs.map(message),
      gaps: [],
      knownNewestSeq: 10,
    });
    repo.applyThreadContentHead(42, 10, false);
    const viewport = document.createElement('div');
    const content = document.createElement('div');
    viewport.append(content);
    document.body.append(viewport);
    Object.defineProperty(viewport, 'clientHeight', { get: () => 200 });
    let scrollTop = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(content, 'scrollHeight', {
      get: () =>
        Array.from(content.children).reduce(
          (height, child) => height + (child as HTMLElement).offsetHeight,
          0,
        ),
    });
    const pane = Object.create(MessageThreadComponent.prototype);
    Object.assign(pane, {
      lifecycle: { binding: undefined },
      threadAdapter: {
        scrollerConfig: () => ({ initBatch, thresholdFloor: 20000 }),
        configureScroller: () => {},
      },
      scrollState: { firstUnreadSeq: null },
      layout: { reflowFrozen: () => false },
      stableRead: { noteFullyVisible: () => {} },
      pulseVisibleMention: () => {},
      onScroll: () => {},
      updateStickyOverlays: () => {},
      createItem: () => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { get: () => 100 });
        return {
          el,
          onHeightChange: () => () => {},
          update: () => {},
          destroy: () => {},
        };
      },
    });
    // Exercise the production component's follow policy, not an independently
    // configured test scroller. Demand delivery itself can otherwise scroll.
    pane.prepareScroller(viewport, content);
    const scroller = pane.scroller as ChatBoxScroller<ChatItemData>;
    const available = vi.fn(() => scroller.notifyNewerAvailable());
    const source = new HttpItemSource(
      createP2PConversation({
        threadId: 42,
        account: 'me',
        publisherNamespaceId: 0,
        profileRev: 1,
      }),
      repo,
      TestBed.inject(UserService),
      new ThreadSendOutbox(),
      { onNewerAvailable: available },
      TestBed.inject(MsgService),
    );
    scroller.bind(source, { chatId: 42 });
    await scroller.init();
    queryMessageHistoryPageSpy.mockImplementation((request) =>
      of({
        code: 0,
        data: {
          messages: (request.before === undefined
            ? [11, 12, 13]
            : [13, 12, 11]
          ).map(message),
          gaps: [],
          scannedThrough: request.before === undefined ? 13 : 10,
          hasMore: false,
        },
      }),
    );
    return {
      source,
      scroller,
      viewport,
      available,
      destroy: () => {
        scroller.destroy();
        viewport.remove();
      },
    };
  }

  it.each([
    'HELLO then resume',
    'resume then HELLO',
    'warm refresh',
    'initial catch-up',
  ])('mounts 10 → 13 without automatic follow: %s', async (order) => {
    const mounted = await mountedHistory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { source, scroller, viewport, available } = mounted;
    const heads = vi.fn();
    const live = vi.fn();
    const historySub = repo.historyHead$.subscribe(heads);
    const liveSub = repo.liveSignal$.subscribe(live);
    try {
      expect(scroller.getInfo().newestId).toBe(10);
      const before = viewport.scrollTop;
      expect(before).toBeGreaterThan(0); // normal initial bottom positioning remains
      if (order !== 'initial catch-up') {
        source.finishLocalInit(10);
        // Let the source park a real newer demand at the exhausted ceiling.
        await vi.waitFor(() =>
          expect((source as any).pumpingNewer).toBe(false),
        );
      }
      if (order === 'HELLO then resume') {
        source.pauseLiveUpdates();
        repo.applyThreadContentHead(42, 13, false);
        source.resumeLiveUpdates(); // replay the retained head, not a Subject frame
      } else if (order === 'resume then HELLO') {
        source.pauseLiveUpdates();
        source.resumeLiveUpdates(10);
        repo.applyThreadContentHead(42, 13, false);
      } else if (order === 'warm refresh') {
        source.resumeLiveUpdates(13); // already subscribed: must still refresh
        source.refreshLatest(13);
      } else {
        repo.applyThreadContentHead(42, 13, false);
        source.finishLocalInit(10, 13);
      }
      await vi.waitFor(() => expect(scroller.getInfo().newestId).toBe(13));
      expect(
        [11, 12, 13].map((seq) => scroller.getMountedGeometry(seq)?.item.id),
      ).toEqual([11, 12, 13]);
      expect(viewport.scrollTop).toBe(before);
      expect(queryMessageHistoryPageSpy).toHaveBeenCalledExactlyOnceWith({
        threadId: 42,
        after: 10,
        through: 13,
        take: 50,
      });
      expect(heads).toHaveBeenCalledExactlyOnceWith({ threadId: 42, seq: 13 });
      expect(live).not.toHaveBeenCalled();
      expect(available).toHaveBeenCalledTimes(1);
      // A duplicate live frame must not convert hydrated history into an arrival.
      repo.applyThreadContentHead(42, 13, true);
      source.refreshLatest(13);
      await vi.waitFor(() => expect((source as any).pumpingNewer).toBe(false));
      expect(heads).toHaveBeenCalledTimes(1);
      expect(live).not.toHaveBeenCalled();
      expect(available).toHaveBeenCalledTimes(1);
      expect(queryMessageHistoryPageSpy).toHaveBeenCalledTimes(1);
      expect(viewport.scrollTop).toBe(before);
    } finally {
      historySub.unsubscribe();
      liveSub.unsubscribe();
      mounted.destroy();
    }
  });

  it('backfills older history while preserving the visible item instead of following bottom', async () => {
    const mounted = await mountedHistory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    try {
      mounted.viewport.scrollTop = 0;
      const before = mounted.scroller.getMountedGeometry(9)!.top;
      await mounted.scroller.backfillOlder();
      expect(mounted.scroller.getMountedGeometry(1)).not.toBeNull();
      expect(mounted.scroller.getMountedGeometry(9)!.top).toBe(before);
      expect(mounted.viewport.scrollTop).toBeLessThan(
        mounted.viewport.firstElementChild!.scrollHeight -
          mounted.viewport.clientHeight,
      );
      expect(queryMessageHistoryPageSpy).not.toHaveBeenCalled();
    } finally {
      mounted.destroy();
    }
  });

  it('does not follow the first remote batch after empty local initialization', async () => {
    const mounted = await mountedHistory([]);
    try {
      expect(mounted.viewport.scrollTop).toBe(0);
      // An empty local cache still has an authoritative durable target.
      repo.applyThreadContentHead(42, 13, false);
      mounted.source.finishLocalInit(undefined, 13);
      await vi.waitFor(() =>
        expect(mounted.scroller.getInfo().newestId).toBe(13),
      );
      expect(mounted.viewport.scrollTop).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('uses an identity-only live ceiling to walk newer history without bootstrapping', async () => {
    await webdb.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 10 },
      messages: [msg(42, 10)],
      gaps: [],
      knownNewestSeq: 10,
    });
    queryMessageHistoryPageSpy.mockReturnValueOnce(
      of({
        code: 0,
        message: 'ok',
        data: {
          messages: [msg(42, 11)],
          gaps: [],
          scannedThrough: 11,
          hasMore: false,
        },
      }),
    );
    repo.applyThreadContentHead(42, 11, true);

    const result = await repo.queryBrowserMessageHistory(42, {
      kind: 'newer',
      after: 10,
      count: 10,
    });

    expect(result.items).toEqual([{ kind: 'message', message: msg(42, 11) }]);
    expect(result.hasNewer).toBe(false);
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledTimes(1);
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledWith({
      threadId: 42,
      after: 10,
      through: 11,
      take: 10,
    });
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('does not resurrect a tombstone when an in-flight HTTP page arrives later', async () => {
    await webdb.applyDeletedMessages(
      42,
      [
        {
          deletionSeq: 9,
          threadId: 42,
          messageSeq: 10,
          type: 'USER_RETRACTION',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      9,
    );

    await webdb.putCachedMessages([msg(42, 10, 'late-http-body')]);

    expect(await webdb.getMessage(42, 10)).toBeUndefined();
    expect(await webdb.getDeletedHwm(42)).toBe(9);
    const db = await webdb.db();
    const raw = await db.get('messages', [42, 10]);
    expect(raw?.isDeleted).toBe(true);
    expect(raw && 'content' in raw).toBe(false);
  });

  it('turns an existing cached message into a tombstone atomically with its HWM', async () => {
    await webdb.putCachedMessages([msg(42, 10, 'already-cached')]);

    await webdb.applyDeletedMessages(
      42,
      [
        {
          deletionSeq: 12,
          threadId: 42,
          messageSeq: 10,
          type: 'MODERATION_REMOVAL',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      12,
    );

    expect(await webdb.getMessage(42, 10)).toBeUndefined();
    expect(await webdb.getDeletedHwm(42)).toBe(12);
    const db = await webdb.db();
    const raw = await db.get('messages', [42, 10]);
    expect(raw?.isDeleted).toBe(true);
    expect(raw && 'content' in raw).toBe(false);
    expect(raw).toMatchObject({
      contentType: 'TOMB',
      deletionType: 'MODERATION_REMOVAL',
    });
  });
});
