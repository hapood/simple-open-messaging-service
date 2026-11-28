import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { AppDataLifetime } from './app-data-lifetime.service';
import {
  SessionSupersededError,
  type LoginSessionId,
} from './session/session-identity';

/** Protocol identity captured alongside app-owned work cancellation. */
export interface SessionWorkScope {
  readonly sessionId: LoginSessionId | null;
  readonly signal: AbortSignal;
}

/**
 * Compatibility facade for protocol identity and reset notifications. This class
 * owns no work controller: app data lifetime is the sole renderer cancellation
 * owner. Browser ownership and Rust remain the durable admission authorities.
 */
@Injectable({ providedIn: 'root' })
export class SessionLifecycleService {
  private sessionId: LoginSessionId | null = null;
  private scope?: SessionWorkScope;
  private readonly invalidated = new Subject<void>();
  readonly invalidated$ = this.invalidated.asObservable();
  private readonly ended = new Subject<void>();
  readonly ended$ = this.ended.asObservable();

  constructor(
    private readonly appData: AppDataLifetime = new AppDataLifetime(),
  ) {}

  capture(): SessionWorkScope {
    if (
      this.scope?.sessionId !== this.sessionId ||
      this.scope.signal !== this.appData.workSignal
    ) {
      this.scope = Object.freeze({
        sessionId: this.sessionId,
        signal: this.appData.workSignal,
      });
    }
    return this.scope;
  }

  isCurrent(scope: SessionWorkScope): boolean {
    return this.appData.isCurrent(scope.signal);
  }

  /** Resource/IPC callers still carry the captured UUID to their admission authority. */
  assertCurrent(scope: SessionWorkScope): void {
    if (!this.isCurrent(scope)) throw new SessionSupersededError();
  }

  /** Publish the authority's admitted UUID without starting a second work lifetime. */
  publishIdentity(sessionId: LoginSessionId): void {
    if (this.sessionId === sessionId) {
      this.appData.assertActive();
      return;
    }
    this.appData.admit();
    this.sessionId = sessionId;
  }

  /** Compatibility spelling for existing protocol consumers. */
  bindSession(sessionId: LoginSessionId): void {
    this.publishIdentity(sessionId);
  }

  invalidateSession(): void {
    this.sessionId = null;
    this.appData.invalidateWork();
    this.invalidated.next();
  }

  /** In-memory reset notification; physical cleanup belongs to the host authority. */
  endSession(): void {
    this.ended.next();
  }
}
