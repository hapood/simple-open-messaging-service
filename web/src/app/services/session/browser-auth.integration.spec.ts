import '@angular/compiler';
import { LogoutDecisionService } from '../logout-decision.service';
import {
  type DestroyableInjector,
  Injector,
  inject,
  runInInjectionContext,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth.service';
import { AppDataLifetime, RESTART_APP_DOCUMENT } from '../app-data-lifetime.service';
import { UserService } from '../user.service';
import {
  BROWSER_SESSION,
  BrowserSessionService,
} from '../browser-session.service';
import { PreferenceStore } from '../preference-store.service';
import { SessionLifecycleService } from '../session-lifecycle.service';
import { SessionStateService } from '../session-state.service';
import { SessionStartupService } from '../session-startup.service';
import { registrationDouble } from '../service-worker-test-doubles';
import { ServerConfigDialogService } from '../server-config-dialog.service';
import { WebdbStorage } from '../webdb-storage';
import {
  advanceNotificationSince,
  readNotificationSince,
} from '../browser-notification-checkpoint';
import {
  parseLoginSessionId,
  SessionSupersededError,
} from './session-identity';

type Request = {
  url: string;
  body: unknown;
  aborted: boolean;
  flush(value: unknown): void;
  fail(): void;
};
const databases: WebdbStorage[] = [];
const preferenceStores: PreferenceStore[] = [];
const injectors = new Set<DestroyableInjector>();

function client(
  preferences = new PreferenceStore(),
  provideBrowserSession = true,
) {
  const database = new WebdbStorage();
  databases.push(database);
  preferenceStores.push(preferences);
  const appData = new AppDataLifetime();
  const lifecycle = new SessionLifecycleService(appData);
  const state = new SessionStateService();
  const user = {
    sessionProfile: () => undefined,
    resetSessionState: vi.fn(),
    releaseSession: vi.fn<() => Promise<void>>(() => {
      throw new Error('Native release is forbidden on the browser');
    }),
    prepareFreshCache: vi.fn(() => {
      throw new Error('Duplicate invalidation');
    }),
    restoreWebdb: vi.fn(async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error('Obsolete restoration');
      await database.openExistingForUser('1');
    }),
  };
  const requests: Request[] = [];
  const http = {
    post: (url: string, body: unknown) =>
      new Observable((subscriber) => {
        let finished = false;
        const request: Request = {
          url,
          body,
          aborted: false,
          flush: (value) => {
            finished = true;
            subscriber.next(value);
            subscriber.complete();
          },
          fail: () => {
            finished = true;
            subscriber.error(new HttpErrorResponse({ status: 0 }));
          },
        };
        requests.push(request);
        return () => {
          if (!finished) request.aborted = true;
        };
      }),
  };
  const toast = { warn: vi.fn(), info: vi.fn() };
  const injector = Injector.create({
    providers: [
      ServerConfigDialogService,
      SessionStartupService,
      { provide: AppDataLifetime, useValue: appData },
      { provide: RESTART_APP_DOCUMENT, useValue: vi.fn() },
      {
        provide: BrowserSessionService,
        useFactory: () =>
          new BrowserSessionService(database, user as never, lifecycle, state),
      },
      {
        provide: LogoutDecisionService,
        useValue: { decide: vi.fn().mockResolvedValue('localOnly') },
      },
      { provide: SessionStateService, useValue: state },
      { provide: SessionLifecycleService, useValue: lifecycle },
      {
        provide: BROWSER_SESSION,
        useFactory: () =>
          provideBrowserSession ? inject(BrowserSessionService) : null,
      },
    ],
  });
  injectors.add(injector);
  const owner = injector.get(BROWSER_SESSION);
  const auth = runInInjectionContext(
    injector,
    () =>
      new AuthService(
        http as never,
        { onLogin: vi.fn() } as never,
        {
          onLogin: vi.fn(),
          unsubscribe: vi.fn().mockResolvedValue(undefined),
        } as never,
        user as never,
        { translate: (key: string) => key } as never,
        toast as never,
      ),
  );
  return {
    auth,
    owner,
    preferences,
    requests,
    user,
    database,
    state,
    toast,
    lifecycle,
    appData: injector.get(AppDataLifetime),
    restart: injector.get(RESTART_APP_DOCUMENT),
    startup: injector.get(SessionStartupService),
    destroy: () => {
      if (injectors.delete(injector)) injector.destroy();
    },
  };
}

async function signIn(app: ReturnType<typeof client>) {
  const count = app.requests.length;
  const done = firstValueFrom(
    app.auth.login({ account: 'alice', password: 'pw' }),
  );
  await vi.waitFor(() => expect(app.requests.length).toBe(count + 1));
  const request = app.requests[count];
  expect(request.url).toMatch(/\/auth\/login$/);
  document.cookie = 'logged_in=1; Path=/';
  request.flush({ code: 0, data: { session_token: 'never-persisted-in-js' } });
  await done;
  expect(app.lifecycle.capture().sessionId).toBe(app.owner!.currentSession?.id);
  expect(app.lifecycle.capture().signal.aborted).toBe(false);
  return app.owner!.currentSession!;
}

afterEach(async () => {
  for (const injector of injectors) injector.destroy();
  injectors.clear();
  vi.useRealTimers();
  for (const database of databases.splice(0)) await database.close();
  // Real preference stores hold open connections; close them before deleting the database,
  // otherwise deleteDatabase blocks forever on the open handle.
  for (const store of preferenceStores.splice(0)) await store.close();
  // Delete the fixed login cache and app-state/settings database to isolate login lifetimes.
  const created = (name: string) =>
    name.startsWith('soms-session') || name === 'soms-client-preferences';
  for (const { name } of await indexedDB.databases()) {
    if (name && created(name)) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }
  document.cookie = 'logged_in=; Max-Age=0; Path=/';
});

describe('browser AuthService with real session owner and IndexedDB caches', () => {
  it('fails browser configuration explicitly instead of falling back to the native path', () => {
    const app = client(undefined, false);
    expect(app.owner).toBeNull();
    expect(() => app.auth.login({ account: 'alice', password: 'pw' })).toThrow(
      'Browser session service is missing on the browser host',
    );
    expect(app.requests).toHaveLength(0);
  });

  it('selects the native restore path by Tauri detection without a browser service', async () => {
    window.__TAURI_INTERNALS__ = {};
    const invoke = vi.fn(async (command: string) =>
      command === 'init_pick_origin' ? 'https://chat.test' : null,
    );
    window.__TAURI__ = { core: { invoke } };
    try {
      const app = client(undefined, false);
      expect(app.owner).toBeNull();
      await app.auth.restoreSession();
      expect(invoke).toHaveBeenCalledWith('init_pick_origin', undefined);
      expect(invoke).toHaveBeenCalledWith('secure_get_login', undefined);
      expect(app.user.resetSessionState).not.toHaveBeenCalled();
      expect(app.requests).toHaveLength(0);
    } finally {
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
    }
  });

  it('activates UUID caches without duplicate invalidation', async () => {
    const app = client();
    const session = await signIn(app);
    expect(app.auth.isLoggedIn()).toBe(true);
    expect(app.auth.loggedIn()).toBe(true);
    const names = (await indexedDB.databases()).map((item) => item.name);
    expect(names).toContain(session.indexedDbName);
    expect(app.user.prepareFreshCache).not.toHaveBeenCalled();
    expect(app.requests[0].body).toMatchObject({
      account: 'alice',
      client: 'web',
    });
  });

  it('rejects direct browser-owner replacement before cookie mutation or cache cleanup', async () => {
    const app = client();
    const original = await signIn(app);
    const mutation = vi.fn();
    await expect(app.owner!.authenticate(mutation)).rejects.toBeInstanceOf(SessionSupersededError);
    expect(mutation).not.toHaveBeenCalled();
    expect(app.owner!.currentSession?.id).toBe(original.id);
    expect(app.appData.signal.aborted).toBe(false);
  });

  it('forced invalidation cancels immediately and restarts only after cleanup', async () => {
    const app = client();
    await signIn(app);
    let close!: () => void;
    const originalClose = app.database.close.bind(app.database);
    vi.spyOn(app.database, 'close').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { close = resolve; });
      await originalClose();
    });
    app.auth.redoLoginAuth();
    expect(app.appData.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(close).toBeDefined());
    expect(app.restart).not.toHaveBeenCalled();
    await expect(firstValueFrom(app.auth.qrCreate('web'))).rejects.toBeInstanceOf(SessionSupersededError);
    close();
    await vi.waitFor(() => expect(app.restart).toHaveBeenCalledOnce());
  });

  it('resets both notification checkpoints at the browser fresh-login boundary', async () => {
    await advanceNotificationSince(7);
    await advanceNotificationSince(9, 'state');
    const app = client();

    await signIn(app);

    expect(await readNotificationSince()).toBe(0);
    expect(await readNotificationSince('state')).toBe(0);
  });

  it('deletes the fixed cache at logout before the next login POST', async () => {
    const app = client();
    const previous = await signIn(app);
    const exited = firstValueFrom(app.auth.logout());
    expect(app.auth.isLoggedIn()).toBe(false);
    await vi.waitFor(() => expect(app.requests.length).toBe(2));
    expect(app.requests[1].url).toMatch(/\/auth\/logout$/);
    app.requests[1].fail();
    await exited;
    expect(
      (await indexedDB.databases()).map((item) => item.name),
    ).not.toContain(previous.indexedDbName);
    expect(app.appData.signal.aborted).toBe(true);
    expect(app.restart).toHaveBeenCalledOnce();
    await expect(firstValueFrom(
      app.auth.login({ account: 'alice', password: 'pw' }),
    )).rejects.toBeInstanceOf(SessionSupersededError);
    expect(app.requests).toHaveLength(2);
    app.destroy();
    const successor = client();
    await signIn(successor);
    expect(successor.owner!.currentSession?.id).not.toBe(previous.id);
    expect(
      app.requests.filter((item) => /\/auth\/logout$/.test(item.url)),
    ).toHaveLength(1);
  });

  it('waits for blocked deletion before restarting and rejects same-renderer successor login', async () => {
    const app = client();
    const previous = await signIn(app);
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(previous.indexedDbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let blocked!: () => void;
    const deletionRequested = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    blocker.onversionchange = () => blocked();
    const ending = app.auth.clearToken();
    await deletionRequested;
    expect(app.appData.signal.aborted).toBe(true);
    expect(app.restart).not.toHaveBeenCalled();
    await expect(firstValueFrom(
      app.auth.login({ account: 'alice', password: 'pw' }),
    )).rejects.toBeInstanceOf(SessionSupersededError);
    expect(app.requests).toHaveLength(1);
    expect(app.owner!.currentSession).toBeNull();
    blocker.close();
    await ending;
    expect(app.restart).toHaveBeenCalledOnce();
    expect(app.requests).toHaveLength(1);
    app.destroy();
    const successor = client();
    await signIn(successor);
    expect(successor.owner!.currentSession?.id).not.toBe(previous.id);
  });

  it('does not adopt a residual cookie without active app-state or create login caches at boot', async () => {
    const app = client();
    document.cookie = 'logged_in=1; Path=/';
    const before = (await indexedDB.databases()).map(({ name }) => name).sort();
    await app.auth.restoreSession();
    expect(app.auth.isLoggedIn()).toBe(false);
    expect(app.auth.loggedIn()).toBe(false);
    expect(app.owner!.currentSession).toBeNull();
    expect(app.lifecycle.capture().sessionId).toBeNull();
    expect(app.user.restoreWebdb).not.toHaveBeenCalled();
    expect(app.requests).toHaveLength(0);
    const caches = (names: (string | undefined)[]) =>
      names.filter((name) => name?.startsWith('soms-session-')).sort();
    expect(
      caches((await indexedDB.databases()).map(({ name }) => name)),
    ).toEqual(caches(before));
    await signIn(app);
    expect(app.auth.isLoggedIn()).toBe(true);
  });

  it('restores the same UUID and databases after renderer recreation', async () => {
    const original = client();
    const session = await signIn(original);
    await original.database.openForUser('1');
    await original.database.close();
    const restored = client(original.preferences);
    await restored.auth.restoreSession();
    expect(restored.owner!.currentSession).toEqual(session);
    expect(restored.auth.isLoggedIn()).toBe(true);
    expect(restored.requests).toHaveLength(0);
    expect(restored.database.ready()).toBe(true);
  });

  it('does not restore a deleted login from a residual cookie', async () => {
    const original = client();
    const session = await signIn(original);
    await original.auth.clearToken();
    document.cookie = 'logged_in=1; Path=/';
    const restored = client(original.preferences);
    await restored.auth.restoreSession();
    expect(restored.owner!.currentSession).toBeNull();
    expect(restored.auth.isLoggedIn()).toBe(false);
    expect(restored.requests).toHaveLength(0);
    expect(
      (await indexedDB.databases()).map((item) => item.name),
    ).not.toContain(session.indexedDbName);
  });

  it('cancels notification recovery and releases retry timers when its injector is destroyed', async () => {
    const app = client();
    const registration = vi
      .spyOn(navigator.serviceWorker, 'getRegistration')
      .mockResolvedValue(registrationDouble());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    const restoring = app.owner!.restore(true);
    const rejected = expect(restoring).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    // IndexedDB initialization is real asynchronous I/O, not a timer/microtask.
    await vi.waitFor(() => expect(app.startup.retryIn()).toBe(1000));
    expect(registration).toHaveBeenCalledOnce();

    app.destroy();
    await rejected;
    expect(app.startup.retryIn()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    app.startup.retryNow();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(registration).toHaveBeenCalledOnce();
    expect(app.user.restoreWebdb).not.toHaveBeenCalled();
    expect(app.owner!.currentSession).toBeNull();
    expect(app.lifecycle.capture().sessionId).toBeNull();
  });

  it('aborts the actual HTTP observable at logout timeout', async () => {
    const app = client();
    await signIn(app);
    vi.useFakeTimers();
    const exited = firstValueFrom(app.auth.logout());
    await vi.waitFor(() => expect(app.requests.length).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await exited;
    expect(app.requests[1].aborted).toBe(true);
    expect(app.auth.isLoggedIn()).toBe(false);
    expect(app.owner!.currentSession).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native logout adapter integration', () => {
  for (const android of [false, true]) {
    it(`releases without deleting and waits for Rust revocation (${android ? 'Android' : 'desktop'})`, async () => {
      const admission = deferred<void>();
      const remote = deferred<void>();
      const setToken = vi.fn();
      const originalAgent = Object.getOwnPropertyDescriptor(
        navigator,
        'userAgent',
      );
      const invoke = vi.fn(async (command: string) => {
        if (command === 'begin_logout') return admission.promise;
        if (command === 'try_logout') {
          await remote.promise;
          return { status: 'revoked' };
        }
        if (command === 'logout_status') return 'awaitingRevocation';
        return undefined;
      });
      try {
        window.__TAURI_INTERNALS__ = {};
        window.__TAURI__ = { core: { invoke } };
        if (android) {
          Object.defineProperty(navigator, 'userAgent', {
            value: 'Android',
            configurable: true,
          });
          Object.defineProperty(window, 'SomsFcm', {
            value: {
              setSessionToken: setToken,
              clearMessageNotifications: vi.fn(),
            },
            configurable: true,
          });
        }
        const app = client(undefined, false);
        expect(app.owner).toBeNull();
        const loginId = parseLoginSessionId(
          '11111111-2222-4d9e-af01-234567890abc',
        );
        (
          app.auth as unknown as { nativeLoginUuid: typeof loginId }
        ).nativeLoginUuid = loginId;
        app.state.setAuthenticated(true);
        app.user.releaseSession.mockResolvedValue(undefined);
        let finished = false;
        const done = firstValueFrom(app.auth.logout()).then(() => {
          finished = true;
        });
        try {
          expect(app.user.releaseSession).not.toHaveBeenCalled();
          expect(setToken).not.toHaveBeenCalled();
          expect(finished).toBe(false);
          admission.resolve();
          await vi.waitFor(() => {
            expect(invoke).toHaveBeenCalledWith('try_logout', undefined);
          });
          expect(app.user.releaseSession).toHaveBeenCalledTimes(1);
          expect(setToken).not.toHaveBeenCalled();
          expect(invoke).not.toHaveBeenCalledWith('finish_logout', {
            localOnly: false,
          });
          expect(finished).toBe(false);
          remote.resolve();
          await done;
          expect(invoke).toHaveBeenCalledWith('finish_logout', {
            localOnly: false,
          });
          expect(setToken).not.toHaveBeenCalled();
          expect(app.auth.isLoggedIn()).toBe(false);
          expect(app.requests).toHaveLength(0);
          expect(
            invoke.mock.calls.some(([command]) =>
              command.startsWith('native_db_'),
            ),
          ).toBe(false);
        } finally {
          admission.resolve();
          remote.resolve();
          await done;
        }
      } finally {
        delete window.__TAURI_INTERNALS__;
        delete window.__TAURI__;
        delete window.SomsFcm;
        if (originalAgent)
          Object.defineProperty(navigator, 'userAgent', originalAgent);
        else Reflect.deleteProperty(navigator, 'userAgent');
      }
    });
  }

  it('coalesces repeated native logout requests until cleanup completes', async () => {
    const cleanup = deferred<void>();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'logout_status') return 'awaitingRevocation';
      if (command === 'try_logout') return { status: 'revoked' };
      if (command === 'finish_logout') return cleanup.promise;
      return undefined;
    });
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    try {
      const app = client(undefined, false);
      app.state.setAuthenticated(true);
      app.user.releaseSession.mockResolvedValue(undefined);
      const first = firstValueFrom(app.auth.logout());
      const second = firstValueFrom(app.auth.logout());
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('finish_logout', {
          localOnly: false,
        }),
      );
      expect(
        invoke.mock.calls.filter(([command]) => command === 'begin_logout'),
      ).toHaveLength(1);
      expect(app.user.releaseSession).toHaveBeenCalledTimes(1);
      cleanup.resolve();
      await Promise.all([first, second]);
      expect(app.auth.isLoggedIn()).toBe(false);
    } finally {
      cleanup.resolve();
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
    }
  });

  it('retries failed native cleanup without repeating revocation', async () => {
    let cleanupPending = false;
    let cleanupAttempts = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'logout_status')
        return cleanupPending ? 'awaitingCleanup' : 'awaitingRevocation';
      if (command === 'try_logout') {
        cleanupPending = true;
        return { status: 'revoked' };
      }
      if (command === 'finish_logout' && ++cleanupAttempts === 1)
        throw new Error('storage unavailable');
      return undefined;
    });
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    try {
      const app = client(undefined, false);
      app.state.setAuthenticated(true);
      app.user.releaseSession.mockResolvedValue(undefined);
      await expect(firstValueFrom(app.auth.logout())).rejects.toThrow(
        'storage unavailable',
      );
      await firstValueFrom(app.auth.logout());
      expect(
        invoke.mock.calls.filter(([command]) => command === 'try_logout'),
      ).toHaveLength(1);
      expect(cleanupAttempts).toBe(2);
      expect(app.auth.isLoggedIn()).toBe(false);
    } finally {
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
    }
  });

  it('the real release primitive invalidates and closes without touching persistent data', async () => {
    const invalidateSession = vi.fn();
    const resetSessionState = vi.fn();
    const close = vi.fn(async () => {});
    const closeAndDelete = vi.fn();
    const resourceOwner = {
      sessionLifecycle: { invalidateSession },
      resetSessionState,
      webdb: { close, closeAndDelete },
    };
    const releasing = UserService.prototype.releaseSession.call(
      resourceOwner as unknown as UserService,
    );
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    expect(resetSessionState).toHaveBeenCalledTimes(1);
    await releasing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeAndDelete).not.toHaveBeenCalled();
  });
});
