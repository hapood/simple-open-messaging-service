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
  let eventSubject: Subject<{ event: string; status: number; data?: unknown }>;
  let queryMessageLogSpy: jasmine.Spy;
  /** The sessionProfile signal the repo's session-end effect watches (logout = set undefined). */
  let sessionProfile: ReturnType<typeof signal<{ id: number } | undefined>>;

  beforeEach(async () => {
    eventSubject = new Subject();
    sessionProfile = signal<{ id: number } | undefined>({ id: 1 });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MessageRepository,
        WebdbService,
        { provide: WebsocketService, useValue: { eventSubject } },
        {
          provide: MsgService,
          useValue: {
            queryMessageLog: (queryMessageLogSpy = jasmine.createSpy('queryMessageLog')),
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

  /** Count messages cached for a thread in IDB. */
  async function dbCount(threadId: number): Promise<number> {
    const db = await webdb.db();
    let n = 0;
    let cursor = await db.transaction('messages').store.openCursor(IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity], false, false));
    while (cursor) {
      n++;
      cursor = await cursor.continue();
    }
    return n;
  }

  it('cold init (skip:0) backend-probes + writes through to IDB', async () => {
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3), msg(42, 2), msg(42, 1)],
        hasMore: true,
      }),
    );
    const res = await repo.queryMessages(42, {
      skip: 0,
      take: 3,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([3, 2, 1]); // desc, as returned by the backend
    expect(res.hasMore).toBe(true);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(await dbCount(42)).toBe(3); // write-through
  });

  it('warm init returns the latest IDB page immediately and revalidates in the background', async () => {
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3), msg(42, 2), msg(42, 1)],
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    const refresh$ = new Subject<StandardResponse<Message[]>>();
    queryMessageLogSpy.and.returnValue(refresh$);

    const warm = await repo.queryMessages(42, {
      skip: 0,
      take: 3,
      orderBy: 'desc',
    });
    expect(warm.data.map((m) => m.seq)).toEqual([3, 2, 1]);
    expect(warm.hasMore).toBe(true);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);

    refresh$.next({
      code: 0,
      message: 'ok',
      data: [msg(42, 4), msg(42, 3), msg(42, 2)],
      hasMore: true,
    });
    refresh$.complete();
    await flush(10);
    expect(await dbCount(42)).toBe(4);
  });

  it('warm init emits a live signal when background revalidation finds a newer tail', async () => {
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 2), msg(42, 1)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 2, orderBy: 'desc' });

    const signals: { threadId: number; seq: number }[] = [];
    repo.liveSignal$.subscribe((s) => signals.push(s));
    queryMessageLogSpy.and.returnValue(
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
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3), msg(42, 2), msg(42, 1)],
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 3)],
        hasMore: false,
      }),
    );
    const warm = await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' }, 2500);

    expect(warm.data.map((m) => m.seq)).toEqual([3]);
    expect(warm.data.every((m) => m.createdAt > 2500)).toBe(true);
  });

  it('getOlder (skip:1) is a cache HIT for a contiguous held range → no backend call', async () => {
    // Seed the cache with seqs 1..5 (a prior session's scroll).
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [5, 4, 3, 2, 1].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 5, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

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
    // Empty cache; getOlder(cursor=6, take=3) must backfill from the API.
    queryMessageLogSpy.and.returnValue(
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
    expect(await dbCount(42)).toBe(3); // gap-fill persisted → next time is a cache hit
  });

  it('getOlder floor: a contiguous cache reaching seq 0 reports hasMore=false (no backend)', async () => {
    // Seed [0,1,2] (the whole small thread) + establish hasMore via the seeding call.
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [2, 1, 0].map((s) => msg(42, s)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    // getOlder(cursor=2, take=3): cache holds [0,1] below 2, contiguous to the floor (seq 0) → hit, hasMore=false.
    const res = await repo.queryMessages(42, {
      skip: 1,
      take: 3,
      lastSeq: 2,
      orderBy: 'desc',
    });
    expect(res.data.map((m) => m.seq)).toEqual([1, 0]);
    expect(res.hasMore).toBe(false); // reached seq 0 → no older
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
  });

  it('getOlder with a fragmented cache (gap below cursor) gap-fills instead of serving a gapped range', async () => {
    // Seed only [5, 3] (missing 4 — e.g. a jump-to-message left a gap). getOlder(cursor=6, take=3) must NOT
    // serve the gapped [5, 3] — it backfills the contiguous truth from the API.
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [5, 3].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 2, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    queryMessageLogSpy.and.returnValue(
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
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]); // contiguous, not the gapped [5, 3]
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('NEW_MESSAGE emits the live signal WITHOUT caching the body (identity-only — body is pulled)', async () => {
    let emitted: { threadId: number; seq: number } | undefined;
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
    queryMessageLogSpy.and.returnValue(
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
    queryMessageLogSpy.calls.reset();

    // The kernel pulls newer-than-5 → cache MISS (no body cached by NEW_MESSAGE) → backend gap-fill.
    queryMessageLogSpy.and.returnValue(
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
    queryMessageLogSpy.and.returnValue(
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

  it('a backend failure degrades to an empty page (the cache survives a transient outage)', async () => {
    queryMessageLogSpy.and.returnValue(throwError(() => new Error('net')));
    const res = await repo.queryMessages(42, {
      skip: 0,
      take: 3,
      orderBy: 'desc',
    });
    expect(res.data).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it('deleteByThread purges the thread cache but leaves other threads untouched (cache GC)', async () => {
    // Seed two threads: 42 ([1,2,3]) and 99 ([1,2]).
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [3, 2, 1].map((s) => msg(42, s)),
        hasMore: true,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.and.returnValue(
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
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [msg(42, 5)],
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });
    await repo.deleteByThread(42); // purge the cached body + clear maxSeenSeq
    queryMessageLogSpy.calls.reset();

    queryMessageLogSpy.and.returnValue(
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
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [7, 6, 5].map((s) => msg(42, s)),
        hasMore: false,
      }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

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
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({
        code: 0,
        message: 'ok',
        data: [5, 6, 7].map((s) => msg(42, s)),
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
  });

  // ── applyMissed: the missed-catch-up shared apply path (a paginated /notifications/missed page → batch
  //    cache + HWM advance + one signal per thread). The SAME path a live NEW_MESSAGE takes; idempotent.
  describe('applyMissed (missed catch-up shared path)', () => {
    it('caches a batch across threads + is idempotent on re-apply (no duplicate rows)', async () => {
      await repo.applyMissed([msg(42, 1), msg(42, 2), msg(99, 1)]);
      expect(await dbCount(42)).toBe(2);
      expect(await dbCount(99)).toBe(1);
      await repo.applyMissed([msg(42, 1), msg(42, 2), msg(99, 1)]); // re-fetch → overwrite, not duplicate
      expect(await dbCount(42)).toBe(2);
      expect(await dbCount(99)).toBe(1);
    });

    it('emits ONE live signal per affected thread (its highest seq), not one per message', async () => {
      const signals: { threadId: number; seq: number }[] = [];
      repo.liveSignal$.subscribe((s) => signals.push(s));
      await repo.applyMissed([msg(42, 1), msg(42, 5), msg(42, 3), msg(99, 2)]);
      // thread 42 collapses to seq 5, thread 99 to seq 2 — exactly two signals, in first-seen order.
      expect(signals).toEqual([
        { threadId: 42, seq: 5 },
        { threadId: 99, seq: 2 },
      ]);
    });

    it('an empty page is a no-op (no signal)', async () => {
      const signals: { threadId: number; seq: number }[] = [];
      repo.liveSignal$.subscribe((s) => signals.push(s));
      await repo.applyMissed([]);
      expect(signals).toEqual([]);
    });
  });
});
