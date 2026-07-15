import { TestBed } from '@angular/core/testing';
import { ApplicationRef, provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { MissedSyncService } from './missed-sync.service';
import { MessageRepository } from './message-repository.service';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { UserService } from './user.service';
import type { Message, StandardResponse } from './model';

/**
 * MissedSyncService unit tests — the missed-since-HWM paging loop.
 *
 * The service's job is small and the contract precise: bound the first `POST /notifications/missed` by the
 * cached HWM (null → INIT newest-per-thread seed), echo the opaque `cursor` on every later page, and stop at
 * `hasMore:false` — applying each page through `MessageRepository.applyMissed` (spied here). The HttpClient
 * is a Jasmine spy returning scripted pages so the loop is driven deterministically; MessageRepository +
 * WebdbService + UserService are stubs. The eager DB-ready effect is neutralized at construction
 * (`webdb.ready` is a plain function → the effect has no tracked signal deps → runs one no-op pass; and
 * `sessionProfile` is undefined at construction so the effect's condition is false regardless of when it
 * flushes), so each test drives `catchUp()` directly (or via `reconnect$`).
 */

/** A minimal Message row — `createdAt` is the field the HWM tracks. */
function msg(threadId: number, seq: number, createdAt: number): Message {
  return {
    seq, threadId, contentType: 'PURE_TEXT', content: `m${seq}`, creator: 1,
    createdAt, updatedAt: createdAt, isDeleted: false,
  } as unknown as Message;
}

/** Flush the microtask/macrotask queue so the async paging loop + the constructor effect settle. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One paginated /notifications/missed response, code-wrapped. */
function page(
  messages: Message[],
  hasMore: boolean,
  nextCursor?: string,
): StandardResponse<{ messages: Message[]; hasMore: boolean; nextCursor?: string }> {
  return { code: 0, message: 'ok', data: { messages, hasMore, nextCursor } };
}

describe('MissedSyncService', () => {
  let svc: MissedSyncService;
  let postSpy: jasmine.Spy;
  let reconnect$: Subject<void>;
  let sessionProfile: ReturnType<typeof signal<{ id: number } | undefined>>;
  let getHwmSpy: jasmine.Spy;
  let applyMissedSpy: jasmine.Spy;
  /** `webdb.ready` as a plain function (NOT a signal) so the constructor effect reads it once, has no
   *  tracked signal deps, and never re-fires when this boolean flips. */
  let readyFlag: boolean;

  beforeEach(async () => {
    postSpy = jasmine.createSpy('post').and.returnValue(of(page([], false)));
    reconnect$ = new Subject<void>();
    // undefined at construction → the effect's `id != null` is false, so its one pass is a no-op no matter
    // when it flushes. The user is logged in only AFTER the effect has drained (below).
    sessionProfile = signal<{ id: number } | undefined>(undefined);
    getHwmSpy = jasmine.createSpy('getHwm').and.resolveTo(null);
    applyMissedSpy = jasmine.createSpy('applyMissed').and.resolveTo();
    readyFlag = true;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MissedSyncService,
        { provide: HttpClient, useValue: { post: postSpy } },
        { provide: WebdbService, useValue: { ready: () => readyFlag } },
        { provide: WebsocketService, useValue: { reconnect$ } },
        { provide: MessageRepository, useValue: { getHwm: getHwmSpy, applyMissed: applyMissedSpy } },
        { provide: UserService, useValue: { sessionProfile } },
      ],
    });
    svc = TestBed.inject(MissedSyncService);
    // Force the constructor effect's single run now (sessionProfile still undefined → no catchUp), then drain
    // any deferred microtask run, so the effect can never observe a logged-in user later.
    TestBed.inject(ApplicationRef).tick();
    await flush(0);
    sessionProfile.set({ id: 1 });
  });

  /** The POST body (2nd arg, after the URL) of every missed call the catch-up made. */
  function postBodies(): unknown[] {
    return postSpy.calls.all().map((c) => c.args[1]);
  }

  it('first boot (no HWM) → INIT mode: one page with no since/cursor, hasMore:false stops the loop', async () => {
    getHwmSpy.and.resolveTo(null);
    postSpy.and.returnValue(of(page([msg(42, 0, 100)], false)));
    await svc.catchUp();
    expect(applyMissedSpy).toHaveBeenCalledTimes(1);
    expect(applyMissedSpy.calls.mostRecent().args[0]).toEqual([msg(42, 0, 100)]);
    expect(postBodies()).toEqual([{ take: 100 }]); // INIT: no `since`, no `cursor`
  });

  it('catch-up (HWM set) → first page {since:HWM}, then {cursor} until hasMore:false', async () => {
    getHwmSpy.and.resolveTo(5000);
    postSpy.and.returnValues(
      of(page([msg(42, 6, 5100)], true, 'cur1')), // hasMore → continue
      of(page([msg(42, 7, 5200)], false)), // terminal
    );
    await svc.catchUp();
    expect(applyMissedSpy).toHaveBeenCalledTimes(2);
    expect(postBodies()).toEqual([
      { since: 5000, take: 100 }, // first page bound by the HWM
      { cursor: 'cur1', take: 100 }, // subsequent pages echo the opaque cursor; `since` is dropped
    ]);
  });

  it('stops as soon as a page reports hasMore:false (no over-fetching)', async () => {
    getHwmSpy.and.resolveTo(5000);
    postSpy.and.returnValue(of(page([msg(42, 6, 5100)], false)));
    await svc.catchUp();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('single-flight: a second catchUp while one is in flight is a no-op', async () => {
    getHwmSpy.and.resolveTo(null);
    postSpy.and.returnValue(of(page([msg(42, 0, 100)], false)));
    // `inFlight` is set synchronously before the first await, so the second call observes it set.
    const p1 = svc.catchUp();
    const p2 = svc.catchUp();
    await Promise.all([p1, p2]);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(applyMissedSpy).toHaveBeenCalledTimes(1);
  });

  it('bails when no user is logged in (no POST, no apply)', async () => {
    sessionProfile.set(undefined);
    getHwmSpy.and.resolveTo(null);
    await svc.catchUp();
    expect(postSpy).not.toHaveBeenCalled();
    expect(applyMissedSpy).not.toHaveBeenCalled();
  });

  it('a transport failure degrades silently (swallowed — the next reconnect retries)', async () => {
    getHwmSpy.and.resolveTo(null);
    postSpy.and.returnValue(throwError(() => new Error('net')));
    await expectAsync(svc.catchUp()).toBeResolved(); // does not throw
    expect(applyMissedSpy).not.toHaveBeenCalled();
  });

  it('reconnect$ triggers a catch-up', async () => {
    getHwmSpy.and.resolveTo(null);
    postSpy.and.returnValue(of(page([msg(42, 0, 100)], false)));
    reconnect$.next(); // the subscription calls catchUp()
    await flush(10);
    expect(applyMissedSpy).toHaveBeenCalledTimes(1);
  });

  it('skips when the DB is not ready (webdb.ready() false)', async () => {
    readyFlag = false;
    getHwmSpy.and.resolveTo(null);
    postSpy.and.returnValue(of(page([msg(42, 0, 100)], false)));
    await svc.catchUp();
    expect(postSpy).not.toHaveBeenCalled();
    expect(applyMissedSpy).not.toHaveBeenCalled();
  });
});
