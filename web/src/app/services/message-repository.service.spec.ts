import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { MessageRepository } from './message-repository.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import type { Message, StandardResponse } from './model';

/** Flush the microtask + macrotask queue so async IDB writes + the NEW_MESSAGE handler settle. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal Message row (seq is the IDB key second component + the cursor the kernel uses). */
function msg(threadId: number, seq: number, content = `m${seq}`): Message {
  return {
    seq, contentType: 'PURE_TEXT', content, threadId, creator: 1,
    createdAt: seq * 1000, updatedAt: seq * 1000, isDeleted: false,
  } as unknown as Message;
}

describe('MessageRepository', () => {
  let repo: MessageRepository;
  let webdb: WebdbService;
  let eventSubject: Subject<{ event: string; status: number; data?: unknown }>;
  let queryMessageLogSpy: jasmine.Spy;

  beforeEach(async () => {
    eventSubject = new Subject();
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
    let cursor = await db.transaction('messages').store.openCursor(
      IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity], false, false),
    );
    while (cursor) { n++; cursor = await cursor.continue(); }
    return n;
  }

  it('init (skip:0) backend-probes + writes through to IDB', async () => {
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [msg(42, 3), msg(42, 2), msg(42, 1)], hasMore: true }),
    );
    const res = await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    expect(res.data.map((m) => m.seq)).toEqual([3, 2, 1]); // desc, as returned by the backend
    expect(res.hasMore).toBe(true);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(await dbCount(42)).toBe(3); // write-through
  });

  it('getOlder (skip:1) is a cache HIT for a contiguous held range → no backend call', async () => {
    // Seed the cache with seqs 1..5 (a prior session's scroll).
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [5, 4, 3, 2, 1].map((s) => msg(42, s)), hasMore: true }),
    );
    await repo.queryMessages(42, { skip: 0, take: 5, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    // getOlder(cursor=6, take=3): the cache holds [3,4,5] contiguously below 6 → served from IDB.
    const res = await repo.queryMessages(42, { skip: 1, take: 3, lastSeq: 6, orderBy: 'desc' });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]); // desc, highest-first below 6
    expect(res.hasMore).toBe(true); // seq 3 > 0 → there is older
    expect(queryMessageLogSpy).not.toHaveBeenCalled(); // cache HIT — no duplicate pull
  });

  it('getOlder GAP-FILLS when the cache lacks the range → backend called + cached', async () => {
    // Empty cache; getOlder(cursor=6, take=3) must backfill from the API.
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [5, 4, 3].map((s) => msg(42, s)), hasMore: true }),
    );
    const res = await repo.queryMessages(42, { skip: 1, take: 3, lastSeq: 6, orderBy: 'desc' });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]);
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
    expect(await dbCount(42)).toBe(3); // gap-fill persisted → next time is a cache hit
  });

  it('getOlder floor: a contiguous cache reaching seq 0 reports hasMore=false (no backend)', async () => {
    // Seed [0,1,2] (the whole small thread) + establish hasMore via the seeding call.
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [2, 1, 0].map((s) => msg(42, s)), hasMore: false }),
    );
    await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    // getOlder(cursor=2, take=3): cache holds [0,1] below 2, contiguous to the floor (seq 0) → hit, hasMore=false.
    const res = await repo.queryMessages(42, { skip: 1, take: 3, lastSeq: 2, orderBy: 'desc' });
    expect(res.data.map((m) => m.seq)).toEqual([1, 0]);
    expect(res.hasMore).toBe(false); // reached seq 0 → no older
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
  });

  it('getOlder with a fragmented cache (gap below cursor) gap-fills instead of serving a gapped range', async () => {
    // Seed only [5, 3] (missing 4 — e.g. a jump-to-message left a gap). getOlder(cursor=6, take=3) must NOT
    // serve the gapped [5, 3] — it backfills the contiguous truth from the API.
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [5, 3].map((s) => msg(42, s)), hasMore: true }),
    );
    await repo.queryMessages(42, { skip: 0, take: 2, orderBy: 'desc' });
    queryMessageLogSpy.calls.reset();

    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [5, 4, 3].map((s) => msg(42, s)), hasMore: true }),
    );
    const res = await repo.queryMessages(42, { skip: 1, take: 3, lastSeq: 6, orderBy: 'desc' });
    expect(res.data.map((m) => m.seq)).toEqual([5, 4, 3]); // contiguous, not the gapped [5, 3]
    expect(queryMessageLogSpy).toHaveBeenCalledTimes(1);
  });

  it('NEW_MESSAGE caches the body, then emits liveSignal$ (body cached BEFORE the signal)', async () => {
    let emitted: { threadId: number; seq: number } | undefined;
    repo.liveSignal$.subscribe((s) => (emitted = s));

    eventSubject.next({ event: 'NEW_MESSAGE', status: 0, data: msg(42, 7, 'live') });
    await flush(10);

    expect(emitted).toEqual({ threadId: 42, seq: 7 }); // signal fired
    // The body was cached (the kernel's subsequent getNewer is a cache hit):
    const res = await repo.queryMessages(42, { skip: 1, take: 30, lastSeq: 6, orderBy: 'asc' });
    expect(res.data.map((m) => m.seq)).toEqual([7]);
    expect(res.hasMore).toBe(false); // seq 7 is the ceiling (maxSeenSeq) → no more newer
  });

  it('getNewer cache HIT on a NEW_MESSAGE-cached body (live arrival → no backend round-trip)', async () => {
    // Establish seq 5 as the prior latest via a backend init (sets maxSeenSeq).
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [msg(42, 5)], hasMore: false }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });

    // A live arrival (seq 6) is cached by the NEW_MESSAGE handler.
    eventSubject.next({ event: 'NEW_MESSAGE', status: 0, data: msg(42, 6, 'live') });
    await flush(10);
    queryMessageLogSpy.calls.reset();

    // The kernel pulls newer-than-5 → cache HIT (body cached by NEW_MESSAGE), no backend.
    const res = await repo.queryMessages(42, { skip: 1, take: 30, lastSeq: 5, orderBy: 'asc' });
    expect(res.data.map((m) => m.seq)).toEqual([6]);
    expect(res.hasMore).toBe(false);
    expect(queryMessageLogSpy).not.toHaveBeenCalled();
  });

  it('writes dedup by [threadId, seq] (idempotent put — no duplicate rows)', async () => {
    queryMessageLogSpy.and.returnValue(
      of<StandardResponse<Message[]>>({ code: 0, message: 'ok', data: [msg(42, 1)], hasMore: false }),
    );
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' });
    await repo.queryMessages(42, { skip: 0, take: 1, orderBy: 'desc' }); // same row again
    expect(await dbCount(42)).toBe(1); // one record, not two
  });

  it('a backend failure degrades to an empty page (the cache survives a transient outage)', async () => {
    queryMessageLogSpy.and.returnValue(
      throwError(() => new Error('net')),
    );
    const res = await repo.queryMessages(42, { skip: 0, take: 3, orderBy: 'desc' });
    expect(res.data).toEqual([]);
    expect(res.hasMore).toBe(false);
  });
});
