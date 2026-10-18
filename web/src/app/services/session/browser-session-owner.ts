import {
  createSessionCacheDescriptor,
  SessionSupersededError,
  type SessionCacheDescriptor,
} from './session-identity';
import { SessionJournal } from './session-journal';

/** Each operation has one owner. resetState must not close resources or invalidate again. */
export interface BrowserSessionResources {
  close(): Promise<void>;
  initialize(session: SessionCacheDescriptor): Promise<void>;
  restore(session: SessionCacheDescriptor, signal: AbortSignal): Promise<void>;
  delete(session: SessionCacheDescriptor): Promise<void>;
  deleteLegacy(): Promise<void>;
  resetState(): void;
}

/**
 * Browser session authority. Remote revocation is best effort and is never a
 * prerequisite for fresh authentication. Lifecycle notifications temporarily
 * bridge consumers that have not yet migrated from numeric account epochs.
 */
export class BrowserSessionOwner {
  private active: SessionCacheDescriptor | null = null;
  private work = new AbortController();
  private transitions: Promise<unknown> = Promise.resolve();
  private authenticationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journal: SessionJournal,
    private readonly resources: BrowserSessionResources,
    private readonly invalidate: () => void,
  ) {}

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
      await this.serializeTransition(() => this.cleanup(true));
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
      await this.journal.prepare(descriptor);
      await this.resources.initialize(descriptor);
      this.check(signal);
      await this.journal.activate(descriptor.id);
      this.check(signal);
      this.active = descriptor;
    });
  }

  /** Presence cookies are evidence of credentials, never permission to ignore a logout record. */
  restore(hasCredential: boolean): Promise<boolean> {
    const signal = this.beginTransition();
    return this.serializeTransition(async () => {
      this.check(signal);
      let saved = await this.journal.read();
      this.check(signal);
      if (
        !hasCredential ||
        saved?.phase === 'ending' ||
        saved?.phase === 'signed-out'
      ) {
        await this.markEndedAndClose();
        return false;
      }
      if (!saved) {
        // One-time migration: preserve the server login but replace legacy local caches.
        await this.cleanup(false);
        this.check(signal);
        const descriptor = createSessionCacheDescriptor();
        saved = await this.journal.prepare(descriptor);
      }
      const descriptor = saved.session;
      if (!descriptor)
        throw new Error('Missing recoverable session descriptor');
      if (saved.phase === 'preparing') {
        await this.resources.initialize(descriptor);
        this.check(signal);
        await this.journal.activate(descriptor.id);
      } else {
        await this.resources.close();
      }
      this.check(signal);
      await this.resources.restore(descriptor, signal);
      this.check(signal);
      this.active = descriptor;
      return true;
    });
  }

  /** Forced/local termination releases handles but retains caches for the next fresh login. */
  end(): Promise<void> {
    const signal = this.beginTransition();
    return this.serializeTransition(async () => {
      await this.markEndedAndClose();
      this.check(signal);
    });
  }

  /**
   * Local release and a best-effort logout request form one operation. The deadline
   * includes queue waiting. Transports must abort the actual request on signal
   * cancellation, not merely discard its response. No failed request is replayed.
   */
  logout(
    operation: (signal: AbortSignal) => Promise<void>,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error('Logout timeout must be positive and finite'),
      );
    }
    const released = this.end();
    const scope = this.work.signal;
    const deadline = new AbortController();
    const request = this.serializeAuthentication(async () => {
      // Still try revocation if persistence failed, while surfacing the local error.
      await released.catch(() => undefined);
      if (this.work.signal !== scope || deadline.signal.aborted) return;
      await operation(deadline.signal);
    });
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        resolve();
      }, timeoutMs);
    });
    const remoteFinished = Promise.race([
      request.catch(() => undefined),
      expired,
    ]).finally(() => {
      clearTimeout(timer);
      deadline.abort();
    });
    return Promise.all([released, remoteFinished]).then(() => undefined);
  }

  private async markEndedAndClose(): Promise<void> {
    try {
      const saved = await this.journal.read();
      await this.journal.end(saved?.session?.id ?? null);
    } finally {
      // Metadata failure must not leave old connections or workers running.
      await this.resources.close();
    }
  }

  private async cleanup(explicitEnd: boolean): Promise<void> {
    let saved = await this.journal.read();
    if (saved?.session || (!saved && explicitEnd)) {
      saved = await this.journal.end(saved?.session?.id ?? null);
    }
    await this.resources.close();
    for (const descriptor of saved?.pendingCleanup ?? []) {
      await this.resources.delete(descriptor);
      await this.journal.completeCleanup(descriptor.id);
    }
    await this.resources.deleteLegacy();
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
