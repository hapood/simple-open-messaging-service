import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import {
  SessionSupersededError,
  type LoginSessionId,
} from './session/session-identity';

/** A captured work lease, not a second login identity. Null denotes signed-out/public work. */
export interface SessionWorkScope {
  readonly sessionId: LoginSessionId | null;
  readonly signal: AbortSignal;
}

/**
 * Renderer mirror and cancellation boundary. The browser owner or Rust supplies the login UUID;
 * this service never creates identities, restores credentials, or owns durable session decisions.
 */
@Injectable({ providedIn: 'root' })
export class SessionLifecycleService {
  private work = new AbortController();
  private scope: SessionWorkScope = Object.freeze({
    sessionId: null,
    signal: this.work.signal,
  });
  private readonly invalidated = new Subject<void>();
  readonly invalidated$ = this.invalidated.asObservable();
  private readonly ended = new Subject<void>();
  readonly ended$ = this.ended.asObservable();

  /** Capture before scheduling. A successor UUID must never be looked up at completion time. */
  capture(): SessionWorkScope {
    return this.scope;
  }

  isCurrent(scope: SessionWorkScope): boolean {
    return scope === this.scope && !scope.signal.aborted;
  }

  /** Does not replace resource admission locks or native command admission in Rust. */
  assertCurrent(scope: SessionWorkScope): void {
    if (!this.isCurrent(scope)) throw new SessionSupersededError();
  }

  /** Publish an admitted identity from the host authority, without repeating resource cleanup. */
  bindSession(sessionId: LoginSessionId): void {
    if (this.scope.sessionId === sessionId && !this.work.signal.aborted) return;
    this.replaceScope(sessionId);
  }

  /** Invalidate old work synchronously, before waiting for persistence or resource release. */
  invalidateSession(): void {
    this.replaceScope(null);
    this.invalidated.next();
  }

  /** Pure in-memory consumers reset synchronously, independently of physical cache deletion. */
  endSession(): void {
    this.ended.next();
  }

  private replaceScope(sessionId: LoginSessionId | null): void {
    const previous = this.work;
    this.work = new AbortController();
    this.scope = Object.freeze({ sessionId, signal: this.work.signal });
    // Publish the replacement first: synchronous abort listeners must already see the old lease as stale.
    previous.abort();
  }
}
