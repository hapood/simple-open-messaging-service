import { Injectable, InjectionToken, OnDestroy } from '@angular/core';
import { SessionSupersededError } from './session/session-identity';

/** Full document replacement, not Angular navigation: root data services must be recreated. */
export const RESTART_APP_DOCUMENT = new InjectionToken<() => void>(
  'RESTART_APP_DOCUMENT',
  {
    providedIn: 'root',
    factory: () => () => window.location.reload(),
  },
);

/**
 * One renderer may admit at most one login. This is a one-shot data lifetime, not
 * an authentication authority: browser ownership and Rust still admit credentials
 * and own durable cleanup. A stopped renderer can only become usable by restarting.
 */
@Injectable({ providedIn: 'root' })
export class AppDataLifetime implements OnDestroy {
  private controller = new AbortController();
  private readonly terminal = new AbortController();
  /** Stable from construction through teardown; repositories use only this signal. */
  readonly signal = this.terminal.signal;
  private admitted = false;
  private stopped = false;
  private restartRequested = false;

  /** Cancellable bootstrap preparation; fixed after the single app admission. */
  get workSignal(): AbortSignal {
    return this.controller.signal;
  }

  isCurrent(signal: AbortSignal): boolean {
    return (
      signal === this.workSignal && !signal.aborted && !this.signal.aborted
    );
  }

  assertActive(): void {
    if (this.signal.aborted) throw new SessionSupersededError();
  }

  /** Check before any fresh-login preparation or cookie/credential mutation. */
  assertCanAuthenticate(): void {
    this.assertActive();
    if (this.admitted) throw new SessionSupersededError();
  }

  /** Called only by the host adapter after its authority admits the first login. */
  admit(): void {
    this.assertCanAuthenticate();
    this.admitted = true;
    // Retire unauthenticated preparation (including native transports created at
    // bootstrap). The admitted data runtime has exactly one work signal thereafter.
    const previous = this.controller;
    this.controller = new AbortController();
    previous.abort();
  }

  /**
   * Cancel startup/sign-in preparation without retiring an unused runtime. Once
   * admitted, invalidation always ends the app: there is no successor work lease.
   */
  invalidateWork(): void {
    if (this.admitted || this.stopped) {
      this.end();
      return;
    }
    const previous = this.controller;
    this.controller = new AbortController();
    previous.abort();
  }

  /** Synchronous and irreversible; late data work must observe this signal. */
  end(): void {
    this.stopped = true;
    this.terminal.abort();
    this.controller.abort();
  }

  ngOnDestroy(): void {
    this.end();
  }

  /** Cleanup must complete before this is called. Failure leaves the renderer closed. */
  restart(replaceDocument: () => void): void {
    this.end();
    if (this.restartRequested) return;
    replaceDocument();
    this.restartRequested = true;
  }
}
