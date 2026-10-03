import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DiscoveryService } from './discovery.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { loadFederationConfig } from './federation.config.js';

const MAX_CONCURRENCY = 4;
const MAX_PENDING = 32;

interface PeerTask {
  domain: string;
  namespaceId: number;
}

/** The single periodic federation maintenance loop. Every round, for each
 *  establishing/available/degraded peer, it runs an outbound Health check and
 *  — on success — refreshes the SRV route and conditionally refreshes the
 *  cached certificate set (coverage-based; the refresh itself is single-flight
 *  and rate-limited inside DiscoveryService). This is the only scheduler that
 *  drives peer-key freshness and SRV discovery; there is no separate key-refresh
 *  timer and no lazy SRV TTL. */
@Injectable()
export class FederationHealthSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(FederationHealthSchedulerService.name);
  private readonly config = loadFederationConfig();
  private readonly pending: PeerTask[] = [];
  private readonly inFlight = new Set<string>();
  private roundActive = false;
  private scanExhausted = false;
  private scanCursor: string | null = null;
  private refilling = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly discovery: DiscoveryService,
  ) {}

  onApplicationBootstrap(): void {
    this.startRound();
    this.scheduleNext();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(): void {
    const timer = setTimeout(() => {
      this.startRound();
      this.scheduleNext();
    }, this.config.peerKeyRefreshPollMs);
    timer.unref?.();
    this.timer = timer;
  }

  startRound(): void {
    if (this.roundActive) return;
    this.roundActive = true;
    this.scanExhausted = false;
    this.scanCursor = null;
    void this.refill();
  }

  private async refill(): Promise<void> {
    if (!this.roundActive || this.scanExhausted || this.refilling) return;
    const capacity = MAX_PENDING - this.pending.length;
    if (capacity <= 0) return;
    this.refilling = true;
    try {
      const rows = await this.database.db.query.identityNamespace.findMany({
        where: and(
          inArray(tables.identityNamespace.trustLevel, [
            'establishing',
            'available',
            'degraded',
          ]),
          eq(tables.identityNamespace.active, true),
          eq(tables.identityNamespace.localServiceAvailable, true),
          ...(this.scanCursor === null
            ? []
            : [gt(tables.identityNamespace.domain, this.scanCursor)]),
        ),
        columns: { id: true, domain: true },
        orderBy: asc(tables.identityNamespace.domain),
        limit: capacity,
      });
      if (rows.length === 0) {
        this.scanExhausted = true;
      } else {
        this.scanCursor = rows.at(-1)!.domain;
        for (const row of rows) {
          if (row.id != null)
            this.pending.push({
              domain: row.domain,
              namespaceId: row.id,
            });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Health scheduler scan failed: ${(error as Error).message}`,
      );
      this.scanExhausted = true;
    } finally {
      this.refilling = false;
      this.pump();
    }
  }

  private pump(): void {
    while (this.inFlight.size < MAX_CONCURRENCY && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.inFlight.add(task.domain);
      void this.runOne(task)
        .catch((error) =>
          this.logger.debug(
            `Health ${task.domain}: ${(error as Error).message}`,
          ),
        )
        .finally(() => {
          this.inFlight.delete(task.domain);
          this.pump();
          void this.refill();
        });
    }
    if (
      this.roundActive &&
      this.scanExhausted &&
      this.pending.length === 0 &&
      this.inFlight.size === 0
    ) {
      this.roundActive = false;
      this.scanCursor = null;
    }
  }

  /** One peer per round: outbound Health, then — on success — SRV refresh and a
   *  coverage-based certificate refresh. Both maintenance steps are best-effort and
   *  never turn a successful Health result into a failure; they run as fire-and-forget
   *  so the Health scheduler's concurrency is not blocked by discovery I/O. */
  private async runOne(task: PeerTask): Promise<void> {
    await this.peerLifecycle.checkHealth(task.domain);
    // Health succeeded: refresh the SRV route so DNS edits propagate at the
    // Health cadence, and conditionally refresh the cached certificate set.
    void this.discovery.refreshRoute(task.domain);
    void this.discovery.refreshPeerCertificateIfNeeded(
      task.domain,
      task.namespaceId,
    );
  }
}
