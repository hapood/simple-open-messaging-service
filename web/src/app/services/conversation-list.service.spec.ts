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
  let commitLocalRead: jasmine.Spy;
  let markRead: jasmine.Spy;

  beforeEach(() => {
    commitLocalRead = jasmine
      .createSpy('commitLocalRead')
      .and.returnValue(true);
    markRead = jasmine.createSpy('markRead').and.returnValue(of({ code: 0 }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ConversationListService,
        {
          provide: ThreadRepository,
          useValue: {
            commitLocalRead,
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

  it('sends a stable read immediately and coalesces later positions while it is in flight', () => {
    const first = new Subject<{ code: number }>();
    markRead.and.returnValues(first.asObservable(), of({ code: 0 }));
    convList.markReadStable(7, 1);
    convList.markReadStable(7, 2);
    convList.markReadStable(7, 3);
    expect(commitLocalRead).toHaveBeenCalledTimes(3);
    expect(commitLocalRead).toHaveBeenCalledWith(7, 3);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, lastReadSeq: 1 });

    first.next({ code: 0 });
    first.complete();

    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, lastReadSeq: 3 });
  });

  it('ignores a repeated/stale stable position', () => {
    commitLocalRead.and.returnValue(false);
    convList.markReadStable(7, 5);
    expect(markRead).not.toHaveBeenCalled();
  });
});

/**
 * The away-cursor + per-thread dismiss-HWM delegations. `missedCursor`/`threadHwms` are METHOD delegators
 * (the repo exposes them as methods, not bound signals), so they must reach the repo on call — the legacy
 * `readonly = this.repo.missedCursor` field-copy captured an UNBOUND method and threw (silently swallowed by
 * the away-renderer's try/catch). This guard pins the fix.
 */
describe('ConversationListService (cursor + threadHwms delegation)', () => {
  let convList: ConversationListService;
  let missedCursor: jasmine.Spy;
  let threadHwms: jasmine.Spy;
  let recordThreadDismiss: jasmine.Spy;
  let clearThreadDismiss: jasmine.Spy;

  beforeEach(() => {
    missedCursor = jasmine.createSpy('missedCursor').and.returnValue(null);
    threadHwms = jasmine.createSpy('threadHwms').and.returnValue({ 7: 3 });
    recordThreadDismiss = jasmine.createSpy('recordThreadDismiss');
    clearThreadDismiss = jasmine.createSpy('clearThreadDismiss');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ConversationListService,
        {
          provide: ThreadRepository,
          useValue: {
            items: signal([]).asReadonly(),
            status: signal('LOADING').asReadonly(),
            error: signal('').asReadonly(),
            openThreadId: signal(undefined).asReadonly(),
            topInserted: signal(null).asReadonly(),
            setOpenThread: jasmine.createSpy('setOpenThread'),
            missedCursor,
            threadHwms,
            advanceMissedCursor: jasmine.createSpy('advanceMissedCursor'),
            recordThreadDismiss,
            clearThreadDismiss,
          },
        },
        { provide: UserService, useValue: { markRead: () => of({ code: 0 }), sessionUserId: signal<number | null>(null) } },
        { provide: GroupService, useValue: {} },
      ],
    });
    convList = TestBed.inject(ConversationListService);
  });

  it('missedCursor / threadHwms delegate to the repo (method delegators, not field-copies)', () => {
    expect(convList.missedCursor()).toBeNull();
    expect(missedCursor).toHaveBeenCalledTimes(1);
    expect(convList.threadHwms()).toEqual({ 7: 3 });
    expect(threadHwms).toHaveBeenCalledTimes(1);
  });

  it('recordThreadDismiss / clearThreadDismiss delegate to the repo', () => {
    convList.recordThreadDismiss({ threadId: 7, seq: 9 });
    expect(recordThreadDismiss).toHaveBeenCalledWith({ threadId: 7, seq: 9 });
    convList.clearThreadDismiss();
    expect(clearThreadDismiss).toHaveBeenCalledTimes(1);
  });
});
