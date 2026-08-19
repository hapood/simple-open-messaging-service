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
  let applyReadState: Mock;
  let finishReadCommit: Mock;

  beforeEach(() => {
    commitLocalRead = vi.fn().mockName('commitLocalRead').mockReturnValue(true);
    markRead = vi
      .fn()
      .mockName('markRead')
      .mockReturnValue(of({ code: 0 }));
    applyReadState = vi.fn().mockName('applyReadState');
    finishReadCommit = vi.fn().mockName('finishReadCommit');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ConversationListService,
        {
          provide: ThreadRepository,
          useValue: {
            commitLocalRead,
            applyReadState,
            beginReadCommit: vi.fn().mockName('beginReadCommit'),
            finishReadCommit,
            readCommitPending: signal<ReadonlySet<number>>(
              new Set(),
            ).asReadonly(),
            setOpenThread: vi.fn().mockName('setOpenThread'),
            openThreadId: signal<number | undefined>(7).asReadonly(),
            items: signal([]).asReadonly(),
            refreshPeerOnOpen: vi.fn().mockName('refreshPeerOnOpen'),
            missedCursor: signal(null).asReadonly(),
            advanceMissedCursor: vi.fn().mockName('advanceMissedCursor'),
            markTopOnNextUpdate: vi.fn().mockName('markTopOnNextUpdate'),
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

  it('waits for close, then sends and coalesces later positions while the request is in flight', () => {
    const first = new Subject<{
      code: number;
    }>();
    markRead
      .mockReturnValueOnce(first.asObservable())
      .mockReturnValueOnce(of({ code: 0 }));
    convList.markReadStable(7, 1);
    expect(markRead).not.toHaveBeenCalled();
    convList.close();
    convList.markReadStable(7, 2);
    convList.markReadStable(7, 3);
    expect(commitLocalRead).toHaveBeenCalledTimes(3);
    expect(commitLocalRead).toHaveBeenCalledWith(7, 3);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, localReadHwm: 1 });

    first.next({ code: 0 });
    first.complete();

    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledWith({ threadId: 7, localReadHwm: 3 });
  });

  it('ignores a repeated/stale stable position', () => {
    commitLocalRead.mockReturnValue(false);
    convList.markReadStable(7, 5);
    convList.close();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('flushRead sends the current stable position without waiting for close', () => {
    convList.markReadStable(7, 5);
    expect(markRead).not.toHaveBeenCalled();

    convList.flushRead(7);

    expect(markRead).toHaveBeenCalledTimes(1);

    expect(markRead).toHaveBeenCalledWith({
      threadId: 7,
      localReadHwm: 5,
    });
  });

  it('keeps the syncing state until the authoritative SSE arrives', () => {
    convList.markReadStable(7, 5);
    convList.close();
    expect(applyReadState).not.toHaveBeenCalled();
    expect(finishReadCommit).not.toHaveBeenCalled();
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
  let missedCursor: Mock;
  let threadHwms: Mock;
  let recordThreadDismiss: Mock;
  let clearThreadDismiss: Mock;

  beforeEach(() => {
    missedCursor = vi.fn().mockName('missedCursor').mockReturnValue(null);
    threadHwms = vi.fn().mockName('threadHwms').mockReturnValue({ 7: 3 });
    recordThreadDismiss = vi.fn().mockName('recordThreadDismiss');
    clearThreadDismiss = vi.fn().mockName('clearThreadDismiss');
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
            readCommitPending: signal<ReadonlySet<number>>(
              new Set(),
            ).asReadonly(),
            topInserted: signal(null).asReadonly(),
            setOpenThread: vi.fn().mockName('setOpenThread'),
            missedCursor,
            threadHwms,
            advanceMissedCursor: vi.fn().mockName('advanceMissedCursor'),
            recordThreadDismiss,
            clearThreadDismiss,
          },
        },
        {
          provide: UserService,
          useValue: {
            markRead: () => of({ code: 0 }),
            sessionUserId: signal<number | null>(null),
          },
        },
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
