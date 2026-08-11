import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';

export const FEDERATION_MESSAGE_CHANGE_HARD_LIMIT = 10_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export interface FederationMessageFeedGcResult {
  acknowledgedDeleted: number;
  forcedDeleted: number;
  forcedThrough: bigint | null;
}

/**
 * Bounds the source-side per-peer delivery index. Confirmed changes are disposable because a request
 * with `after = N` acknowledges every change through N. A peer that leaves more than the hard limit
 * unconsumed forfeits the oldest half; the cursor floor is advanced atomically with that deletion so
 * an old request receives a deterministic cursor-reset response instead of a partial page.
 */
@Injectable()
export class FederationMessageFeedGcService {
  private readonly logger = new Logger(FederationMessageFeedGcService.name);
  private running: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  @Interval(SWEEP_INTERVAL_MS)
  async scheduledSweep(): Promise<void> {
    if (this.running) return this.running;
    try {
      if ((await this.databaseIsBusy()) && !(await this.hasEmergencyBacklog()))
        return;
    } catch (error) {
      this.logger.error(
        `message-feed GC scheduling check failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return;
    }
    this.running = this.runOnce()
      .catch((error: unknown) => {
        this.logger.error(
          `message-feed GC sweep failed: ${(error as Error).message}`,
          (error as Error).stack,
        );
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async hasEmergencyBacklog(): Promise<boolean> {
    const result = await this.database.db.execute<{ overLimit: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "FederationServeCursor" cursor
        JOIN "DiscoveryTarget" target ON target.id = cursor."targetId"
        WHERE target."allocatedThrough" - cursor."startChangeId" >
          ${FEDERATION_MESSAGE_CHANGE_HARD_LIMIT}
      ) AS "overLimit"
    `);
    return result.rows[0]?.overLimit ?? false;
  }

  private async databaseIsBusy(): Promise<boolean> {
    const result = await this.database.db.execute<{ busy: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
          AND state = 'active'
      ) AS busy
    `);
    return result.rows[0]?.busy ?? true;
  }

  async runOnce(): Promise<void> {
    // The in-process `running` guard is not enough when multiple API processes share PostgreSQL.
    // Hold one session advisory lock for the complete sweep; contenders return immediately.
    const lockClient = await this.database.pool.connect();
    try {
      const lock = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended('federation-message-feed-gc', 0)) AS locked`,
      );
      if (!lock.rows[0]?.locked) return;
      try {
        await this.runExclusiveSweep();
      } finally {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtextextended('federation-message-feed-gc', 0))`,
        );
      }
    } finally {
      lockClient.release();
    }
  }

  private async runExclusiveSweep(): Promise<void> {
    const peers = await this.database.db.execute<{ peerDomain: string }>(sql`
      SELECT "peerDomain"
      FROM "FederationServeCursor"
      ORDER BY "peerDomain"
    `);
    for (const { peerDomain } of peers.rows) {
      try {
        await this.prunePeer(peerDomain);
      } catch (error) {
        this.logger.error(
          `message-feed GC failed for ${peerDomain}: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
    }
  }

  private async prunePeer(
    peerDomain: string,
  ): Promise<FederationMessageFeedGcResult> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const locked = await tx.execute<{
        targetId: bigint;
        acknowledgedThrough: bigint;
      }>(sql`
        SELECT cursor."targetId", cursor."acknowledgedThrough"
        FROM "FederationServeCursor" cursor
        JOIN "DiscoveryTarget" target ON target.id = cursor."targetId"
        WHERE cursor."peerDomain" = ${peerDomain}
        FOR UPDATE OF cursor, target SKIP LOCKED
      `);
      const state = locked.rows[0];
      if (!state) {
        return {
          acknowledgedDeleted: 0,
          forcedDeleted: 0,
          forcedThrough: null,
        };
      }

      const acknowledged = await tx.execute(sql`
        DELETE FROM "DiscoveryChange"
        WHERE "targetId" = ${state.targetId}
          AND "changeId" <= ${state.acknowledgedThrough}
      `);
      await tx.execute(sql`
        UPDATE "FederationServeCursor"
        SET "startChangeId" = GREATEST("startChangeId", "acknowledgedThrough"),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "peerDomain" = ${peerDomain}
      `);
      const remaining = await tx.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM "DiscoveryChange"
        WHERE "targetId" = ${state.targetId}
      `);
      const remainingCount = remaining.rows[0]?.count ?? 0;
      if (remainingCount <= FEDERATION_MESSAGE_CHANGE_HARD_LIMIT) {
        return {
          acknowledgedDeleted: acknowledged.rowCount ?? 0,
          forcedDeleted: 0,
          forcedThrough: null,
        };
      }

      const retainCount = Math.ceil(remainingCount / 2);
      const cutoffResult = await tx.execute<{ changeId: bigint }>(sql`
        SELECT "changeId"
        FROM "DiscoveryChange"
        WHERE "targetId" = ${state.targetId}
        ORDER BY "changeId" DESC
        OFFSET ${retainCount}
        LIMIT 1
      `);
      const cutoffValue = cutoffResult.rows[0]?.changeId;
      if (cutoffValue === undefined) {
        throw new Error('message-feed GC could not resolve forced cutoff');
      }
      const cutoff = BigInt(cutoffValue);
      const forced = await tx.execute(sql`
        DELETE FROM "DiscoveryChange"
        WHERE "targetId" = ${state.targetId}
          AND "changeId" <= ${cutoff}
      `);
      await tx.execute(sql`
        UPDATE "FederationServeCursor"
        SET "startChangeId" = GREATEST("startChangeId", ${cutoff}),
            "acknowledgedThrough" = GREATEST("acknowledgedThrough", ${cutoff}),
            "lastServedThrough" = GREATEST("lastServedThrough", ${cutoff}),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "peerDomain" = ${peerDomain}
      `);
      this.logger.warn(
        `message-feed backlog for ${peerDomain} exceeded ${FEDERATION_MESSAGE_CHANGE_HARD_LIMIT}; ` +
          `discarded through change ${cutoff.toString()} and retained the newest ${retainCount}`,
      );
      return {
        acknowledgedDeleted: acknowledged.rowCount ?? 0,
        forcedDeleted: forced.rowCount ?? 0,
        forcedThrough: cutoff,
      };
    });
  }
}
