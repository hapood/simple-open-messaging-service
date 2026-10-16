import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { NativeCommitEventsService } from './native-commit-events.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService, provideWebdbService } from './webdb.service';

/** Native IPC completions are a storage port, not an eager realtime/auth dependency. */
describe('native database completion port', () => {
  let storage: WebdbService;
  let port: NativeCommitEventsService;
  const nativeWindow = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  beforeEach(async () => {
    nativeWindow.__TAURI_INTERNALS__ = {};
    nativeWindow.__TAURI__ = { core: { invoke: vi.fn(async () => null) } };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideWebdbService()],
    });
    storage = TestBed.inject(WebdbService);
    port = TestBed.inject(NativeCommitEventsService);
    await storage.openExistingForUser('42');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    delete nativeWindow.__TAURI_INTERNALS__;
    delete nativeWindow.__TAURI__;
  });

  const cases = [
    [
      'LOCAL_MESSAGE_DB_COMMITTED',
      'messageDbCommitted$',
      { userId: 42, threadId: 9 },
    ],
    [
      'LOCAL_THREAD_FEED_COMMITTED',
      'threadFeedCommitted$',
      { userId: 42, states: [] },
    ],
    ['LOCAL_STATE_FEED_COMMITTED', 'stateFeedCommitted$', { userId: 42 }],
    [
      'LOCAL_GROUP_META_COMMITTED',
      'groupMetaCommitted$',
      { userId: 42, threadIds: [9], patches: [] },
    ],
    [
      'LOCAL_TOMBSTONE_COMMITTED',
      'tombstoneCommitted$',
      { userId: 42, threadId: 9, tombstones: [] },
    ],
  ] as const;

  it.each(cases)(
    'maps %s once and rejects other users and invalidated accounts',
    (event, channel, data) => {
      const received = vi.fn();
      (storage[channel] as Observable<unknown>).subscribe(received);
      const publish = (payload: unknown) =>
        port.publish({ event, status: 0, message: '', data: payload });
      publish({ ...data, userId: 43 });
      expect(received).not.toHaveBeenCalled();
      publish(data);
      expect(received).toHaveBeenCalledOnce();
      TestBed.inject(SessionLifecycleService).invalidateSession();
      publish(data);
      expect(received).toHaveBeenCalledOnce();
    },
  );

  it('does not relay server business events or replay completions into a new account', async () => {
    const received = vi.fn();
    port.publish({
      event: 'LOCAL_STATE_FEED_COMMITTED',
      status: 0,
      message: '',
      data: { userId: 42 },
    });
    port.committed$.subscribe(received);
    expect(received).not.toHaveBeenCalled();
    port.publish({
      event: 'HELLO',
      status: 0,
      message: '',
      data: { userId: 42 },
    });
    expect(received).not.toHaveBeenCalled();
    const states = vi.fn();
    storage.stateFeedCommitted$.subscribe(states);
    await storage.close();
    port.publish({
      event: 'LOCAL_STATE_FEED_COMMITTED',
      status: 0,
      message: '',
      data: { userId: 42 },
    });
    expect(states).not.toHaveBeenCalled();
    await storage.openExistingForUser('43');
    port.publish({
      event: 'LOCAL_STATE_FEED_COMMITTED',
      status: 0,
      message: '',
      data: { userId: 42 },
    });
    expect(states).not.toHaveBeenCalled();
  });
});
