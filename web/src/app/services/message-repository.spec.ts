// Unit tests for the pure mediaStatus reducer — the single decision point every mediaStatus update
// (SSE MEDIA_STATUS, the scroll probe, the manual-retry ack) flows through. No Angular TestBed needed:
// reduceMediaStatus is a pure function with no service dependencies.
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Subject } from 'rxjs';
import { MessageRepository, reduceMediaStatus } from './message-repository.service';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MsgService } from './message.service';
import { UserService } from './user.service';

describe('reduceMediaStatus', () => {
  it('accepts a terminal when there is no current state', () => {
    expect(reduceMediaStatus(undefined, { status: 'ready', sv: 1 })).toEqual({ status: 'ready', sv: 1 });
    expect(reduceMediaStatus(undefined, { status: 'failed', sv: 1 })).toEqual({ status: 'failed', sv: 1 });
  });

  it('a greater-sv terminal overrides an older one (a retry fresh ready wins over a stale failed)', () => {
    expect(reduceMediaStatus({ status: 'failed', sv: 1 }, { status: 'ready', sv: 2 })).toEqual({ status: 'ready', sv: 2 });
    expect(reduceMediaStatus({ status: 'ready', sv: 1 }, { status: 'failed', sv: 2 })).toEqual({ status: 'failed', sv: 2 });
  });

  it('drops a stale (sv <= current) event — anti-regression', () => {
    // a stale failed cannot un-ready; same-sv is also stale (terminals share the version space)
    expect(reduceMediaStatus({ status: 'ready', sv: 5 }, { status: 'failed', sv: 3 })).toBeNull();
    expect(reduceMediaStatus({ status: 'ready', sv: 5 }, { status: 'failed', sv: 5 })).toBeNull();
    expect(reduceMediaStatus({ status: 'failed', sv: 5 }, { status: 'ready', sv: 5 })).toBeNull();
  });

  it('is idempotent for the same {status, sv}', () => {
    expect(reduceMediaStatus({ status: 'ready', sv: 2 }, { status: 'ready', sv: 2 })).toBeNull();
    expect(reduceMediaStatus({ status: 'failed', sv: 2 }, { status: 'failed', sv: 2 })).toBeNull();
  });
});

describe('MessageRepository.applyMediaStatus', () => {
  let repo: MessageRepository;
  let dbGet: jasmine.Spy;
  let dbPut: jasmine.Spy;

  beforeEach(() => {
    dbGet = jasmine.createSpy('get');
    dbPut = jasmine.createSpy('put').and.resolveTo(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MessageRepository,
        {
          provide: WebdbService,
          useValue: {
            getMessage: async (...args: unknown[]) => dbGet(...args),
            putMessages: async (messages: unknown[]) => dbPut('messages', messages[0]),
          },
        },
        { provide: WebsocketService, useValue: { eventSubject: new Subject(), reconnect$: new Subject() } },
        { provide: MsgService, useValue: {} },
        { provide: UserService, useValue: { sessionProfile: () => null } },
      ],
    });
    repo = TestBed.inject(MessageRepository);
  });

  const cached = (over: Record<string, unknown>) => ({
    threadId: 1, seq: 5, content: '', contentType: 'IMAGE', ...over,
  });

  it('returns false + no write when the message is not cached', async () => {
    dbGet.and.resolveTo(undefined);
    expect(await repo.applyMediaStatus(1, 5, 'ready', 1)).toBe(false);
    expect(dbPut).not.toHaveBeenCalled();
  });

  it('writes + signals on accept (downloading → ready)', async () => {
    dbGet.and.resolveTo(cached({ mediaStatus: 'downloading', sv: 1 }));
    let fired = false;
    repo.mediaStatusLive$.subscribe(() => (fired = true));
    expect(await repo.applyMediaStatus(1, 5, 'ready', 2)).toBe(true);
    expect(dbPut).toHaveBeenCalledTimes(1);
    expect(fired).toBe(true);
  });

  it('no write + no signal on reject (stale sv — anti-regression)', async () => {
    dbGet.and.resolveTo(cached({ mediaStatus: 'ready', sv: 5 }));
    let fired = false;
    repo.mediaStatusLive$.subscribe(() => (fired = true));
    expect(await repo.applyMediaStatus(1, 5, 'failed', 3)).toBe(false);
    expect(dbPut).not.toHaveBeenCalled();
    expect(fired).toBe(false);
  });
});
