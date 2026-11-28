import { DestroyRef, Injectable, InjectionToken, inject } from '@angular/core';
import { BrowserSessionOwner } from './session/browser-session-owner';
import { SessionStore } from './session/session-store';
import { deleteBrowserSessionCache } from './session/browser-session-cache';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionStateService } from './session-state.service';
import { isTauri } from './runtime';
import { resetNotificationSince } from './browser-notification-checkpoint';
import { SessionStartupService } from './session-startup.service';
import { withNotificationRestoration } from './notification-session';
import { AppDataLifetime } from './app-data-lifetime.service';

/** Browser host adapter; no duplicate lifecycle or physical cleanup in UserService. */
@Injectable({ providedIn: 'root' })
export class BrowserSessionService extends BrowserSessionOwner {
  private readonly startup = inject(SessionStartupService);
  private readonly lifetime = new AbortController();
  private readonly destroyRef = inject(DestroyRef);
  constructor(
    database: WebdbService,
    user: UserService,
    lifecycle: SessionLifecycleService,
    state: SessionStateService,
  ) {
    const appData = inject(AppDataLifetime);
    super(
      new SessionStore(),
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
        prepareFreshCache: resetNotificationSince,
        resetState: () => {
          user.resetSessionState();
        },
      },
      () => {
        state.setAuthenticated(false);
        lifecycle.invalidateSession();
      },
      (session) => lifecycle.publishIdentity(session.id),
      { primary: location.origin, secondary: null },
      () => appData.assertCanAuthenticate(),
    );
    this.destroyRef.onDestroy(() => this.lifetime.abort());
  }

  protected override withRestoration<T>(
    restore: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return withNotificationRestoration(
      restore,
      AbortSignal.any([signal, this.lifetime.signal]),
      (delay, retry) => this.startup.offerRetry(delay, retry),
    );
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
