import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { WebdbService } from './webdb.service';
import { MessageRepository } from './message-repository.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import { UserService } from './user.service';
import type { Message, StandardResponse } from './model';

/** Flush the microtask + macrotask queue so async IDB writes + the NEW_MESSAGE handler settle. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await flush(1);
  expect(condition()).toBe(true);
}

/** A minimal Message row (seq is the IDB key second component + the cursor the kernel uses). */
function msg(threadId: number, seq: number, content = `m${seq}`): Message {
  return {
    seq,
    contentType: 'PURE_TEXT',
    content,
    threadId,
    creator: 1,
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
  let queryMessageLogSpy: Mock;
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
            queryMessageLog: (queryMessageLogSpy = vi
              .fn()
              .mockName('queryMessageLog')),
            queryDeletedMessages: vi
              .fn()
              .mockName('queryDeletedMessages')
              .mockReturnValue(
                of({ code: 0, message: '', data: [], hasMore: false }),
              ),
          },
        },
        { provide: UserService, useValue: { sessionProfile } },
      ],
    });
    repo = TestBed.inject(MessageRepository);
    webdb = TestBed.inject(WebdbService);
    await webdb.openForUser('1');
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('shares the newest truncate ceiling per thread and clears it before reconnect wake-up', () => {
    const observed: Array<number | undefined> = [];
    repo.retainNewestSeq(42, 10);
    repo.retainNewestSeq(42, 8);
    repo.retainNewestSeq(7, 30);
    repo.reconnectSignal$.subscribe(() => {
      observed.push(repo.getNewerTruncateSeq(42));
    });

    expect(repo.getNewerTruncateSeq(42)).toBe(10);
    expect(repo.getNewerTruncateSeq(7)).toBe(30);
    reconnect$.next();

    expect(observed).toEqual([undefined]);
    expect(repo.getNewerTruncateSeq(7)).toBeUndefined();
  });

  /** Count messages cached for a thread in IDB. */
  async function dbCount(threadId: number): Promise<number> {
    const db = await webdb.messageDb();
    let n = 0;
    let cursor = await db
      .transaction('messages')
      .store.openCursor(
        IDBKeyRange.bound(
          [threadId, -Infinity],
          [threadId, Infinity],
          false,
          false,
        ),
      );
    while (cursor) {
      n++;
      cursor = await cursor.continue();
    }
    return n;
  }

  it('persists sparse complete-section edges and restores them after reopening IDB', async () => {
    await webdb.putMessages([msg(42, 5), msg(42, 10)], {
      threadId: 42,
      left: 5,
      right: 10,
    });

    expect(await webdb.getMessageSection(42, 7)).toEqual({
      left: 5,
      right: 10,
    });
    await webdb.close();
    await webdb.openForUser('1');
    expect(await webdb.getMessageSection(42, 7)).toEqual({
      left: 5,
      right: 10,
    });

    const db = await webdb.messageDb();
    const left = await db.get('messages', [42, 5]);
    const right = await db.get('messages', [42, 10]);
    expect(left?.sectionLeft).toBe(1);
    expect(left?.sectionRight).toBeUndefined();
    expect(right?.sectionRight).toBe(1);
    expect(right?.sectionLeft).toBeUndefined();
  });

  it('atomically merges bridged sections and removes their internal edges', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 20)], {
      threadId: 42,
      left: 10,
      right: 20,
    });
    await webdb.putMessages([msg(42, 30), msg(42, 40)], {
      threadId: 42,
      left: 30,
      right: 40,
    });
    await webdb.putMessages([], { threadId: 42, left: 20, right: 30 });

    expect(await webdb.getMessageSection(42, 25)).toEqual({
      left: 10,
      right: 40,
    });
    const db = await webdb.messageDb();
    expect((await db.get('messages', [42, 20]))?.sectionRight).toBeUndefined();
    expect((await db.get('messages', [42, 30]))?.sectionLeft).toBeUndefined();
  });

  it('updates only the merged section boundaries and leaves outside sections untouched', async () => {
    for (const [left, right] of [
      [1, 5],
      [10, 20],
      [30, 40],
      [50, 60],
    ]) {
      await webdb.putMessages([msg(42, left), msg(42, right)], {
        threadId: 42,
        left,
        right,
      });
    }
    await webdb.putMessages(
      [msg(42, 18, 'incoming-left'), msg(42, 32, 'incoming-right')],
      { threadId: 42, left: 18, right: 32 },
    );

    expect(await webdb.getMessageSection(42, 25)).toEqual({
      left: 10,
      right: 40,
    });
    const db = await webdb.messageDb();
    expect((await db.get('messages', [42, 1]))?.sectionLeft).toBe(1);
    expect((await db.get('messages', [42, 5]))?.sectionRight).toBe(1);
    expect((await db.get('messages', [42, 50]))?.sectionLeft).toBe(1);
    expect((await db.get('messages', [42, 60]))?.sectionRight).toBe(1);
    expect((await db.get('messages', [42, 1]))?.content).toBe('m1');
    expect((await db.get('messages', [42, 60]))?.content).toBe('m60');
  });

  it('inserts missing HTTP rows but refreshes only existing final boundary rows', async () => {
    await webdb.putMessages(
      [
        msg(42, 10, 'old-left'),
        msg(42, 15, 'old-middle'),
        msg(42, 20, 'old-right'),
      ],
      { threadId: 42, left: 10, right: 20 },
    );

    await webdb.putMessages(
      [
        msg(42, 10, 'new-left'),
        msg(42, 12, 'new-insert'),
        msg(42, 15, 'new-middle'),
        msg(42, 20, 'new-right'),
      ],
      { threadId: 42, left: 10, right: 20 },
    );

    const db = await webdb.messageDb();
    expect((await db.get('messages', [42, 10]))?.content).toBe('new-left');
    expect((await db.get('messages', [42, 12]))?.content).toBe('new-insert');
    expect((await db.get('messages', [42, 15]))?.content).toBe('old-middle');
    expect((await db.get('messages', [42, 20]))?.content).toBe('new-right');
  });

  it('does not resurrect a tombstone when an in-flight HTTP page arrives later', async () => {
    await webdb.applyDeletedMessages(
      42,
      [
        {
          id: '9',
          threadId: 42,
          seq: 10,
          type: 'WITHDRAW',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      '9',
    );

    await webdb.putMessages([msg(42, 10, 'late-http-body')], {
      threadId: 42,
      left: 10,
      right: 10,
    });

    expect(await webdb.getMessage(42, 10)).toBeUndefined();
    expect(await webdb.getDeletedHwm(42)).toBe('9');
    const db = await webdb.messageDb();
    const raw = await db.get('messages', [42, 10]);
    expect(raw?.isDeleted).toBe(true);
    expect(raw?.content).toBe('');
  });

  it('turns an existing cached message into a tombstone atomically with its HWM', async () => {
    await webdb.putMessages([msg(42, 10, 'already-cached')], {
      threadId: 42,
      left: 10,
      right: 10,
    });

    await webdb.applyDeletedMessages(
      42,
      [
        {
          id: '12',
          threadId: 42,
          seq: 10,
          type: 'REPORT',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      '12',
    );

    expect(await webdb.getMessage(42, 10)).toBeUndefined();
    expect(await webdb.getDeletedHwm(42)).toBe('12');
    const db = await webdb.messageDb();
    const raw = await db.get('messages', [42, 10]);
    expect(raw?.isDeleted).toBe(true);
    expect(raw?.content).toBe('already-cached');
  });

  it('joins a left-adjacent coveredTail by resolving only the incoming left edge', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 20)], {
      threadId: 42,
      left: 10,
      right: 20,
    });
    await webdb.putMessages([msg(42, 30), msg(42, 40)], {
      threadId: 42,
      left: 30,
      right: 40,
    });

    await webdb.putMessages([msg(42, 21), msg(42, 29)], {
      threadId: 42,
      left: 21,
      right: 29,
    });

    expect(await webdb.getMessageSection(42, 25)).toEqual({
      left: 10,
      right: 40,
    });
    expect((await webdb.getMessageCoverage(42))?.coveredTail).toEqual({
      left: 10,
      right: 40,
    });
  });

  it('resolves both endpoint neighbors for a range disjoint left of coveredTail', async () => {
    for (const [left, right] of [
      [10, 20],
      [30, 40],
      [50, 60],
    ]) {
      await webdb.putMessages([msg(42, left), msg(42, right)], {
        threadId: 42,
        left,
        right,
      });
    }

    await webdb.putMessages([msg(42, 18), msg(42, 32)], {
      threadId: 42,
      left: 18,
      right: 32,
    });

    expect(await webdb.getMessageSection(42, 25)).toEqual({
      left: 10,
      right: 40,
    });
    expect((await webdb.getMessageCoverage(42))?.coveredTail).toEqual({
      left: 50,
      right: 60,
    });
  });

  it('extends a right-adjacent coveredTail without scanning other sections', async () => {
    await webdb.putMessages([msg(42, 50), msg(42, 60)], {
      threadId: 42,
      left: 50,
      right: 60,
    });
    await webdb.putMessages([msg(42, 61), msg(42, 70)], {
      threadId: 42,
      left: 61,
      right: 70,
    });

    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 70,
      coveredTail: { left: 50, right: 70 },
    });
    expect(await webdb.getMessageSection(42, 65)).toEqual({
      left: 50,
      right: 70,
    });
  });

  it('keeps a disjoint old tail section when a farther-right range becomes coveredTail', async () => {
    await webdb.putMessages([msg(42, 50), msg(42, 60)], {
      threadId: 42,
      left: 50,
      right: 60,
    });
    await webdb.putMessages([msg(42, 70), msg(42, 80)], {
      threadId: 42,
      left: 70,
      right: 80,
    });

    expect(await webdb.getMessageSection(42, 55)).toEqual({
      left: 50,
      right: 60,
    });
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 80,
      coveredTail: { left: 70, right: 80 },
    });
  });

  it('stores a one-message complete section as both sparse edges', async () => {
    await webdb.putMessages([msg(42, 7)], { threadId: 42, left: 7, right: 7 });
    const row = await (await webdb.messageDb()).get('messages', [42, 7]);
    expect(row?.sectionLeft).toBe(1);
    expect(row?.sectionRight).toBe(1);
    expect(await webdb.getMessageSection(42, 7)).toEqual({ left: 7, right: 7 });
  });

  it('persists the complete-tail summary in the same message transaction', async () => {
    await webdb.putMessages(
      [msg(42, 5), msg(42, 10)],
      { threadId: 42, left: 5, right: 10 },
      { threadId: 42, seq: 10 },
    );
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 10,
      coveredTail: { left: 5, right: 10 },
    });
    await webdb.close();
    await webdb.openForUser('1');
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 10,
      coveredTail: { left: 5, right: 10 },
    });
  });

  it('keeps coveredTail while known newest advances, then bridges it atomically', async () => {
    await webdb.putMessages(
      [msg(42, 10), msg(42, 20)],
      { threadId: 42, left: 10, right: 20 },
      { threadId: 42, seq: 20 },
    );
    await webdb.putMessages([], undefined, { threadId: 42, seq: 25 });
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 25,
      coveredTail: { left: 10, right: 20 },
    });

    await webdb.putMessages(
      [msg(42, 25)],
      { threadId: 42, left: 20, right: 25 },
      { threadId: 42, seq: 25 },
    );
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 25,
      coveredTail: { left: 10, right: 25 },
    });
    expect(await webdb.getMessageSection(42, 22)).toEqual({
      left: 10,
      right: 25,
    });
  });

  it('keeps a newer disjoint tail and replaces it only with a farther-right section', async () => {
    await webdb.putMessages(
      [msg(42, 20), msg(42, 30)],
      { threadId: 42, left: 20, right: 30 },
      { threadId: 42, seq: 40 },
    );
    await webdb.putMessages([msg(42, 1), msg(42, 10)], {
      threadId: 42,
      left: 1,
      right: 10,
    });
    expect((await webdb.getMessageCoverage(42))?.coveredTail).toEqual({
      left: 20,
      right: 30,
    });

    await webdb.putMessages([msg(42, 35), msg(42, 40)], {
      threadId: 42,
      left: 35,
      right: 40,
    });
    expect(await webdb.getMessageCoverage(42)).toEqual({
      threadId: 42,
      knownNewestSeq: 40,
      coveredTail: { left: 35, right: 40 },
    });
  });

  it('rolls back the coverage summary when the section transaction fails', async () => {
    await expect(
      webdb.putMessages(
        [],
        { threadId: 42, left: 5, right: 10 },
        { threadId: 42, seq: 10 },
      ),
    ).rejects.toThrow();
    expect(await webdb.getMessageCoverage(42)).toBeUndefined();
  });

  it('uses mounted chatbox tail coverage without a section-index query and releases it on close', async () => {
    await webdb.putMessages(
      [msg(42, 5), msg(42, 10)],
      { threadId: 42, left: 5, right: 10 },
      { threadId: 42, seq: 10 },
    );
    const sectionSpy = vi.spyOn(webdb, 'getMessageSection');
    repo.retainCoverage(42, 10);
    await flush();
    expect(await (repo as any).isCompleteRange(42, 6, 9)).toBe(true);
    expect(sectionSpy).not.toHaveBeenCalled();

    repo.releaseCoverage(42);
    expect(await (repo as any).isCompleteRange(42, 6, 9)).toBe(true);
    expect(sectionSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates message/section transaction failures instead of reporting a network edge', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 7)],
        hasMore: false,
      }),
    );
    vi.spyOn(webdb, 'putMessages').mockRejectedValue(
      new Error('section write failed'),
    );

    await expect(
      repo.queryMessages(42, { skip: 0, take: 10, orderBy: 'desc' }),
    ).rejects.toThrowError('section write failed');
  });

  it('rejects an empty success without a truncate or directional endpoint', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [],
        hasMore: true,
      }),
    );
    const putSpy = vi.spyOn(webdb, 'putMessages');

    await expect(
      repo.queryMessages(42, {
        skip: 1,
        take: 10,
        lastSeq: 7,
        orderBy: 'desc',
      }),
    ).rejects.toThrowError('empty message response has no confirmed endpoint');
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('cold init treats an empty IDB result as ready and revalidates in the background', async () => {
    const refresh$ = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(refresh$);
    const signals: {
      threadId: number;
      seq: number;
    }[] = [];
    repo.liveSignal$.subscribe((s) => signals.push(s));

    const res = await repo.queryMessages(
      42,
      {
        skip: 0,
        take: 3,
        orderBy: 'desc',
      },
      undefined,
      true,
    );

    expect(res).toEqual({ data: [], hasMore: false });
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
    expect(signals).toEqual([]);

    void repo.refreshLatest(
      42,
      { skip: 0, take: 3, orderBy: 'desc' },
      undefined,
    );
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    refresh$.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 3), msg(42, 2), msg(42, 1)],
      hasMore: true,
    });
    refresh$.complete();
    await flush(10);

    expect(await dbCount(42)).toBe(3);
    expect(signals).toEqual([{ threadId: 42, seq: 3 }]);
  });

  it('warm init returns the latest IDB page immediately and revalidates in the background', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 4), msg(42, 3), msg(42, 2)],
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.mockClear();

    const refresh$ = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(refresh$);

    const warm = await repo.queryMessages(42, {
      skip: 0,
      take: 3,
      orderBy: 'desc',
    });
    expect(warm.data.map((m) => m.seq)).toEqual([4, 3, 2]);
    expect(warm.hasMore).toBe(true);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);

    refresh$.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 5), msg(42, 4), msg(42, 3)],
      hasMore: true,
    });
    refresh$.complete();
    await flush(10);
    expect(await dbCount(42)).toBe(4);
  });

  it('latest-page revalidation stops before the locally cached oldest row', async () => {
    await webdb.putMessages([msg(42, 15), msg(42, 14)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 17), msg(42, 16)],
        hasMore: false,
        truncated: true,
      }),
    );

    const warm = await repo.queryMessages(42, {
      skip: 0,
      take: 2,
      orderBy: 'desc',
    });
    await flush(10);

    expect(warm.data.map((m) => m.seq)).toEqual([15, 14]);
    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0]).toEqual({
      threadId: 42,
      skip: 0,
      take: 2,
      orderBy: 'desc',
      truncate: true,
      truncateSeq: 14,
    });
    expect(await dbCount(42)).toBe(4); // the cutoff row 14 was never downloaded/written again
  });

  it('warm init emits a live signal when background revalidation finds a newer tail', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 2), msg(42, 1)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 2, orderBy: 'desc' });
    await flush(10);

    const signals: {
      threadId: number;
      seq: number;
    }[] = [];
    repo.liveSignal$.subscribe((s) => signals.push(s));
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3), msg(42, 2)],
        hasMore: true,
      }),
    );

    await repo.queryMessages(42, { skip: 0, take: 2, orderBy: 'desc' });
    await flush(20);
    expect(signals).toEqual([{ threadId: 42, seq: 3 }]);
  });

  it('warm init never exposes cached messages at or before the clear-history watermark', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3), msg(42, 2), msg(42, 1)],
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.mockClear();

    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3)],
        hasMore: false,
      }),
    );
    const warm = await repo.queryMessages(
      42,
      { skip: 0, take: 3, orderBy: 'desc' },
      2,
    );

    expect(warm.data.map((m) => m.seq)).toEqual([3]);
    expect(warm.data.every((m) => m.seq > 2)).toBe(true);
    await flush(20); // let the intentionally background refresh finish before closing the test DB
  });

  it('getOlder (skip:1) is a cache HIT for a contiguous held range → no backend call', async () => {
    // Seed the cache with seqs 1..5 (a prior session's scroll).
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [5, 4, 3, 2, 1].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 5, orderBy: 'desc' });
    await webdb.close();
    await webdb.openForUser('1');
    queryMessageLogSpy.mockClear();

    // getOlder(cursor=6, take=3): the cache holds [3,4,5] contiguously below 6 → served from IDB.
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 6,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]); // desc, highest-first below 6
    expect(res.hasMore).toBe(true); // seq 3 > 0 → there is older
    expect(queryMessageLogSpy).not.toHaveBeenCalled(); // cache HIT — no duplicate pull
  });

  it('getOlder GAP-FILLS when the cache lacks the range → backend called + cached', async () => {
    // The mounted cursor is cached; the requested older range is absent and must be backfilled.
    await webdb.putMessages([msg(42, 6)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [5, 4, 3].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 6,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(await dbCount(42)).toBe(4); // cursor + gap-fill persisted → next time is a cache hit
  });

  it('coalesces same-start same-direction fills and reloads their committed DB rows', async () => {
    await webdb.putMessages([msg(42, 6)]);
    const response = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(response);
    const query = {
      skip: 1 as const,
      take: 3,
      lastSeq: 6,
      orderBy: 'desc' as const,
    };

    const first = repo.queryMessages(42, query);
    const second = repo.queryMessages(42, query);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);

    response.next({
      code: 0,
      message: 'ok',
      data: [5, 4, 3].map((seq) => msg(42, seq)),
      hasMore: true,
    });
    response.complete();

    const [a, b] = await Promise.all([first, second]);
    expect(a.data.map((message) => message.seq)).toEqual([5, 4, 3]);
    expect(b.data.map((message) => message.seq)).toEqual([5, 4, 3]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('shares a smaller inflight fill, then recursively requests a larger waiter remainder', async () => {
    await webdb.putMessages([msg(42, 6)]);
    const firstResponse = new Subject<StandardResponse<Message[]>>();
    const secondResponse = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);

    const smaller = repo.queryMessages(42, {
      skip: 1,
      take: 1,
      lastSeq: 6,
      orderBy: 'desc',
    });
    const larger = repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 6,
      orderBy: 'desc',
    });
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);

    firstResponse.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 5)],
      hasMore: true,
    });
    firstResponse.complete();
    expect((await smaller).data.map((message) => message.seq)).toEqual([5]);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 2);
    expect(
      vi.mocked(queryMessageLogSpy).mock.calls.map((args) => args[0].lastSeq),
    ).toEqual([6, 5]);
    expect(
      vi.mocked(queryMessageLogSpy).mock.calls.map((args) => args[0].take),
    ).toEqual([1, 2]);

    secondResponse.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 4), msg(42, 3)],
      hasMore: true,
    });
    secondResponse.complete();
    expect((await larger).data.map((message) => message.seq)).toEqual([
      5, 4, 3,
    ]);
  });

  it('propagates an HTTP failure to concurrent callers', async () => {
    await webdb.putMessages([msg(42, 6)]);
    const response = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(response);
    const query = {
      skip: 1 as const,
      take: 2,
      lastSeq: 6,
      orderBy: 'desc' as const,
    };

    const first = repo.queryMessages(42, query);
    const second = repo.queryMessages(42, query);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length >= 1);
    response.error(new Error('offline'));

    const [a, b] = await Promise.all([first, second]);
    expect(a.failed).toBe(true);
    expect(b.failed).toBe(true);
  });

  it('coalesces different truncateSeq values and applies each waiter boundary after commit', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 20)]);
    const response = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(response);

    const farther = repo.queryMessages(42, {
      skip: 1,
      take: 10,
      lastSeq: 20,
      orderBy: 'desc',
      truncate: true,
      truncateSeq: 10,
    });
    const nearer = repo.queryMessages(42, {
      skip: 1,
      take: 10,
      lastSeq: 20,
      orderBy: 'desc',
      truncate: true,
      truncateSeq: 15,
    });
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);

    response.next({
      code: 0,
      message: 'ok',
      data: [19, 18, 17, 16, 15, 14, 13, 12, 11].map((seq) => msg(42, seq)),
      hasMore: false,
      truncated: true,
    });
    response.complete();

    const [a, b] = await Promise.all([farther, nearer]);
    expect(a.data.map((message) => message.seq)).toEqual([
      19, 18, 17, 16, 15, 14, 13, 12, 11,
    ]);
    expect(b.data.map((message) => message.seq)).toEqual([19, 18, 17, 16]);
    expect(a.truncated).toBe(true);
    expect(b.truncated).toBe(true);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce opposite directions at the same start', async () => {
    await webdb.putMessages([msg(42, 20)]);
    const responses: Subject<StandardResponse<Message[]>>[] = [];
    queryMessageLogSpy.mockImplementation(() => {
      const response = new Subject<StandardResponse<Message[]>>();
      responses.push(response);
      return response;
    });

    const older = repo.queryMessages(42, {
      skip: 1,
      take: 1,
      lastSeq: 20,
      orderBy: 'desc',
    });
    const newer = repo.queryMessages(42, {
      skip: 1,
      take: 1,
      lastSeq: 20,
      orderBy: 'asc',
    });
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 2);

    responses[0].next({
      code: 0,
      message: 'ok',
      data: [msg(42, 19)],
      hasMore: true,
    });
    responses[0].complete();
    responses[1].next({
      code: 0,
      message: 'ok',
      data: [msg(42, 21)],
      hasMore: true,
    });
    responses[1].complete();

    expect((await older).data[0].seq).toBe(19);
    expect((await newer).data[0].seq).toBe(21);
  });

  it('rejects all coalesced waiters when the shared DB transaction fails', async () => {
    await webdb.putMessages([msg(42, 6)]);
    const response = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(response);
    vi.spyOn(webdb, 'putMessages').mockRejectedValue(
      new Error('commit failed'),
    );
    const query = {
      skip: 1 as const,
      take: 1,
      lastSeq: 6,
      orderBy: 'desc' as const,
    };

    const first = repo.queryMessages(42, query);
    const second = repo.queryMessages(42, query);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 1);
    response.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 5)],
      hasMore: true,
    });
    response.complete();

    await expect(first).rejects.toThrowError('commit failed');
    await expect(second).rejects.toThrowError('commit failed');
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('allows different starts in the same thread to fetch concurrently', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 20)]);
    const responses = new Map<number, Subject<StandardResponse<Message[]>>>();
    queryMessageLogSpy.mockImplementation(
      ({ lastSeq }: { lastSeq: number }) => {
        const response = new Subject<StandardResponse<Message[]>>();
        responses.set(lastSeq, response);
        return response;
      },
    );

    const first = repo.queryMessages(42, {
      skip: 1,
      take: 1,
      lastSeq: 10,
      orderBy: 'desc',
    });
    const second = repo.queryMessages(42, {
      skip: 1,
      take: 1,
      lastSeq: 20,
      orderBy: 'desc',
    });
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 2);

    for (const [start, seq] of [
      [10, 9],
      [20, 19],
    ]) {
      responses.get(start)!.next({
        code: 0,
        message: 'ok',
        data: [msg(42, seq)],
        hasMore: true,
      });
      responses.get(start)!.complete();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.data[0].seq).toBe(9);
    expect(b.data[0].seq).toBe(19);
  });

  it('does not serialize fills belonging to different threads', async () => {
    await webdb.putMessages([msg(42, 6), msg(43, 6)]);
    const responses = new Map<number, Subject<StandardResponse<Message[]>>>();
    queryMessageLogSpy.mockImplementation(
      ({ threadId }: { threadId: number }) => {
        const response = new Subject<StandardResponse<Message[]>>();
        responses.set(threadId, response);
        return response;
      },
    );
    const query = {
      skip: 1 as const,
      take: 1,
      lastSeq: 6,
      orderBy: 'desc' as const,
    };

    const first = repo.queryMessages(42, query);
    const second = repo.queryMessages(43, query);
    await waitFor(() => vi.mocked(queryMessageLogSpy).mock.calls.length === 2);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(2);

    for (const threadId of [42, 43]) {
      responses.get(threadId)!.next({
        code: 0,
        message: 'ok',
        data: [msg(threadId, 5)],
        hasMore: true,
      });
      responses.get(threadId)!.complete();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.data[0].threadId).toBe(42);
    expect(b.data[0].threadId).toBe(43);
  });

  it('getOlder floor: a confirmed cache reaching seq 1 reports hasMore=false (no backend)', async () => {
    // Seed [1,2,3] (the whole small thread) + establish hasMore via the seeding call.
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [3, 2, 1].map((s) => msg(42, s)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.mockClear();

    // getOlder(cursor=3, take=3): cache holds [1,2] below 3, complete to the protocol floor → cache hit.
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 3,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([2, 1]);
    expect(res.hasMore).toBe(false); // reached the minimum message seq 1
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
  });

  it('getOlder with a fragmented cache (gap below cursor) gap-fills instead of serving a gapped range', async () => {
    // Seed only [5, 3] (missing 4 — e.g. a jump-to-message left a gap). getOlder(cursor=6, take=3) must NOT
    // serve the gapped [5, 3] — it backfills the contiguous truth from the API.
    await webdb.putMessages([msg(42, 6), msg(42, 5), msg(42, 3)]);

    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 4)],
        hasMore: false,
        truncated: true,
      }),
    );
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 6,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]); // contiguous, not the gapped [5, 3]
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses a server-confirmed local interval even when visibility creates a seq gap', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        // seq 4 is intentionally absent (e.g. hidden by the current visibility policy).
        data: [5, 3].map((seq) => msg(42, seq)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 5, orderBy: 'desc' });
    await webdb.close();
    await webdb.openForUser('1');
    queryMessageLogSpy.mockClear();

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 2,
      lastSeq: 6,
      orderBy: 'desc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([5, 3]);
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
  });

  it('assembles asc remote-gap + local-tail without requesting or rewriting the cached cutoff row', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 15), msg(42, 16)]);
    queryMessageLogSpy.mockImplementation((q: { truncateSeq?: number }) => {
      expect(q.truncateSeq).toBe(15);
      return of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [11, 12, 13, 14].map((seq) => msg(42, seq)),
        hasMore: false,
        truncated: true,
      });
    });

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 6,
      lastSeq: 10,
      orderBy: 'asc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([11, 12, 13, 14, 15, 16]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0]).toEqual({
      threadId: 42,
      skip: 1,
      take: 6,
      lastSeq: 10,
      orderBy: 'asc',
      truncate: true,
      truncateSeq: 15,
    });
    expect(await dbCount(42)).toBe(7); // cursor + 2 existing + only the 4 missing rows
  });

  it('walks multiple asc gaps using only the remaining count for each remote request', async () => {
    await webdb.putMessages([
      msg(42, 10),
      msg(42, 15),
      msg(42, 16),
      msg(42, 20),
    ]);
    queryMessageLogSpy.mockImplementation(
      (q: { truncateSeq?: number; take: number }) =>
        of<StandardResponse<Message[]>>({
          code: 0,
          message: 'ok',
          data:
            q.truncateSeq === 15
              ? [11, 12, 13, 14].map((seq) => msg(42, seq))
              : [17, 18, 19].map((seq) => msg(42, seq)),
          hasMore: false,
          truncated: true,
        }),
    );

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 10,
      lastSeq: 10,
      orderBy: 'asc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      vi.mocked(queryMessageLogSpy).mock.calls.map((args) => args[0].take),
    ).toEqual([10, 4]);
    expect(
      vi
        .mocked(queryMessageLogSpy)
        .mock.calls.map((args) => args[0].truncateSeq),
    ).toEqual([15, 20]);
    expect(await dbCount(42)).toBe(11);
  });

  it('assembles desc remote-gap + local-tail with the closest lower cached seq as cutoff', async () => {
    await webdb.putMessages([msg(42, 21), msg(42, 15), msg(42, 14)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [20, 19, 18, 17, 16].map((seq) => msg(42, seq)),
        hasMore: false,
        truncated: true,
      }),
    );

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 7,
      lastSeq: 21,
      orderBy: 'desc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([20, 19, 18, 17, 16, 15, 14]);
    expect(
      vi.mocked(queryMessageLogSpy).mock.calls[0][0].truncateSeq,
    ).toBe(15);
    expect(await dbCount(42)).toBe(8);
  });

  it('omits the local cutoff when no cached neighbor exists in the requested direction', async () => {
    await webdb.putMessages([msg(42, 10)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [11, 12].map((seq) => msg(42, seq)),
        hasMore: false,
      }),
    );

    await repo.queryMessages(42, {
      skip: 1,
      take: 5,
      lastSeq: 10,
      orderBy: 'asc',
    });

    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0]).toEqual({
      threadId: 42,
      skip: 1,
      take: 5,
      lastSeq: 10,
      orderBy: 'asc',
      truncate: false,
      truncateSeq: undefined,
    });
  });

  it('does not persist a synthetic exclusive cutoff as a message section boundary', async () => {
    await webdb.putMessages([msg(42, 50)], {
      threadId: 42,
      left: 50,
      right: 50,
    });
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [],
        hasMore: false,
        truncated: true,
      }),
    );

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 50,
      lastSeq: 50,
      orderBy: 'asc',
      truncate: true,
      truncateSeq: 51,
    });

    expect(res).toEqual({
      data: [],
      hasMore: false,
      truncated: true,
    });
    expect(
      await (await webdb.messageDb()).get('messages', [42, 51]),
    ).toBeUndefined();
    expect((await webdb.getMessageCoverage(42))?.coveredTail).toEqual({
      left: 50,
      right: 50,
    });
  });

  it('keeps the caller frozen ceiling after crossing a nearer local segment', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 15), msg(42, 20)]);
    queryMessageLogSpy.mockImplementation((q: { truncateSeq?: number }) =>
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: (q.truncateSeq === 15 ? [11, 12, 13, 14] : [16, 17, 18, 19]).map(
          (seq) => msg(42, seq),
        ),
        hasMore: false,
        truncated: true,
      }),
    );

    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 10,
      lastSeq: 10,
      orderBy: 'asc',
      truncate: true,
      truncateSeq: 20,
    });

    expect(res.data.map((m) => m.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(res.hasMore).toBe(false);
    expect(res.truncated).toBe(true);
    expect(
      vi
        .mocked(queryMessageLogSpy)
        .mock.calls.map((args) => args[0].truncateSeq),
    ).toEqual([15, 20]);
  });

  it('middle-anchor init reuses a cached anchor and bounds the older gap at its nearest local neighbor', async () => {
    await webdb.putMessages([msg(42, 10), msg(42, 5), msg(42, 4)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [9, 8, 7, 6].map((seq) => msg(42, seq)),
        hasMore: false,
        truncated: true,
      }),
    );

    const res = await repo.queryMessages(42, {
      skip: 0,
      take: 7,
      lastSeq: 10,
      orderBy: 'desc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([10, 9, 8, 7, 6, 5, 4]);
    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        skip: 1,
        take: 6,
        lastSeq: 10,
        truncate: true,
        truncateSeq: 5,
      }),
    );
  });

  it('middle-anchor init fetches a missing anchor once, then switches to the nearest local neighbor', async () => {
    await webdb.putMessages([msg(42, 5), msg(42, 4)]);
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [10, 9, 8, 7, 6].map((seq) => msg(42, seq)),
        hasMore: false,
        truncated: true,
      }),
    );

    const res = await repo.queryMessages(42, {
      skip: 0,
      take: 7,
      lastSeq: 10,
      orderBy: 'desc',
    });

    expect(res.data.map((m) => m.seq)).toEqual([10, 9, 8, 7, 6, 5, 4]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        skip: 0,
        truncate: true,
        truncateSeq: 5,
      }),
    );
  });

  it('NEW_MESSAGE emits the live signal WITHOUT caching the body (identity-only — body is pulled)', async () => {
    let emitted:
      | {
          threadId: number;
          seq: number;
        }
      | undefined;
    repo.liveSignal$.subscribe((s) => (emitted = s));

    // Identity-only frame {threadId, seq, ts} — no body (single data source = pull).
    eventSubject.next({
      event: 'NEW_MESSAGE',
      status: 0,
      data: { threadId: 42, seq: 7, ts: 7000 },
    });
    await flush(10);

    expect(emitted).toEqual({ threadId: 42, seq: 7 }); // signal fired (kernel will pull the body)
    expect(await dbCount(42)).toBe(0); // body NOT cached — identity-only
  });

  it('getNewer after a NEW_MESSAGE gap-fills from the backend (identity-only → body not pre-cached)', async () => {
    // Establish seq 5 as the prior latest via a backend init (sets maxSeenSeq).
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 5)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });

    // A live arrival (seq 6) is identity-only — the body is NOT cached.
    eventSubject.next({
      event: 'NEW_MESSAGE',
      status: 0,
      data: { threadId: 42, seq: 6, ts: 6000 },
    });
    await flush(10);
    queryMessageLogSpy.mockClear();

    // The kernel pulls newer-than-5 → cache MISS (no body cached by NEW_MESSAGE) → backend gap-fill.
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 6)],
        hasMore: false,
      }),
    );
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 30,
      lastSeq: 5,
      orderBy: 'asc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([6]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1); // gap-fill — the body wasn't pre-cached
  });

  it('writes dedup by [threadId, seq] (idempotent put — no duplicate rows)', async () => {
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 1)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' }); // same row again
    expect(await dbCount(42)).toBe(1); // one record, not two
  });

  it('marks a backend failure retryable instead of reporting a false edge', async () => {
    queryMessageLogSpy.mockReturnValue(throwError(() => new Error('net')));
    const res = await repo.queryMessages(42, {
      skip: 0,
      take: 3,
      orderBy: 'desc',
    });
    expect(res.data).toEqual([]);
    expect(res.hasMore).toBe(true);
    expect(res.failed).toBe(true);
  });

  it('deleteByThread purges the thread cache but leaves other threads untouched (cache GC)', async () => {
    // Seed two threads: 42 ([1,2,3]) and 99 ([1,2]).
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [3, 2, 1].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [2, 1].map((s) => msg(99, s)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(99, { skip: 0, take: 2, orderBy: 'desc' });
    expect(await dbCount(42)).toBe(3);
    expect(await dbCount(99)).toBe(2);

    await repo.deleteByThread(42);

    expect(await dbCount(42)).toBe(0); // thread 42 purged
    expect(await dbCount(99)).toBe(2); // thread 99 untouched — the range delete is scoped to one thread
  });

  it('after deleteByThread, a getNewer gap-fills from the backend (the stale cache + ceiling are gone)', async () => {
    // Seed thread 42 + establish seq 5 as the prior ceiling.
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 5)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });
    await repo.deleteByThread(42); // purge the cached body + clear maxSeenSeq
    // A real source only paginates from a mounted/cached cursor. Re-seed that cursor after the GC.
    await webdb.putMessages([msg(42, 5)]);
    queryMessageLogSpy.mockClear();

    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 6)],
        hasMore: false,
      }),
    );
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 30,
      lastSeq: 5,
      orderBy: 'asc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([6]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1); // gap-fill — nothing stale served from the purged cache
  });

  // Regression guard for the account-switch bug: logout (clearSession → sessionProfile undefined) must
  // clear the in-memory maxSeenSeq ceiling (it is documented "in-memory only — re-established by the init
  // backend-probe each session"). A stale ceiling from the previous user would make getNewer falsely
  // report the cache reached its ceiling. The per-user IDB is wiped separately by WebdbService.
  it('session-end reset clears maxSeenSeq (a getNewer cache HIT becomes a gap-fill)', async () => {
    // Seed [5,6,7] + establish seq 7 as the ceiling (init sets maxSeenSeq).
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [7, 6, 5].map((s) => msg(42, s)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.mockClear();

    // getNewer (above 4): cache holds [5,6,7] contiguously up to the ceiling (7) → HIT, no backend.
    let res = await repo.queryMessages(42, {
      skip: 1,
      take: 30,
      lastSeq: 4,
      orderBy: 'asc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([5, 6, 7]);
    expect(res.hasMore).toBe(false); // reached the ceiling
    expect(queryMessageLogSpy).not.toHaveBeenCalled();

    // Logout → sessionProfile undefined → the repo's session-end effect fires reset() → ceiling cleared.
    sessionProfile.set(undefined);
    await flush(10);

    // Same query now gap-fills: with no ceiling, the short cached range is not authoritative → backend.
    // (orderBy:'asc' → the backend returns the page ascending.)
    queryMessageLogSpy.mockReturnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [],
        hasMore: false,
      }),
    );
    res = await repo.queryMessages(42, {
      skip: 1,
      take: 30,
      lastSeq: 4,
      orderBy: 'asc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([5, 6, 7]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1); // gap-fill after the ceiling was cleared
    expect(vi.mocked(queryMessageLogSpy).mock.calls[0][0].lastSeq).toBe(7);
  });

  it('does not return or cache an HTTP response from the lifetime before recreation', async () => {
    const response = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.mockReturnValue(response);
    const query = repo.queryMessages(42, {
      skip: 0,
      take: 10,
      orderBy: 'desc',
    });
    while (vi.mocked(queryMessageLogSpy).mock.calls.length === 0) await flush();

    await webdb.recreateMessageCache();
    response.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 9)],
      hasMore: false,
    });
    response.complete();

    const result = await query;
    expect(result.failed).toBe(true);
    expect(result.data).toEqual([]);
    expect(await webdb.getMessage(42, 9)).toBeUndefined();
  });
});
