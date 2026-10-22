import { Injectable, signal } from '@angular/core';
import { isTauri } from './runtime';

/** Public presence flag only; the actual browser credential remains httpOnly. */
const SESSION_PRESENCE_COOKIE = 'logged_in';

/** Credential-free session state. Infrastructure reads this without constructing auth/UI services. */
@Injectable({ providedIn: 'root' })
export class SessionStateService {
  private readonly authenticated = signal(
    isTauri() ? false : this.hasPresenceCookie(),
  );
  readonly loggedIn = this.authenticated.asReadonly();
  private blocked = false;

  /** Auth orchestration publishes only after credential restoration/login or local teardown. */
  setAuthenticated(value: boolean): void {
    this.blocked = !value;
    this.authenticated.set(value);
  }

  isLoggedIn(): boolean {
    return isTauri()
      ? this.loggedIn()
      : !this.blocked && this.hasPresenceCookie();
  }

  /** Credential hint only. A durable logout record can still prohibit restoration. */
  hasBrowserSessionHint(): boolean {
    return this.hasPresenceCookie();
  }

  /** Expiry can clear the readable browser flag before the server clears its httpOnly credential. */
  clearPresenceCookie(): void {
    if (typeof document !== 'undefined')
      document.cookie = `${SESSION_PRESENCE_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
  }

  private hasPresenceCookie(): boolean {
    return (
      typeof document !== 'undefined' &&
      document.cookie
        .split(';')
        .some((cookie) =>
          cookie.trim().startsWith(`${SESSION_PRESENCE_COOKIE}=`),
        )
    );
  }
}
