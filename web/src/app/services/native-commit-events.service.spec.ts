import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { NativeCommitEventsService } from './native-commit-events.service';
import { NativeEventTransport } from './native-event.transport';
import { SessionLifecycleService } from './session-lifecycle.service';
import { parseLoginSessionId } from './session/session-identity';
import { WebdbService, provideWebdbService } from './webdb.service';

const originalId = parseLoginSessionId('11111111-1111-4111-8111-111111111111');
const successorId = parseLoginSessionId('22222222-2222-4222-8222-222222222222');

/** Native IPC completions are a storage port, not an eager realtime/auth dependency. */
describe('native database completion port', () => {
  let storage: WebdbService;
  let port: NativeCommitEventsService;
  let lifecycle: SessionLifecycleService;

  beforeEach(async () => {
    Reflect.set(window, '__TAURI_INTERNALS__', {});
    Reflect.set(window, '__TAURI__', {
      core: { invoke: vi.fn(async () => null) },
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideWebdbService()],
    });
    lifecycle = TestBed.inject(SessionLifecycleService);
    // Mirror the UUID admitted by the mocked native authority.
    lifecycle.bindSession(originalId);
    storage = TestBed.inject(WebdbService);
    port = TestBed.inject(NativeCommitEventsService);
    await storage.openExistingForUser('42');
  });

  afterEach(() => {
    window.__SOMS_EVENT__ = undefined;
    window.__SOMS_CONN_STATE__ = undefined;
    window.__SOMS_RECONNECT_IN__ = undefined;
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    Reflect.deleteProperty(window, '__TAURI__');
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
    'maps %s once and rejects other users and ended logins',
    (event, channel, data) => {
      const received = vi.fn();
      (storage[channel] as Observable<unknown>).subscribe(received);
      const publish = (payload: unknown) =>
        port.publish({
          event,
          status: 0,
          message: '',
          data: payload,
          loginSessionId: originalId,
        });
      publish({ ...data, userId: 43 });
      expect(received).not.toHaveBeenCalled();
      publish(data);
      expect(received).toHaveBeenCalledOnce();
      lifecycle.invalidateSession();
      publish(data);
      expect(received).toHaveBeenCalledOnce();
    },
  );

  it.each(cases)(
    'rejects missing UUID and queued old %s after same-user fresh login',
    async (event, channel, data) => {
      lifecycle.bindSession(successorId);
      await storage.openExistingForUser('42');
      const received = vi.fn();
      (storage[channel] as Observable<unknown>).subscribe(received);
      const message = { event, status: 0, message: '', data };
      port.publish(message);
      port.publish({ ...message, loginSessionId: originalId });
      expect(received).not.toHaveBeenCalled();
      port.publish({ ...message, loginSessionId: successorId });
      expect(received).toHaveBeenCalledOnce();
    },
  );

  it.each(cases)(
    'delivers Android %s envelopes to storage without admitting an old same-user login',
    async (event, channel, data) => {
      lifecycle.bindSession(successorId);
      await storage.openExistingForUser('42');
      const received = vi.fn();
      (storage[channel] as Observable<unknown>).subscribe(received);
      vi.stubGlobal('SomsFcm', { getConnState: () => 'closed' });
      const transport = new NativeEventTransport(
        {
          onEvent: (message) => port.publish(message),
          onState: vi.fn(),
          onReconnect: vi.fn(),
          onForceLogout: vi.fn(),
          onReconnectIn: vi.fn(),
        },
        successorId,
      );
      transport.start();
      const queued = {
        event,
        status: 0,
        message: 'native completion',
        data,
        loginSessionId: originalId,
      };
      window.__SOMS_EVENT__?.(queued);
      expect(received).not.toHaveBeenCalled();
      window.__SOMS_EVENT__?.({ ...queued, loginSessionId: successorId });
      expect(received).toHaveBeenCalledOnce();
      transport.stop();
    },
  );

  it('does not relay server business events or replay completions into a new account', async () => {
    const message = {
      event: 'LOCAL_STATE_FEED_COMMITTED',
      status: 0,
      message: '',
      loginSessionId: originalId,
      data: { userId: 42 },
    };
    const received = vi.fn();
    port.publish(message);
    port.committed$.subscribe(received);
    expect(received).not.toHaveBeenCalled();
    port.publish({ ...message, event: 'HELLO' });
    expect(received).not.toHaveBeenCalled();
    const states = vi.fn();
    storage.stateFeedCommitted$.subscribe(states);
    await storage.close();
    port.publish(message);
    expect(states).not.toHaveBeenCalled();
    await storage.openExistingForUser('43');
    port.publish(message);
    expect(states).not.toHaveBeenCalled();
  });
});
