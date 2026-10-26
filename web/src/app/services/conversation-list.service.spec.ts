import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, Subject } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { ThreadRepository } from './thread-store.service';
import { UserService } from './user.service';
import { GroupService } from './group.service';

/**
 * Stable viewport reads are persisted locally first, then debounce/coalesce their maximum into markRead.
 */
describe('ConversationListService stable markRead flush', () => {
  let convList: ConversationListService;
  let commitLocalRead: Mock;
  let markRead: Mock;

  beforeEach(() => {
    commitLocalRead = vi.fn().mockName('commitLocalRead').mockReturnValue(true);
    markRead = vi
      .fn()
      .mockName('markRead')
      .mockReturnValue(of({ code: 0 }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ConversationListService,
        {
          provide: ThreadRepository,
          useValue: {
            commitLocalRead,
            setOpenThread: vi.fn().mockName('setOpenThread'),
            openThreadId: signal<number | undefined>(7).asReadonly(),
            items: signal([]).asReadonly(),
            readCursorState: vi.fn(),
            refreshPeerOnOpen: vi.fn().mockName('refreshPeerOnOpen'),
            load: vi.fn().mockName('load'),
          },
        },
        {
          provide: UserService,
          useValue: { markRead, sessionUserId: signal<number | null>(null) },
        },
        { provide: GroupService, useValue: {} },
      ],
    });
    convList = TestBed.inject(ConversationListService);
  });

  it('submits stable reads immediately without waiting for an earlier request or closing', () => {
    const first = new Subject<{ code: number }>();
    markRead.mockReturnValueOnce(first);
    convList.markReadStable(7, 1);
    convList.markReadStable(7, 3);
    expect(markRead.mock.calls).toEqual([
      [{ threadId: 7, localReadHwm: 1 }],
      [{ threadId: 7, localReadHwm: 3 }],
    ]);
    first.complete();
    convList.close();
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated/stale stable position', () => {
    commitLocalRead.mockReturnValue(false);
    convList.markReadStable(7, 5);
    convList.close();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('captures unread before the nav effect opens the thread and preserves it after reads', () => {
    const repo = TestBed.inject(ThreadRepository);
    Object.assign(repo, {
      openThreadId: signal<number | undefined>(undefined).asReadonly(),
      items: signal([
        { threadId: 7, unreadCount: 2, messageEndSeq: 25, lastReadSeq: 23 },
      ]).asReadonly(),
    });
    vi.mocked(repo.readCursorState).mockReturnValue({
      serverLastReadSeq: 23,
      localStableReadSeq: 23,
      effectiveLastReadSeq: 23,
    });

    expect(convList.previewUnreadEntryBoundary(7)).toMatchObject({
      firstUnreadSeq: 24,
    });
    Object.assign(repo, {
      items: signal([
        { threadId: 7, unreadCount: 0, messageEndSeq: 25, lastReadSeq: 25 },
      ]).asReadonly(),
    });
    expect(convList.captureUnreadEntryBoundary(7)).toBeUndefined();
    Object.assign(repo, {
      items: signal([
        { threadId: 7, unreadCount: 2, messageEndSeq: 25, lastReadSeq: 23 },
      ]).asReadonly(),
    });
    const boundary = convList.captureUnreadEntryBoundary(7);
    expect(boundary).toMatchObject({ firstUnreadSeq: 24, unreadCount: 2 });
    Object.assign(repo, {
      items: signal([
        { threadId: 7, unreadCount: 0, messageEndSeq: 25, lastReadSeq: 25 },
      ]).asReadonly(),
    });
    convList.open(7);
    expect(convList.captureUnreadEntryBoundary(7)).toBe(boundary);
    expect(repo.setOpenThread).toHaveBeenCalledWith(7);
  });
});
