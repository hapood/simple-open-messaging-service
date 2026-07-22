import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { ThreadRepository } from './thread-store.service';
import { UserService } from './user.service';
import { GroupService } from './group.service';

/**
 * ConversationListService markRead flush (B1) — the debounce + coalesce + flush-on-close of the open-thread
 * new-message → markRead path. The repo is STUBBED (a Subject for `openThreadMessage$` the test drives + spies
 * for the repo mutations), so this tests the facade's write-orchestration in isolation — no IDB / SSE / HELLO.
 */
describe('ConversationListService markRead flush (B1)', () => {
  let convList: ConversationListService;
  let openMsg$: Subject<{ threadId: number; seq: number }>;
  let noteOptimisticRead: jasmine.Spy;
  let markRead: jasmine.Spy;

  beforeEach(() => {
    openMsg$ = new Subject();
    noteOptimisticRead = jasmine.createSpy('noteOptimisticRead');
    markRead = jasmine.createSpy('markRead').and.returnValue(of({ code: 0 }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ConversationListService,
        {
          provide: ThreadRepository,
          useValue: {
            openThreadMessage$: openMsg$.asObservable(),
            noteOptimisticRead,
            setOpenThread: jasmine.createSpy('setOpenThread'),
            openThreadId: signal<number | undefined>(undefined).asReadonly(),
            items: signal([]).asReadonly(),
            clearUnread: jasmine.createSpy('clearUnread'),
            refreshPeerOnOpen: jasmine.createSpy('refreshPeerOnOpen'),
            missedCursor: signal(null).asReadonly(),
            advanceMissedCursor: jasmine.createSpy('advanceMissedCursor'),
            markTopOnNextUpdate: jasmine.createSpy('markTopOnNextUpdate'),
            load: jasmine.createSpy('load'),
          },
        },
        { provide: UserService, useValue: { markRead, sessionUserId: signal<number | null>(null) } },
        { provide: GroupService, useValue: {} },
      ],
    });
    convList = TestBed.inject(ConversationListService);
  });

  it('coalesces a burst of open-thread new messages into ONE markRead POST with the max seq', async () => {
    // A 3-message burst for the open thread, fired inside the 500ms debounce window.
    openMsg$.next({ threadId: 7, seq: 1 });
    openMsg$.next({ threadId: 7, seq: 2 });
    openMsg$.next({ threadId: 7, seq: 3 });
    // Each emission records the optimistic watermark immediately (so the UI doesn't wait on the POST).
    expect(noteOptimisticRead).toHaveBeenCalledTimes(3);
    expect(noteOptimisticRead).toHaveBeenCalledWith(7, 3);
    expect(markRead).not.toHaveBeenCalled(); // no POST yet — debounced

    await new Promise((r) => setTimeout(r, 600)); // past the 500ms trailing debounce
    // One POST, advancing to the max seq (the backend's advanceReadCursor is monotonic — only the max matters).
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, lastReadSeq: 3 });
  });

  it('flush-on-close fires the pending markRead immediately (navigate away mid-burst)', () => {
    openMsg$.next({ threadId: 7, seq: 5 });
    expect(markRead).not.toHaveBeenCalled(); // still within the debounce window
    convList.close();
    // close() flushes before clearing the open thread, so a burst cut short by navigation is still recorded.
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, lastReadSeq: 5 });
  });
});
