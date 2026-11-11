import { DestroyRef, Injectable, InjectionToken, inject } from '@angular/core';
import { BrowserSessionOwner } from './session/browser-session-owner';
import { SessionStore } from './session/session-store';
import { deleteBrowserSessionCache } from './session/browser-session-cache';
import { PreferenceStore } from './preference-store.service';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionStateService } from './session-state.service';
import { isTauri } from './runtime';
import { resetNotificationSince } from './browser-notification-checkpoint';
import { SessionStartupService } from './session-startup.service';
import { withNotificationRestoration } from './notification-session';

/** Browser host adapter; no duplicate lifecycle or physical cleanup in UserService. */
@Injectable({ providedIn: 'root' })
export class BrowserSessionService extends BrowserSessionOwner {
  private readonly startup = inject(SessionStartupService);
  private readonly lifetime = new AbortController();
  private readonly destroyRef = inject(DestroyRef);
  constructor(
    preferences: PreferenceStore,
    database: WebdbService,
    user: UserService,
    lifecycle: SessionLifecycleService,
    state: SessionStateService,
  ) {
    let previousUserId: number | undefined;
    super(
      new SessionStore(preferences),
      {
        close: () => database.close(),
        initialize: async (session) => {
          database.bindSessionCache(session);
          await database.initializeSessionCache();
        },
        restore: async (session, signal) => {
          database.bindSessionCache(session);
          await user.restoreWebdb(signal);
        },
        delete: deleteBrowserSessionCache,
        prepareFreshCache: async () => {
          await resetNotificationSince();
          await user.clearSessionPreferences(previousUserId);
          previousUserId = undefined;
        },
        resetState: () => {
          previousUserId = user.sessionProfile()?.id ?? previousUserId;
          user.resetSessionState();
        },
      },
      () => {
        state.setAuthenticated(false);
        lifecycle.invalidateSession();
      },
      (session) => lifecycle.bindSession(session.id),
    );
    this.destroyRef.onDestroy(() => this.lifetime.abort());
  }

  protected override withRestoration<T>(restore: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return withNotificationRestoration(restore, AbortSignal.any([signal, this.lifetime.signal]), (delay, retry) => this.startup.offerRetry(delay, retry));
  }
}

/** Native session ownership stays in Rust; never construct a browser authority there. */
export const BROWSER_SESSION = new InjectionToken<BrowserSessionService | null>(
  'BROWSER_SESSION',
  {
    providedIn: 'root',
    factory: () => (isTauri() ? null : inject(BrowserSessionService)),
  },
);
