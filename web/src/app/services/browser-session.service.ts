import { Injectable, InjectionToken, inject } from '@angular/core';
import { BrowserSessionOwner } from './session/browser-session-owner';
import { SessionJournal } from './session/session-journal';
import { deleteBrowserSessionCache } from './session/browser-session-cache';
import { PreferenceStore } from './preference-store.service';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionStateService } from './session-state.service';
import { isTauri } from './runtime';
import { resetNotificationSince } from './browser-notification-checkpoint';

/** Browser host adapter; no duplicate lifecycle or physical cleanup in UserService. */
@Injectable({ providedIn: 'root' })
export class BrowserSessionService extends BrowserSessionOwner {
  constructor(
    preferences: PreferenceStore,
    database: WebdbService,
    user: UserService,
    lifecycle: SessionLifecycleService,
    state: SessionStateService,
  ) {
    let previousUserId: number | undefined;
    super(
      new SessionJournal(preferences),
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
