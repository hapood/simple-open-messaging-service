import {
  SessionSupersededError,
  type LoginSessionId,
} from './session-identity';

export interface LoginWorkScope {
  readonly sessionId: LoginSessionId | null;
  readonly signal: AbortSignal;
}

/** One immutable runtime admission boundary. Persistence and login transitions belong to the owner. */
export class LoginConnection {
  private readonly cancellation = new AbortController();
  private readonly scope: LoginWorkScope;
  private accountId: string | null = null;

  constructor(readonly id: LoginSessionId | null) {
    this.scope = Object.freeze({
      sessionId: id,
      signal: this.cancellation.signal,
    });
  }

  bindAccount(userId: string): void {
    this.assertCurrent(this.scope);
    if (!/^[1-9][0-9]*$/.test(userId)) throw new Error('Invalid login account');
    if (this.accountId !== null && this.accountId !== userId) {
      throw new SessionSupersededError();
    }
    this.accountId = userId;
  }

  assertAccount(userId: string): void {
    this.assertCurrent(this.scope);
    if (this.accountId !== userId) throw new SessionSupersededError();
  }

  capture(): LoginWorkScope {
    return this.scope;
  }

  isCurrent(scope: LoginWorkScope): boolean {
    return scope === this.scope && !this.cancellation.signal.aborted;
  }

  assertCurrent(scope: LoginWorkScope): void {
    if (!this.isCurrent(scope)) throw new SessionSupersededError();
  }

  end(): void {
    this.cancellation.abort();
  }
}
