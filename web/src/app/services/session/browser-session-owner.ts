import {
  DatabaseRestorationError,
  restoringDatabase,
} from './database-restoration-error';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
  isSessionSupersededError,
  type SessionCacheDescriptor,
} from './session-identity';
import {
  completeLogout,
  type LogoutDecision,
  type UnconfirmedLogout,
  type LogoutCompletion,
} from './logout-operation';
import { classifyLogoutFailure, type LogoutOutcome } from './logout-outcome';
import { SessionStore, type ServerSessionIdentity } from './session-store';

/** Each operation has one owner. resetState must not close resources or invalidate again. */
export interface BrowserSessionResources {
  close(): Promise<void>;
  initialize(session: SessionCacheDescriptor): Promise<void>;
  restore(session: SessionCacheDescriptor, signal: AbortSignal): Promise<void>;
  delete(): Promise<void>;
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
  private localCleanup: Promise<void> | null = null;
  private authenticationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly resources: BrowserSessionResources,
    private readonly invalidate: () => void,
    private readonly publish: (session: SessionCacheDescriptor) => void,
    private readonly serverConfig?: unknown,
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
      await this.localCleanup;
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
      await this.resources.initialize(descriptor);
      this.check(signal);
      await this.sessionStore.activate(descriptor.id, signal);
      this.check(signal);
      this.active = descriptor;
      this.publish(descriptor);
    });
  }

  /** Hosts enter notification recovery before local restoration and HELLO. */
  protected withRestoration<T>(
    restore: () => Promise<T>,
    _signal: AbortSignal,
  ): Promise<T> {
    return restore();
  }

  /** Presence cookies cannot authorize restoration without a recoverable durable login record. */
  restore(
    hasCredential: boolean,
    recover?: () => Promise<void>,
    complete?: (restored: boolean) => void,
  ): Promise<boolean> {
    const signal = this.beginTransition();
    return this.serializeTransition(async () => {
      try {
        const restored = await this.restoreOwned(hasCredential, signal);
        this.check(signal);
        complete?.(restored);
        return restored;
      } catch (error) {
        // Classification alone is insufficient: ordinary I/O failures can arrive after logout.
        this.check(signal);
        if (
          isSessionSupersededError(error) ||
          !(error instanceof DatabaseRestorationError) ||
          !recover
        )
          throw error;
        console.error('[session] unrecoverable local database', error);
        // Hold the transition lane across every close/delete await. Deletion cannot be cancelled.
        await this.resources.close();
        await recover();
        // Recovery is local only. Re-enter the existing journal initialization; do not retry the network.
        await this.sessionStore.initialize();
        this.check(signal);
        complete?.(false);
        return false;
      }
    });
  }

  private async restoreOwned(
    hasCredential: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.check(signal);
    const saved = await restoringDatabase(() => this.sessionStore.initialize());
    this.check(signal);
    return this.withRestoration(async () => {
      this.check(signal);
      if (!hasCredential || saved.lifecycleState !== 'active') {
        await this.cleanup();
        return false;
      }
      const descriptor = saved.session;
      if (!descriptor)
        throw new DatabaseRestorationError(
          new Error('Missing active session UUID'),
        );
      await this.resources.close();
      this.check(signal);
      await this.resources.restore(descriptor, signal);
      this.check(signal);
      const current = await restoringDatabase(() => this.sessionStore.read());
      if (
        current.lifecycleState !== 'active' ||
        current.session?.id !== descriptor.id
      ) {
        throw new SessionSupersededError();
      }
      this.check(signal);
      this.active = descriptor;
      this.publish(descriptor);
      return true;
    }, signal);
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
      return Promise.reject(
        new Error('Logout timeout must be positive and finite'),
      );
    }
    if (this.interactiveLogout) return this.interactiveLogout;
    const activeId = this.active?.id;
    const signal = this.beginTransition();
    let id = activeId;
    let cleaning = false;
    // Hold the authentication lane through the decision: new cookie-mutating
    // requests must not overlap revocation or the original login's final cleanup.
    const pending = this.serializeAuthentication(() =>
      completeLogout({
        stopWork: () =>
          this.serializeTransition(async () => {
            this.check(signal);
            try {
              const saved = await this.sessionStore.read();
              this.check(signal);
              cleaning = saved.lifecycleState === 'cleaning';
              if (!id) id = saved.session?.id;
              if (!cleaning && (!id || saved.lifecycleState !== 'active')) {
                throw new SessionSupersededError();
              }
              if ((saved.session?.id ?? null) !== (id ?? null))
                throw new SessionSupersededError();
            } finally {
              await this.resources.close();
            }
          }),
        revoke: async () => {
          if (cleaning) return { status: 'revoked' };
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
              return signal.aborted
                ? { status: 'superseded' }
                : deadline.signal.aborted
                  ? { status: 'timedOut' }
                  : classifyLogoutFailure(error);
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
        finalize: () =>
          this.serializeTransition(async () => {
            this.check(signal);
            await this.sessionStore.beginCleaning(id ?? null);
            await finalizeLocal();
            await this.cleanup();
          }),
      }),
    );
    this.interactiveLogout = pending;
    void pending.then(
      () => {
        this.interactiveLogout = null;
      },
      () => {
        this.interactiveLogout = null;
      },
    );
    return pending;
  }

  /** Forced/local termination cancels work before durably deleting the fixed cache. */
  end(finalizeLocal: () => Promise<void> = async () => {}): Promise<void> {
    if (this.interactiveLogout) {
      return this.interactiveLogout.then(() => undefined);
    }
    if (this.localCleanup) return this.localCleanup;
    this.beginTransition();
    const pending = this.serializeTransition(() => this.cleanup(finalizeLocal));
    this.localCleanup = pending;
    void pending.then(
      () => {
        this.localCleanup = null;
      },
      () => {
        this.localCleanup = null;
      },
    );
    return pending;
  }

  private async cleanup(finalizeLocal?: () => Promise<void>): Promise<void> {
    let id = null;
    try {
      let saved = await this.sessionStore.initialize();
      if (
        saved.lifecycleState === 'unconfigured' &&
        this.serverConfig !== undefined
      ) {
        saved = await this.sessionStore.configure(this.serverConfig);
      }
      id = saved.session?.id ?? null;
      await this.sessionStore.beginCleaning(id);
    } finally {
      // Metadata failure must still close admission and release old handles.
      await this.resources.close();
    }
    // Never finish cleaning while an IDB deletion is blocked: its late completion
    // would otherwise delete a successor's identically named cache.
    await finalizeLocal?.();
    await this.resources.delete();
    await this.resources.prepareFreshCache();
    await this.sessionStore.finishCleaning(id);
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
