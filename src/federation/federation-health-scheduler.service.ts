import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

const HEALTH_ROUND_INTERVAL_MS = 60_000;
const MAX_CONCURRENCY = 4;
const MAX_PENDING = 32;

/** Runs bounded periodic Health rounds without duplicating or accumulating per-peer requests. */
@Injectable()
export class FederationHealthSchedulerService
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FederationHealthSchedulerService.name);
  private readonly pending: string[] = [];
  private readonly inFlight = new Set<string>();
  private roundActive = false;
  private scanExhausted = false;
  private scanCursor: string | null = null;
  private refilling = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly peerLifecycle: FederationPeerLifecycle,
  ) {}

  onApplicationBootstrap(): void {
    this.startRound();
  }

  @Interval(HEALTH_ROUND_INTERVAL_MS)
  scheduleRound(): void {
    this.startRound();
  }

  private startRound(): void {
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
      const rows = await this.database.db.query.federatedPeer.findMany({
        where: and(
          inArray(tables.federatedPeer.trustLevel, [
            'establishing',
            'available',
            'degraded',
          ]),
          isNotNull(tables.federatedPeer.activeNamespaceId),
          eq(tables.federatedPeer.recognizesPeer, true),
          eq(tables.federatedPeer.localServiceAvailable, true),
          ...(this.scanCursor === null
            ? []
            : [gt(tables.federatedPeer.domain, this.scanCursor)]),
        ),
        columns: { domain: true },
        orderBy: asc(tables.federatedPeer.domain),
        limit: capacity,
      });
      if (rows.length === 0) {
        this.scanExhausted = true;
      } else {
        this.scanCursor = rows.at(-1)!.domain;
        this.pending.push(...rows.map((row) => row.domain));
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
      const domain = this.pending.shift()!;
      this.inFlight.add(domain);
      void this.peerLifecycle
        .checkHealth(domain)
        .catch((error) =>
          this.logger.debug(`Health ${domain}: ${(error as Error).message}`),
        )
        .finally(() => {
          this.inFlight.delete(domain);
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
}
