import { APP_INITIALIZER, ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appConfig } from '../app.config';
import { AuthService } from './auth.service';
import { WebdbService } from './webdb.service';
import { TauriWebdbStorage } from './tauri-webdb-storage';
import { SseLifecycleService } from './sse-lifecycle.service';
import { WebsocketService } from './websocket.service';
import { SessionStateService } from './session-state.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { parseLoginSessionId } from './session/session-identity';
import { UserService } from './user.service';
import { ThreadRepository } from './thread-store.service';

/** Exercise the production provider graph, not individually mocked services. Only native IPC is fake. */
describe.each(['browser', 'desktop', 'android'] as const)(
  '%s session bootstrap provider graph',
  (platform) => {
    const originalAgent = navigator.userAgent;

    beforeEach(() => {
      if (platform === 'browser') {
        TestBed.configureTestingModule({ providers: appConfig.providers });
        return;
      }
      if (platform === 'android') {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
          `${originalAgent} Android`,
        );
        vi.stubGlobal('SomsFcm', {
          getSessionToken: () => null,
          pickActiveOrigin: () => 'http://localhost:3101',
        });
      }
      vi.stubGlobal('__TAURI_INTERNALS__', {});
      vi.stubGlobal('__TAURI__', {
        core: {
          invoke: vi.fn(async (command: string) => {
            if (command === 'get_api_origin') return 'http://localhost:3101';
            if (command === 'is_origin_configured') return false;
            if (command === 'native_db_read_account_state') {
              return {
                schemaVersion: 1,
                selfProfile: null,
                selfIdentity: null,
                composerDrafts: [],
                threadFeedCursor: null,
                stateFeedId: null,
                stateFeedFullThrough: null,
                profileNamespaceChangeEndId: null,
                intentRequestEndId: null,
                intentRequestReadId: null,
                intentRequestOptimisticReadId: null,
              };
            }
            if (
              command === 'native_db_threads' ||
              command === 'native_db_thread_states'
            )
              return [];
            return null;
          }),
        },
      });
      TestBed.configureTestingModule({ providers: appConfig.providers });
    });

    afterEach(() => {
      TestBed.resetTestingModule();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('constructs auth first and completes the real initializer without a DI cycle', async () => {
      const auth = TestBed.inject(AuthService);
      expect(TestBed.inject(WebdbService) instanceof TauriWebdbStorage).toBe(
        platform !== 'browser',
      );
      expect(TestBed.inject(SseLifecycleService)).toBeDefined();
      const init = TestBed.inject(ApplicationInitStatus);
      await init.donePromise;
      expect(init.done).toBe(true);
      expect(auth.loggedIn()).toBe(false);
    });

    if (platform === 'android') {
      it('receives synchronous cached HELLO after login before any home route mounts', async () => {
        const init = TestBed.inject(ApplicationInitStatus);
        await init.donePromise;
        const storage = TestBed.inject(WebdbService);
        const establish = vi
          .spyOn(TestBed.inject(UserService), 'establishSession')
          .mockImplementation(async () => {
            await storage.openExistingForUser('42');
          });
        const loginSessionId = parseLoginSessionId(
          'd91f007f-10c4-410f-a837-65ba4edff6b5',
        );
        TestBed.inject(SessionLifecycleService).bindSession(loginSessionId);
        vi.stubGlobal('SomsFcm', {
          getSessionToken: () => null,
          getConnState: () => 'open',
          replayHello: () =>
            window.__SOMS_EVENT__?.({
              event: 'HELLO',
              status: 0,
              message: 'retained hello',
              loginSessionId,
              data: {
                userId: 42,
                sessionId: 1,
                stateFeedEndId: 0,
                threadFeedEndId: 0,
              },
            }),
        });
        TestBed.inject(SessionStateService).setAuthenticated(true);
        TestBed.tick();
        expect(establish).toHaveBeenCalledWith(42, 0, 1);
        await vi.waitFor(() =>
          expect(TestBed.inject(ThreadRepository).navigationReady()).toBe(true),
        );
      });
    }

    it('constructs storage first without depending on auth or transport', () => {
      TestBed.overrideProvider(APP_INITIALIZER, { useValue: [] });
      expect(TestBed.inject(WebdbService)).toBeDefined();
      expect(TestBed.inject(AuthService)).toBeDefined();
    });

    it('constructs transport first without depending on auth orchestration', () => {
      TestBed.overrideProvider(APP_INITIALIZER, { useValue: [] });
      const realtime = TestBed.inject(WebsocketService);
      expect(realtime.state()).toBe('closed');
      expect(TestBed.inject(AuthService)).toBeDefined();
      expect(TestBed.inject(SseLifecycleService)).toBeDefined();
    });
  },
);
