import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { DatabaseService } from '../database/database.service.js';
import {
  FederationTransportError,
  S2sResponseError,
} from './federation-errors.js';

const GLOBAL_LIMIT_KEY = 'federation:http:globalLimit';
const PEER_LIMIT_KEY = 'federation:http:peerLimit';
const DEFAULT_GLOBAL_LIMIT = 16;
const DEFAULT_PEER_LIMIT = 8;
const MAX_LIMIT = 100;
const CONFIG_TTL_MS = 5_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const RETRYABLE_CODES = new Set<number>([
  BusinessCode.RATE_LIMITED,
  BusinessCode.INTERNAL,
  BusinessCode.FEDERATION_QUOTA_EXCEEDED,
  BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
]);

export interface FederationHttpLimits {
  global: number;
  perPeer: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

/** Fair process-local concurrency pool for ordinary S2S HTTP. Media transfers use their dedicated
 * scheduler. Peers rotate round-robin, while requests within one peer retain FIFO order. */
@Injectable()
export class FederationHttpScheduler
  implements OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly shutdown = new AbortController();
  private readonly slots = new Set<Promise<void>>();

  onModuleDestroy(): void {
    this.shutdown.abort(new Error('federation HTTP scheduler shutting down'));
    for (const queue of this.queues.values())
      for (const waiter of queue) waiter.reject(this.shutdown.signal.reason);
    this.queues.clear();
    this.peerOrder.length = 0;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    const pending: Promise<unknown>[] = [...this.slots];
    if (this.refreshPromise) pending.push(this.refreshPromise);
    const results = await Promise.allSettled(pending);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        'federation HTTP scheduler shutdown failed',
      );
  }

  private readonly logger = new Logger(FederationHttpScheduler.name);
  private active = 0;
  private readonly activeByPeer = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly peerOrder: string[] = [];
  private limits: FederationHttpLimits = {
    global: DEFAULT_GLOBAL_LIMIT,
    perPeer: DEFAULT_PEER_LIMIT,
  };
  private limitsFetchedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  async acquire(peerDomain: string): Promise<() => void> {
    this.shutdown.signal.throwIfAborted();
    await this.refreshLimitsIfStale();
    this.shutdown.signal.throwIfAborted();
    return new Promise<() => void>((resolve, reject) => {
      const queue = this.queues.get(peerDomain);
      if (queue) queue.push({ resolve, reject });
      else {
        this.queues.set(peerDomain, [{ resolve, reject }]);
        this.peerOrder.push(peerDomain);
      }
      this.pump();
    });
  }

  /** Retry one logical network operation after temporary failures. Each attempt
   * must acquire its own ordinary HTTP slot through the transport path. */
  async runWithRetry<T>(
    peerDomain: string,
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.shutdown.signal.throwIfAborted();
      try {
        const result = await operation();
        this.shutdown.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (
          this.shutdown.signal.aborted ||
          !isRetryableFederationNetworkError(error)
        )
          throw error;
        attempt += 1;
        const delayMs = retryDelay(attempt, retryAfterMs(error));
        this.logger.warn(
          `${operationName} for ${peerDomain} failed temporarily; retrying in ${delayMs}ms`,
        );
        await wait(delayMs, this.shutdown.signal);
      }
    }
  }

  invalidateLimits(): void {
    if (this.shutdown.signal.aborted) return;
    this.limitsFetchedAt = 0;
    void this.refreshLimitsIfStale().then(
      () => this.pump(),
      (error: unknown) =>
        this.logger.error('Could not refresh federation HTTP limits', error),
    );
  }

  private pump(): void {
    if (this.shutdown.signal.aborted) return;
    let blockedPeers = 0;
    while (this.active < this.limits.global && this.peerOrder.length > 0) {
      const peerDomain = this.peerOrder.shift()!;
      const queue = this.queues.get(peerDomain);
      if (!queue?.length) {
        this.queues.delete(peerDomain);
        continue;
      }
      if ((this.activeByPeer.get(peerDomain) ?? 0) >= this.limits.perPeer) {
        this.peerOrder.push(peerDomain);
        blockedPeers += 1;
        if (blockedPeers >= this.peerOrder.length) return;
        continue;
      }
      blockedPeers = 0;
      const waiter = queue.shift()!;
      if (queue.length > 0) this.peerOrder.push(peerDomain);
      else this.queues.delete(peerDomain);
      this.active += 1;
      this.activeByPeer.set(
        peerDomain,
        (this.activeByPeer.get(peerDomain) ?? 0) + 1,
      );
      let drained!: () => void;
      const slot = new Promise<void>((resolve) => {
        drained = resolve;
      });
      this.slots.add(slot);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.slots.delete(slot);
        drained();
        this.active -= 1;
        const peerActive = (this.activeByPeer.get(peerDomain) ?? 1) - 1;
        if (peerActive === 0) this.activeByPeer.delete(peerDomain);
        else this.activeByPeer.set(peerDomain, peerActive);
        this.pump();
      });
    }
  }

  private async refreshLimitsIfStale(): Promise<void> {
    if (Date.now() - this.limitsFetchedAt < CONFIG_TTL_MS) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const rows = await this.database.db.query.systemSetting.findMany({
          where: (setting, { inArray }) =>
            inArray(setting.key, [GLOBAL_LIMIT_KEY, PEER_LIMIT_KEY]),
          columns: { key: true, value: true },
        });
        if (this.shutdown.signal.aborted) return;
        const values = new Map(rows.map((row) => [row.key, row.value]));
        this.limits = {
          global: this.parseLimit(
            values.get(GLOBAL_LIMIT_KEY),
            DEFAULT_GLOBAL_LIMIT,
          ),
          perPeer: this.parseLimit(
            values.get(PEER_LIMIT_KEY),
            DEFAULT_PEER_LIMIT,
          ),
        };
        this.limitsFetchedAt = Date.now();
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private parseLimit(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_LIMIT
      ? parsed
      : fallback;
  }
}

export function isRetryableFederationNetworkError(error: unknown): boolean {
  if (error instanceof FederationTransportError) return true;
  if (!(error instanceof S2sResponseError)) return false;
  return (
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 429 ||
    (error.code !== undefined && RETRYABLE_CODES.has(error.code))
  );
}

function retryAfterMs(error: unknown): number {
  if (!(error instanceof S2sResponseError)) return 0;
  if (
    typeof error.data !== 'object' ||
    error.data === null ||
    Array.isArray(error.data)
  )
    return 0;
  const retryAfter = (error.data as Record<string, unknown>)['retryAfter'];
  if (!Number.isSafeInteger(retryAfter) || Number(retryAfter) < 0) return 0;
  return Math.min(2_147_483_647, Number(retryAfter) * 1_000);
}

function retryDelay(attempt: number, minimumDelayMs: number): number {
  const exponential = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.min(2_147_483_647, Math.max(exponential, minimumDelayMs));
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
  });
}

export const federationHttpSettingKeys = {
  globalLimit: GLOBAL_LIMIT_KEY,
  peerLimit: PEER_LIMIT_KEY,
} as const;
