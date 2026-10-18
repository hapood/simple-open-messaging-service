import '@angular/compiler';
import 'fake-indexeddb/auto';
import { Injector, runInInjectionContext } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth.service';
import {
  BROWSER_SESSION,
  BrowserSessionService,
} from '../browser-session.service';
import { PreferenceStore } from '../preference-store.service';
import { SessionLifecycleService } from '../session-lifecycle.service';
import { SessionStateService } from '../session-state.service';
import { WebdbStorage } from '../webdb-storage';

class Preferences {
  values = new Map<string, unknown>();
  async getStrict<T>(scope: string, key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(`${scope}:${key}`)) as T | undefined;
  }
  get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.getStrict(scope, key);
  }
  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}:${key}`, structuredClone(value));
  }
  async remove(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }
}

type Request = {
  url: string;
  body: unknown;
  aborted: boolean;
  flush(value: unknown): void;
  fail(): void;
};
const databases: WebdbStorage[] = [];

function client(preferences = new Preferences(), provideBrowserSession = true) {
  const database = new WebdbStorage();
  databases.push(database);
  const lifecycle = new SessionLifecycleService();
  const state = new SessionStateService();
  const user = {
    sessionProfile: () => undefined,
    resetSessionState: vi.fn(),
    clearSession: vi.fn(() => {
      throw new Error('Duplicate legacy cleanup');
    }),
    prepareFreshCache: vi.fn(() => {
      throw new Error('Duplicate invalidation');
    }),
    clearSessionPreferences: vi.fn(async () =>
      preferences.remove('device', 'soms.lastUserId'),
    ),
    restoreWebdb: vi.fn(async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error('Obsolete restoration');
      const id = await preferences.getStrict<number>(
        'device',
        'soms.lastUserId',
      );
      if (id) await database.openExistingForUser(String(id));
    }),
  };
  const owner = new BrowserSessionService(
    preferences as PreferenceStore,
    database,
    user as never,
    lifecycle,
    state,
  );
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
  const route = { redirect: vi.fn() };
  const toast = { warn: vi.fn(), info: vi.fn() };
  const injector = Injector.create({
    providers: [
      { provide: SessionStateService, useValue: state },
      {
        provide: BROWSER_SESSION,
        useValue: provideBrowserSession ? owner : null,
      },
    ],
  });
  const auth = runInInjectionContext(
    injector,
    () =>
      new AuthService(
        http as never,
        route as never,
        { onLogin: vi.fn() } as never,
        { onLogin: vi.fn() } as never,
        user as never,
        { translate: (key: string) => key } as never,
        toast as never,
        { clear: vi.fn() } as never,
      ),
  );
  return { auth, owner, preferences, requests, user, database, state, toast };
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
  return app.owner.currentSession!;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) await database.close();
  for (const { name } of await indexedDB.databases()) {
    if (name?.startsWith('soms-session-')) {
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
      await app.auth.restoreSession();
      expect(invoke).toHaveBeenCalledWith('init_pick_origin', undefined);
      expect(invoke).toHaveBeenCalledWith('secure_get_token', undefined);
      expect(app.user.resetSessionState).not.toHaveBeenCalled();
      expect(app.requests).toHaveLength(0);
    } finally {
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
    }
  });

  it('activates UUID caches and does not call the legacy cleanup or invalidation path', async () => {
    const app = client();
    const session = await signIn(app);
    expect(app.auth.isLoggedIn()).toBe(true);
    expect(app.auth.loggedIn()).toBe(true);
    const names = (await indexedDB.databases()).map((item) => item.name);
    expect(names).toContain(session.indexedDbName);
    expect(names).toContain(session.messageIndexedDbName);
    expect(app.user.clearSession).not.toHaveBeenCalled();
    expect(app.user.prepareFreshCache).not.toHaveBeenCalled();
    expect(app.requests[0].body).toMatchObject({
      account: 'alice',
      client: 'web',
    });
  });

  it('keeps old databases at logout and deletes them before the next login POST', async () => {
    const app = client();
    const previous = await signIn(app);
    const exited = firstValueFrom(app.auth.logout());
    expect(app.auth.isLoggedIn()).toBe(false);
    await vi.waitFor(() => expect(app.requests.length).toBe(2));
    expect(app.requests[1].url).toMatch(/\/auth\/logout$/);
    app.requests[1].fail();
    await exited;
    expect((await indexedDB.databases()).map((item) => item.name)).toContain(
      previous.indexedDbName,
    );
    const signingIn = firstValueFrom(
      app.auth.login({ account: 'alice', password: 'pw' }),
    );
    await vi.waitFor(() => expect(app.requests.length).toBe(3));
    expect(
      (await indexedDB.databases()).map((item) => item.name),
    ).not.toContain(previous.indexedDbName);
    document.cookie = 'logged_in=1; Path=/';
    app.requests[2].flush({ code: 0, data: { session_token: 'new-token' } });
    await signingIn;
    expect(app.owner.currentSession?.id).not.toBe(previous.id);
    expect(
      app.requests.filter((item) => /\/auth\/logout$/.test(item.url)),
    ).toHaveLength(1);
  });

  it('blocks authentication on a cache deletion conflict and supports retry', async () => {
    const app = client();
    const previous = await signIn(app);
    await app.auth.clearToken();
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(previous.indexedDbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const pending = firstValueFrom(
        app.auth.login({ account: 'alice', password: 'pw' }),
      );
      await expect(pending).rejects.toThrow(
        'Close other cache connections and retry',
      );
      expect(app.requests).toHaveLength(1);
      expect(app.owner.currentSession).toBeNull();
    } finally {
      blocker.close();
    }
    const successor = await signIn(app);
    expect(successor.id).not.toBe(previous.id);
    expect(app.requests).toHaveLength(2);
  });

  it('restores the same UUID and databases after renderer recreation', async () => {
    const original = client();
    const session = await signIn(original);
    await original.preferences.set('device', 'soms.lastUserId', 1);
    const restored = client(original.preferences);
    await restored.auth.restoreSession();
    expect(restored.owner.currentSession).toEqual(session);
    expect(restored.auth.isLoggedIn()).toBe(true);
    expect(restored.requests).toHaveLength(0);
    expect(restored.database.ready()).toBe(true);
  });

  it('does not restore an ended UUID from a residual cookie and does not delete it at boot', async () => {
    const original = client();
    const session = await signIn(original);
    await original.auth.clearToken();
    document.cookie = 'logged_in=1; Path=/';
    const restored = client(original.preferences);
    await restored.auth.restoreSession();
    expect(restored.owner.currentSession).toBeNull();
    expect(restored.auth.isLoggedIn()).toBe(false);
    expect(restored.requests).toHaveLength(0);
    expect((await indexedDB.databases()).map((item) => item.name)).toContain(
      session.indexedDbName,
    );
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
    expect(app.owner.currentSession).toBeNull();
  });
});
