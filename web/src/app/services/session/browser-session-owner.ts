import {
  createSessionCacheDescriptor,
  SessionSupersededError,
  type SessionCacheDescriptor,
} from './session-identity';
import { completeLogout, type LogoutDecision, type UnconfirmedLogout, type LogoutCompletion } from './logout-operation';
import { classifyLogoutFailure, type LogoutOutcome } from './logout-outcome';
import { SessionStore, type ServerSessionIdentity } from './session-store';

/** Each operation has one owner. resetState must not close resources or invalidate again. */
export interface BrowserSessionResources {
  close(): Promise<void>;
  initialize(session: SessionCacheDescriptor): Promise<void>;
  restore(session: SessionCacheDescriptor, signal: AbortSignal): Promise<void>;
  delete(session: SessionCacheDescriptor): Promise<void>;
  prepareFreshCache(): Promise<void>;
  resetState(): void;
}

/**
 * Browser session authority. Remote revocation is best effort and is never a
 * prerequisite for fresh authentication. The admitted UUID is published to the
 * renderer only after durable activation and resource restoration succeed.
 */
export class BrowserSessionOwner {
  private active: SessionCacheDescriptor | null = null;
  private work = new AbortController();
  private transitions: Promise<unknown> = Promise.resolve();
  private interactiveLogout: Promise<LogoutCompletion> | null = null;
  private authenticationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly resources: BrowserSessionResources,
    private readonly invalidate: () => void,
    private readonly publish: (session: SessionCacheDescriptor) => void,
  ) {}

  bindIdentity(identity: ServerSessionIdentity): Promise<void> {
    const id = this.active?.id;
    const signal = this.work.signal;
    if (!id) return Promise.reject(new SessionSupersededError());
    return this.serializeTransition(async () => {
      this.check(signal);
      if (this.active?.id !== id) throw new SessionSupersededError();
      await this.sessionStore.bindIdentity(id, identity);
      this.check(signal);
    });
  }

  get currentSession(): SessionCacheDescriptor | null {
    return this.active;
  }

  /**
   * Keep cookie-mutating requests serialized even after their UI unsubscribes.
   * Queued duplicate submissions cannot replace a login completed ahead of them.
   * The transport must have a bounded completion/abort policy.
   */
  authenticate<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const expected = this.active?.id ?? null;
    const expectedWork = this.work.signal;
    return this.serializeAuthentication(async () => {
      if (
        (this.active?.id ?? null) !== expected ||
        this.work.signal !== expectedWork
      ) {
        throw new SessionSupersededError();
      }
      const signal = this.beginTransition();
      await this.serializeTransition(() => this.cleanup());
      this.check(signal);
      try {
        const result = await operation(signal);
        this.check(signal);
        return result;
      } catch (error) {
        // A timed-out request may have started asynchronous local preparation.
        if (this.work.signal === signal) this.work.abort();
        throw error;
      }
    });
  }

  /** Authentication callback invokes this only when the server confirmed login. */
  activate(signal: AbortSignal): Promise<void> {
    this.check(signal);
    if (signal !== this.work.signal) throw new SessionSupersededError();
    return this.serializeTransition(async () => {
      this.check(signal);
      const descriptor = createSessionCacheDescriptor();
      await this.sessionStore.prepare(descriptor);
      await this.resources.initialize(descriptor);
      this.check(signal);
      await this.sessionStore.activate(descriptor.id);
      this.check(signal);
      this.active = descriptor;
      this.publish(descriptor);
    });
  }

  /** Hosts enter notification recovery before local restoration and HELLO. */
  protected withRestoration<T>(restore: () => Promise<T>, _signal: AbortSignal): Promise<T> {
    return restore();
  }

  /** Presence cookies cannot authorize restoration without a recoverable durable login record. */
  restore(hasCredential: boolean): Promise<boolean> {
    const signal = this.beginTransition();
    return this.serializeTransition(() => this.withRestoration(async () => {
      this.check(signal);
      const saved = await this.sessionStore.read();
      this.check(signal);
      if (saved?.phase === 'revoking') {
        // An interrupted decision must not reactivate the login or silently discard it.
        await this.resources.close();
        throw new Error('Session revocation requires an explicit decision');
      }
      if (
        !hasCredential ||
        !saved ||
        saved.phase === 'ending' ||
        saved.phase === 'signed-out'
      ) {
        await this.markEndedAndClose();
        return false;
      }
      const descriptor = saved.session;
      if (!descriptor)
        throw new Error('Missing recoverable session descriptor');
      if (saved.phase === 'preparing') {
        await this.resources.initialize(descriptor);
        this.check(signal);
        await this.sessionStore.activate(descriptor.id);
      } else {
        await this.resources.close();
      }
      this.check(signal);
      await this.resources.restore(descriptor, signal);
      this.check(signal);
      this.active = descriptor;
      this.publish(descriptor);
      return true;
    }, signal));
  }

  /** Interactive logout keeps the original durable login until revocation is confirmed
   * or the user explicitly chooses local-only cleanup. Business work is stopped first. */
  logoutWithDecision(
    operation: (signal: AbortSignal) => Promise<void>,
    decide: (outcome: UnconfirmedLogout) => Promise<LogoutDecision>,
    finalizeLocal: () => Promise<void>,
    timeoutMs = 10_000,
  ): Promise<LogoutCompletion> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('Logout timeout must be positive and finite'));
    }
    if (this.interactiveLogout) return this.interactiveLogout;
    const activeId = this.active?.id;
    const signal = this.beginTransition();
    let id = activeId;
    // Hold the authentication lane through the decision: new cookie-mutating
    // requests must not overlap revocation or the original login's final cleanup.
    const pending = this.serializeAuthentication(() => completeLogout({
      stopWork: () => this.serializeTransition(async () => {
        this.check(signal);
        try {
          const saved = await this.sessionStore.read();
          this.check(signal);
          // A renderer recreation or interrupted dialog has no active runtime owner.
          // Resume only the same durable revocation, never infer a login from cookies.
          if (!id && saved?.phase === 'revoking') id = saved.session?.id;
          if (!id) throw new SessionSupersededError();
          await this.sessionStore.beginRevocation(id);
        } finally {
          await this.resources.close();
        }
      }),
      revoke: async () => {
        const deadline = new AbortController();
        const cancel = () => deadline.abort();
        signal.addEventListener('abort', cancel, { once: true });
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<LogoutOutcome>((resolve) => {
          timer = setTimeout(() => {
            deadline.abort();
            resolve({ status: 'timedOut' });
          }, timeoutMs);
        });
        const request = (async (): Promise<LogoutOutcome> => {
          try {
            await operation(deadline.signal);
            return { status: 'revoked' };
          } catch (error) {
            return signal.aborted ? { status: 'superseded' } :
              deadline.signal.aborted ? { status: 'timedOut' } : classifyLogoutFailure(error);
          }
        })();
        try {
          const outcome = await Promise.race([request, expired]);
          // Abort is required to settle the real transport before a user-triggered retry.
          if (outcome.status === 'timedOut') await request;
          return outcome;
        } finally {
          clearTimeout(timer!);
          signal.removeEventListener('abort', cancel);
          deadline.abort();
        }
      },
      decide,
      finalize: () => this.serializeTransition(async () => {
        await this.sessionStore.end(id ?? null);
        await finalizeLocal();
        await this.resources.close();
      }),
    }));
    this.interactiveLogout = pending;
    void pending.then(
      () => { this.interactiveLogout = null; },
      () => { this.interactiveLogout = null; },
    );
    return pending;
  }

  /** Forced/local termination releases handles but retains caches for the next fresh login. */
  end(): Promise<void> {
    if (this.interactiveLogout) {
      return this.interactiveLogout.then(() => undefined);
    }
    const signal = this.beginTransition();
    return this.serializeTransition(async () => {
      await this.markEndedAndClose();
      this.check(signal);
    });
  }

  private async markEndedAndClose(): Promise<void> {
    try {
      const saved = await this.sessionStore.read();
      await this.sessionStore.end(saved?.session?.id ?? null);
    } finally {
      // Metadata failure must not leave old connections or workers running.
      await this.resources.close();
    }
  }

  private async cleanup(): Promise<void> {
    let saved = await this.sessionStore.read();
    if (saved?.phase === 'revoking') {
      throw new Error('Session revocation requires an explicit decision');
    }
    if (saved?.session || !saved) {
      saved = await this.sessionStore.end(saved?.session?.id ?? null);
    }
    await this.resources.close();
    for (const descriptor of saved?.pendingCleanup ?? []) {
      await this.resources.delete(descriptor);
      await this.sessionStore.completeCleanup(descriptor.id);
    }
    await this.resources.prepareFreshCache();
  }

  private beginTransition(): AbortSignal {
    this.work.abort();
    this.work = new AbortController();
    this.active = null;
    this.invalidate();
    this.resources.resetState();
    return this.work.signal;
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new SessionSupersededError();
  }

  private serializeTransition<T>(run: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(run);
    this.transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private serializeAuthentication<T>(run: () => Promise<T>): Promise<T> {
    const result = this.authenticationTail.then(run);
    this.authenticationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
