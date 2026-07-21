import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MissedSyncService } from './missed-sync.service';
import { MessageRepository } from './message-repository.service';
import type { StandardResponse } from './model';
import type { MissedSummaryResult } from './missed-sync.service';

/**
 * fetchMissedSummary — the cursor-based missed-summary puller. POSTs /notifications/missed {cursor, take}
 * (one page; the caller advances its cursor to `nextCursor`), caches each latest-message body via
 * MessageRepository.applyMissed (pre-warm), and returns { items, hasMore, nextCursor, notifications }.
 * Stateless + single-flight (a concurrent call is a no-op → empty result).
 */
describe('MissedSyncService.fetchMissedSummary', () => {
  let svc: MissedSyncService;
  let httpMock: HttpTestingController;
  let applyMissedSpy: ReturnType<typeof jasmine.createSpy>;

  beforeEach(() => {
    applyMissedSpy = jasmine.createSpy('applyMissed').and.resolveTo(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MissedSyncService,
        { provide: MessageRepository, useValue: { applyMissed: applyMissedSpy } },
      ],
    });
    svc = TestBed.inject(MissedSyncService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** A minimal latest-message body the endpoint returns per thread. */
  function body(threadId: number, seq: number, content: string) {
    return { threadId, seq, contentType: 'PURE_TEXT', content, creator: 1, createdAt: seq * 1000, mediaStatus: 'ready' as const, sv: seq };
  }

  it('POSTs {cursor, take} and caches each latest-message body via applyMissed', async () => {
    const res: StandardResponse<MissedSummaryResult> = {
      code: 0, message: 'ok',
      data: {
        items: [
          { threadId: 1, type: 'P2P', displayName: 'Alice', unreadCount: 2, muted: false, senderAvatarUrl: '', senderUserId: 11, latestMessage: body(1, 5, 'hi') },
          { threadId: 2, type: 'GROUP', displayName: 'Team', unreadCount: 1, muted: true, senderAvatarUrl: '', senderUserId: 22, latestMessage: body(2, 3, 'yo') },
        ],
        hasMore: false,
        nextCursor: { threadId: 2, seq: 3 },
        notifications: [],
      },
    };
    const p = svc.fetchMissedSummary({ threadId: 1, seq: 4 });
    const req = httpMock.expectOne('/api/v1/notifications/missed');
    expect(req.request.body).toEqual({ cursor: { threadId: 1, seq: 4 }, take: 50 });
    req.flush(res);
    const result = await p;

    expect(result.items.length).toBe(2);
    expect(result.nextCursor).toEqual({ threadId: 2, seq: 3 });
    expect(applyMissedSpy).toHaveBeenCalledTimes(1);
    const cached = applyMissedSpy.calls.mostRecent().args[0] as Array<{ threadId: number; seq: number; content: string }>;
    expect(cached.map((m) => [m.threadId, m.seq, m.content])).toEqual([[1, 5, 'hi'], [2, 3, 'yo']]);
  });

  it('omits `cursor` from the body when null (snapshot pull)', async () => {
    const p = svc.fetchMissedSummary(null);
    const req = httpMock.expectOne('/api/v1/notifications/missed');
    expect(req.request.body).toEqual({ take: 50 }); // no `cursor` key
    req.flush({ code: 0, message: 'ok', data: { items: [], hasMore: false, nextCursor: null, notifications: [] } });
    const result = await p;
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(applyMissedSpy).not.toHaveBeenCalled(); // no bodies → no applyMissed
  });

  it('a concurrent call is a no-op (single-flight → empty result, no second request)', async () => {
    const p1 = svc.fetchMissedSummary({ threadId: 1, seq: 4 });
    const p2 = svc.fetchMissedSummary({ threadId: 1, seq: 4 });
    expect((await p2).items).toEqual([]);
    httpMock.expectOne('/api/v1/notifications/missed').flush({ code: 0, message: 'ok', data: { items: [], hasMore: false, nextCursor: null, notifications: [] } });
    await p1;
  });

  it('a non-zero / network-failed response degrades to an empty result (applyMissed not called)', async () => {
    const p = svc.fetchMissedSummary({ threadId: 1, seq: 4 });
    httpMock.expectOne('/api/v1/notifications/missed').flush({ code: 1, message: 'err', data: null });
    const result = await p;
    expect(result.items).toEqual([]);
    expect(applyMissedSpy).not.toHaveBeenCalled();
  });
});
