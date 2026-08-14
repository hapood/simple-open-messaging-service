import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const GLOBAL_LIMIT_KEY = 'federation:http:globalLimit';
const PEER_LIMIT_KEY = 'federation:http:peerLimit';
const DEFAULT_GLOBAL_LIMIT = 16;
const DEFAULT_PEER_LIMIT = 8;
const MAX_LIMIT = 100;
const CONFIG_TTL_MS = 5_000;

export interface FederationHttpLimits {
  global: number;
  perPeer: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
}

/** Fair process-local concurrency pool for ordinary S2S HTTP. Media transfers use their dedicated
 * scheduler. Peers rotate round-robin, while requests within one peer retain FIFO order. */
@Injectable()
export class FederationHttpScheduler {
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
    await this.refreshLimitsIfStale();
    return new Promise<() => void>((resolve) => {
      const queue = this.queues.get(peerDomain);
      if (queue) queue.push({ resolve });
      else {
        this.queues.set(peerDomain, [{ resolve }]);
        this.peerOrder.push(peerDomain);
      }
      this.pump();
    });
  }

  invalidateLimits(): void {
    this.limitsFetchedAt = 0;
    void this.refreshLimitsIfStale().then(() => this.pump());
  }

  private pump(): void {
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
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
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

export const federationHttpSettingKeys = {
  globalLimit: GLOBAL_LIMIT_KEY,
  peerLimit: PEER_LIMIT_KEY,
} as const;
