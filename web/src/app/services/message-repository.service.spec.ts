import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { WebdbService } from './webdb.service';
import { MessageRepository } from './message-repository.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import { UserService } from './user.service';
import type { Message } from './model';

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
    await webdb.openForUser('1');
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
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledTimes(1);
    expect(queryMessageHistoryPageSpy).toHaveBeenCalledWith({ threadId: 42 });
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
    const db = await webdb.messageDb();
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
    const db = await webdb.messageDb();
    const raw = await db.get('messages', [42, 10]);
    expect(raw?.isDeleted).toBe(true);
    expect(raw && 'content' in raw).toBe(false);
    expect(raw).toMatchObject({
      contentType: 'TOMB',
      deletionType: 'MODERATION_REMOVAL',
    });
  });
});
