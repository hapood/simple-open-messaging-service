import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

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

interface QueuedDownload {
  peerDomain: string;
  key: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Process-wide federation download dispatcher. It enforces both limits before a task starts and
 * coalesces concurrent requests for the same (peer, digest), so one physical CAS transfer can satisfy
 * any number of staged messages. Database state remains authoritative; this class only controls live IO.
 */
@Injectable()
export class FederationDownloadScheduler {
  private active = 0;
  private readonly activeByPeer = new Map<string, number>();
  private readonly queue: QueuedDownload[] = [];
  private readonly inflight = new Map<string, Promise<unknown>>();
  private limits: FederationDownloadLimits = {
    global: DEFAULT_GLOBAL_LIMIT,
    perPeer: DEFAULT_PEER_LIMIT,
  };
  private limitsFetchedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  async schedule<T>(
    peerDomain: string,
    digest: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${peerDomain}\0${digest}`;
    const current = this.inflight.get(key);
    if (current) return current as Promise<T>;

    await this.refreshLimitsIfStale();
    // Another caller may have installed the same key while this caller awaited the config refresh.
    const refreshedCurrent = this.inflight.get(key);
    if (refreshedCurrent) return refreshedCurrent as Promise<T>;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        peerDomain,
        key,
        task,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pump();
    });
    this.inflight.set(key, promise);
    void promise
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      })
      .catch(() => undefined);
    return promise;
  }

  /** Evict the short config cache after an admin update. Queued work uses the new limits on its next pump. */
  invalidateLimits(): void {
    this.limitsFetchedAt = 0;
    void this.refreshLimitsIfStale().then(() => this.pump());
  }

  private pump(): void {
    while (this.active < this.limits.global) {
      const index = this.queue.findIndex(
        (item) =>
          (this.activeByPeer.get(item.peerDomain) ?? 0) < this.limits.perPeer,
      );
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      this.active += 1;
      this.activeByPeer.set(
        item.peerDomain,
        (this.activeByPeer.get(item.peerDomain) ?? 0) + 1,
      );
      void item
        .task()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          const peerActive = (this.activeByPeer.get(item.peerDomain) ?? 1) - 1;
          if (peerActive === 0) this.activeByPeer.delete(item.peerDomain);
          else this.activeByPeer.set(item.peerDomain, peerActive);
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
      } finally {
        this.limitsFetchedAt = Date.now();
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
} as const;
