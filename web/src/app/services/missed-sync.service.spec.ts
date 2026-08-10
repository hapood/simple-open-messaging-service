import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MissedSyncService } from './missed-sync.service';
import type { StandardResponse } from './model';
import type { MissedSummaryResult } from './missed-sync.service';

/**
 * fetchMissedSummary (POST /notifications/missed-summary) + fetchAwayNotifications (POST /notifications/missed)
 * — the two separated endpoints. POSTs {from?, to, take} (the threadlist body walk) and {since?} (the away
 * summary). Thread-list results never write the chatbox message store. Stateless + per-path single-flight
 * (a concurrent call is a no-op → empty result).
 */
describe('MissedSyncService', () => {
  let svc: MissedSyncService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        MissedSyncService,
      ],
    });
    svc = TestBed.inject(MissedSyncService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** A minimal latest-message body the endpoint returns per thread. */
  function body(threadId: number, seq: number, content: string) {
    return {
      threadId,
      seq,
      contentType: 'PURE_TEXT',
      content,
      creator: 1,
      createdAt: seq * 1000,
      mediaStatus: 'ready' as const,
      sv: seq,
    };
  }

  it('fetchMissedSummary: POSTs {to, take} and returns thread-list data without a chatbox write', async () => {
    const res: StandardResponse<MissedSummaryResult> = {
      code: 0,
      message: 'ok',
      data: {
        items: [
          {
            threadId: 1,
            type: 'P2P',
            displayName: 'Alice',
            unreadCount: 2,
            muted: false,
            lastReadSeq: 3,
            senderAvatarUrl: '',
            senderUserId: 11,
            latestMessage: body(1, 5, 'hi'),
          },
          {
            threadId: 2,
            type: 'GROUP',
            displayName: 'Team',
            unreadCount: 1,
            muted: true,
            lastReadSeq: 2,
            senderAvatarUrl: '',
            senderUserId: 22,
            latestMessage: body(2, 3, 'yo'),
          },
        ],
        hasMore: false,
        nextCursor: { threadId: 2, seq: 3 },
      },
    };
    const p = svc.fetchMissedSummary(null, { threadId: 9, seq: 9 });
    const req = httpMock.expectOne('/api/v1/thread-sync/catch-up');
    expect(req.request.body).toEqual({
      to: { threadId: 9, seq: 9 },
      take: 200,
    }); // no `from` key (null)
    req.flush(res);
    const result = await p;

    expect(result.items.length).toBe(2);
    expect(result.nextCursor).toEqual({ threadId: 2, seq: 3 });
  });

  it('fetchMissedSummary: POSTs {from, to, take} when from is set', async () => {
    const p = svc.fetchMissedSummary(
      { threadId: 1, seq: 4 },
      { threadId: 9, seq: 9 },
    );
    const req = httpMock.expectOne('/api/v1/thread-sync/catch-up');
    expect(req.request.body).toEqual({
      from: { threadId: 1, seq: 4 },
      to: { threadId: 9, seq: 9 },
      take: 200,
    });
    req.flush({
      code: 0,
      message: 'ok',
      data: { items: [], hasMore: false, nextCursor: null },
    });
    const result = await p;
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('fetchMissedSummary: a concurrent call is a no-op (single-flight → empty, no second request)', async () => {
    const p1 = svc.fetchMissedSummary(
      { threadId: 1, seq: 4 },
      { threadId: 9, seq: 9 },
    );
    const p2 = svc.fetchMissedSummary(
      { threadId: 1, seq: 4 },
      { threadId: 9, seq: 9 },
    );
    expect((await p2).items).toEqual([]);
    httpMock
      .expectOne('/api/v1/thread-sync/catch-up')
      .flush({
        code: 0,
        message: 'ok',
        data: { items: [], hasMore: false, nextCursor: null },
      });
    await p1;
  });

  it('fetchMissedSummary: a non-zero / network-failed response degrades to empty', async () => {
    const p = svc.fetchMissedSummary(
      { threadId: 1, seq: 4 },
      { threadId: 9, seq: 9 },
    );
    httpMock
      .expectOne('/api/v1/thread-sync/catch-up')
      .flush({ code: 1, message: 'err', data: null });
    const result = await p;
    expect(result.items).toEqual([]);
  });

  it('fetchAwayNotifications: POSTs {since, previewMode} → returns descriptors', async () => {
    const p = svc.fetchAwayNotifications({ threadId: 1, seq: 4 });
    const req = httpMock.expectOne('/api/v1/notification-feed/query');
    // grouping defaults to 'thread' (always sent); threadHwms omitted when not passed.
    expect(req.request.body).toEqual({
      since: { threadId: 1, seq: 4 },
      previewMode: 'message',
    });
    req.flush({
      code: 0,
      message: 'ok',
      data: {
        notifications: [
          { tag: 'soms-thread-1', kind: 'thread-message', body: 'x', count: 1 },
        ],
      },
    });
    const result = await p;
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('thread-message');
  });

  it('fetchAwayNotifications: since null → POSTs preview mode only', async () => {
    const p = svc.fetchAwayNotifications(null);
    const req = httpMock.expectOne('/api/v1/notification-feed/query');
    expect(req.request.body).toEqual({ previewMode: 'message' });
    req.flush({ code: 0, message: 'ok', data: { notifications: [] } });
    expect(await p).toEqual([]);
  });
});
