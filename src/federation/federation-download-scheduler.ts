import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  asyncScheduler,
  merge,
  interval,
  map,
  Observable,
  startWith,
  Subject,
  throttleTime,
} from 'rxjs';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

import { DownloadSpeed } from './download-speed.js';

const GLOBAL_LIMIT_KEY = 'federation:download:globalLimit';
const PEER_LIMIT_KEY = 'federation:download:peerLimit';
const DEFAULT_GLOBAL_LIMIT = 10;
const DEFAULT_PEER_LIMIT = 2;
const MAX_LIMIT = 100;
const CONFIG_TTL_MS = 5_000;

export interface FederationDownloadLimits {
  global: number;
  perPeer: number;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
}

export type DigestDownloadProgress = DownloadProgress &
  (
    | { status: 'pending'; bytesPerSecond: null }
    | { status: 'downloading'; bytesPerSecond: number }
  );

interface QueuedDownload {
  peerDomain: string;
  digest: string;
  key: string;
  task: (
    report: (progress: DownloadProgress) => void,
    signal: AbortSignal,
  ) => Promise<unknown>;
  controller: AbortController;
  consumers: number;
  progressListeners: Set<(progress: DownloadProgress) => void>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  speed: DownloadSpeed;
  status: 'queued' | 'active';
  received: number;
  total: number | null;
}

/** Process-local physical IO, not durable business-task state. Coalesced consumers share one entry. */
@Injectable()
export class FederationDownloadScheduler implements BeforeApplicationShutdown {
  private readonly shutdown = new AbortController();

  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort(new Error('download scheduler shutting down'));
    const entries = [...this.entries.values()];
    // Capture every writer before abort callbacks can settle consumers. Physical IO
    // may still perform database and filesystem cleanup after its last consumer exits.
    const pending: Promise<unknown>[] = entries.map((entry) =>
      this.waitForWriter(entry),
    );
    if (this.refreshPromise) pending.push(this.refreshPromise);
    for (const entry of entries)
      entry.controller.abort(this.shutdown.signal.reason);
    for (const entry of this.queue.splice(0)) {
      this.entries.delete(entry.key);
      this.inflight.delete(entry.key);
      entry.reject(entry.controller.signal.reason);
    }
    this.changes.next();
    try {
      await this.drainWriters(pending);
    } finally {
      this.changes.complete();
    }
  }

  private readonly logger = new Logger(FederationDownloadScheduler.name);
  private readonly instanceId = randomUUID();
  private readonly changes = new Subject<void>();
  private active = 0;
  private readonly activeByPeer = new Map<string, number>();
  private readonly queue: QueuedDownload[] = [];
  private readonly entries = new Map<string, QueuedDownload>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly stoppingDigests = new Set<string>();

  private assertDigestAdmission(digest: string): void {
    this.shutdown.signal.throwIfAborted();
    if (this.stoppingDigests.has(digest))
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'download is stopping',
        409,
      );
  }
  private limits: FederationDownloadLimits = {
    global: DEFAULT_GLOBAL_LIMIT,
    perPeer: DEFAULT_PEER_LIMIT,
  };
  private limitsFetchedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  /** Bounded full snapshots make reconnects and page changes independent of event history. */
  observe(
    skip: number,
    take: number,
  ): Observable<ReturnType<FederationDownloadScheduler['snapshot']>> {
    return this.changes.pipe(
      startWith(undefined),
      throttleTime(500, asyncScheduler, { leading: true, trailing: true }),
      map(() => this.snapshot(skip, take)),
    );
  }

  /** Read-only digest progress. Unsubscribing never changes download ownership. */
  observeDigest(digest: string): Observable<DigestDownloadProgress | null> {
    // Refresh stalled rates too; observation still owns no physical download.
    return merge(this.changes, interval(1000)).pipe(
      startWith(undefined),
      throttleTime(500, asyncScheduler, { leading: true, trailing: true }),
      map((): DigestDownloadProgress | null => {
        const entry = this.entries.get(digest);
        if (!entry) return null;
        const bytes = { received: entry.received, total: entry.total };
        if (entry.status === 'queued')
          return { ...bytes, status: 'pending', bytesPerSecond: null };
        return {
          ...bytes,
          status: 'downloading',
          bytesPerSecond: entry.speed.value(),
        };
      }),
    );
  }

  snapshot(skip = 0, take = 50) {
    const entries: QueuedDownload[] = [];
    let index = 0;
    for (const entry of this.entries.values()) {
      if (index++ < skip) continue;
      if (entries.length >= Math.min(take, 100)) break;
      entries.push(entry);
    }
    return {
      instanceId: this.instanceId,
      observedAt: new Date().toISOString(),
      limits: { ...this.limits },
      active: this.active,
      queued: this.queue.length,
      total: this.entries.size,
      list: entries.map((entry) => ({
        digest: entry.digest,
        status: entry.status,
        bytesReceived: String(entry.received),
        bytesTotal: entry.total === null ? null : String(entry.total),
      })),
    };
  }

  async schedule<T>(
    peerDomain: string,
    digest: string,
    task: (
      report: (progress: DownloadProgress) => void,
      signal: AbortSignal,
    ) => Promise<T>,
    declaredBytes: number | undefined,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<T> {
    this.assertDigestAdmission(digest);
    // The source controls routing and per-peer admission, never physical file identity.
    const key = digest;
    const current = this.inflight.get(key);
    signal.throwIfAborted();
    if (current)
      return this.consume(key, current as Promise<T>, signal, onProgress);
    await this.refreshLimitsIfStale();
    this.assertDigestAdmission(digest);
    const refreshedCurrent = this.inflight.get(key);
    signal.throwIfAborted();
    if (refreshedCurrent)
      return this.consume(
        key,
        refreshedCurrent as Promise<T>,
        signal,
        onProgress,
      );

    // Install ownership before starting IO: synchronous callbacks must see the live entry.
    let entry!: QueuedDownload;
    const promise = new Promise<T>((resolve, reject) => {
      entry = {
        peerDomain,
        digest,
        key,
        task,
        resolve: (value) => resolve(value as T),
        reject,
        speed: new DownloadSpeed(),
        status: 'queued',
        received: 0,
        total: declaredBytes ?? null,
        controller: new AbortController(),
        consumers: 0,
        progressListeners: new Set(),
      };
    });
    this.inflight.set(key, promise);
    this.entries.set(key, entry);
    this.queue.push(entry);
    const consumer = this.consume(key, promise, signal, onProgress);
    this.changes.next();
    this.pump();
    return consumer;
  }

  private consume<T>(
    key: string,
    promise: Promise<T>,
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<T> {
    const entry = this.entries.get(key)!;
    if (entry.controller.signal.aborted)
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'download is stopping',
        409,
      );
    entry.consumers++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        entry.progressListeners.delete(progress);
        entry.consumers--;
        if (entry.consumers === 0 && this.entries.get(key) === entry) {
          entry.controller.abort(new Error('download stopped'));
          if (entry.status === 'queued') {
            const index = this.queue.indexOf(entry);
            if (index >= 0) this.queue.splice(index, 1);
            this.entries.delete(key);
            this.inflight.delete(key);
            entry.reject(new Error('download stopped'));
            this.changes.next();
          }
        }
        if (ok) resolve(value as T);
        else reject(value);
      };
      const abort = () =>
        finish(false, signal.reason ?? new Error('download stopped'));
      const progress = (value: DownloadProgress) => {
        if (settled || signal.aborted) return;
        try {
          onProgress?.(value);
        } catch (error) {
          finish(false, error);
        }
      };
      if (onProgress) entry.progressListeners.add(progress);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(
        (value) => finish(true, value),
        (error: unknown) => finish(false, error),
      );
      if (signal.aborted) abort();
      else progress({ received: entry.received, total: entry.total });
    });
  }

  /** Wait for physical writers after cancellation before temporary files can be removed. */
  async waitForDigest(digest: string): Promise<void> {
    const pending = [...this.entries.values()]
      .filter(
        (entry) => entry.digest === digest && entry.controller.signal.aborted,
      )
      .map((entry) => this.waitForWriter(entry));
    await this.drainWriters(pending);
  }

  async stopDigest(digest: string): Promise<void> {
    this.assertDigestAdmission(digest);
    this.stoppingDigests.add(digest);
    try {
      const pending: Promise<unknown>[] = [];
      for (const entry of this.entries.values()) {
        if (entry.digest !== digest) continue;
        entry.controller.abort(new Error('stopped by administrator'));
        pending.push(this.waitForWriter(entry));
        if (entry.status === 'queued') {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          this.entries.delete(entry.key);
          this.inflight.delete(entry.key);
          entry.reject(entry.controller.signal.reason);
        }
      }
      this.changes.next();
      await this.drainWriters(pending);
    } finally {
      this.stoppingDigests.delete(digest);
    }
  }

  private async waitForWriter(entry: QueuedDownload): Promise<void> {
    try {
      await this.inflight.get(entry.key);
    } catch (error) {
      if (
        !entry.controller.signal.aborted ||
        error !== entry.controller.signal.reason
      )
        throw error;
    }
  }

  private async drainWriters(pending: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(pending);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'download writer cleanup failed');
  }

  hasDigest(digest: string): boolean {
    return this.entries.has(digest);
  }

  invalidateLimits(): void {
    if (this.shutdown.signal.aborted) return;
    this.limitsFetchedAt = 0;
    void this.refreshLimitsIfStale().then(
      () => this.pump(),
      (error: unknown) =>
        this.logger.error(
          'Could not refresh download concurrency limits',
          error,
        ),
    );
  }

  private pump(): void {
    if (this.shutdown.signal.aborted) return;
    while (this.active < this.limits.global) {
      const index = this.queue.findIndex(
        (item) =>
          (this.activeByPeer.get(item.peerDomain) ?? 0) < this.limits.perPeer,
      );
      if (index < 0) break;
      const [item] = this.queue.splice(index, 1);
      this.active += 1;
      this.activeByPeer.set(
        item.peerDomain,
        (this.activeByPeer.get(item.peerDomain) ?? 0) + 1,
      );
      item.status = 'active';
      const report = (progress: DownloadProgress) => {
        if (
          this.entries.get(item.key) !== item ||
          item.controller.signal.aborted
        )
          return;
        item.speed.report(progress.received);
        item.received = progress.received;
        item.total = progress.total;
        for (const listener of item.progressListeners) listener(progress);
        this.changes.next();
      };
      void Promise.resolve()
        .then(() => {
          item.controller.signal.throwIfAborted();
          return item.task(report, item.controller.signal);
        })
        .then(
          (value) => {
            this.finish(item);
            // A non-cooperative writer may resolve after abort. Draining it is not success.
            if (item.controller.signal.aborted)
              item.reject(item.controller.signal.reason);
            else item.resolve(value);
          },
          (error: unknown) => {
            this.finish(item);
            item.reject(error);
          },
        );
    }
    this.changes.next();
  }

  private finish(item: QueuedDownload): void {
    this.entries.delete(item.key);
    this.inflight.delete(item.key);
    this.active -= 1;
    const peerActive = (this.activeByPeer.get(item.peerDomain) ?? 1) - 1;
    if (peerActive === 0) this.activeByPeer.delete(item.peerDomain);
    else this.activeByPeer.set(item.peerDomain, peerActive);
    this.pump();
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
        this.changes.next();
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

export const federationDownloadSettingKeys = {
  globalLimit: GLOBAL_LIMIT_KEY,
  peerLimit: PEER_LIMIT_KEY,
};
