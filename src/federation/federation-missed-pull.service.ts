import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { federationPullCursor } from '../database/schema.js';
import type { FederationMissedPage } from './federation-missed.service.js';

export interface FederationMissedPullCallbacks {
  fetch(after: bigint): Promise<FederationMissedPage>;
  /** Apply the complete page in the same transaction that advances remoteHwm. */
  apply(tx: DatabaseTransaction, page: FederationMissedPage): Promise<void>;
}

interface AppliedPage {
  requestedAfter: bigint;
  scannedThrough: bigint;
  hasMore: boolean;
}

/**
 * Receiver-side global missed loop. The database cursor is the durable truth; running/pending only
 * coalesce wake-ups in this process. One cursor row lock covers the HTTP page and its local commit,
 * so another process fails NOWAIT instead of issuing a concurrent request to the same peer.
 */
@Injectable()
export class FederationMissedPullService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly advertised = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  /** Coalesce an ephemeral push/HWM observation. Recovery sends a fresh wake-up after restart. */
  advertise(peerDomain: string, allocatedThrough: bigint): void {
    if (allocatedThrough < 0n)
      throw new Error('advertised HWM must be non-negative');
    const current = this.advertised.get(peerDomain);
    if (current === undefined || allocatedThrough > current) {
      this.advertised.set(peerDomain, allocatedThrough);
    }
  }

  /**
   * Request a drain. A wake-up arriving during a run sets pending before observing running, closing
   * the check-then-exit race; the finishing worker starts another run if that bit remains set.
   */
  run(
    peerDomain: string,
    callbacks: FederationMissedPullCallbacks,
  ): Promise<void> {
    this.pending.add(peerDomain);
    const current = this.running.get(peerDomain);
    if (current) return current;

    const task = this.loop(peerDomain, callbacks).finally(() => {
      this.running.delete(peerDomain);
      if (this.pending.has(peerDomain)) {
        queueMicrotask(() => void this.run(peerDomain, callbacks));
      }
    });
    this.running.set(peerDomain, task);
    return task;
  }

  private async loop(
    peerDomain: string,
    callbacks: FederationMissedPullCallbacks,
  ): Promise<void> {
    this.pending.delete(peerDomain);
    for (;;) {
      const applied = await this.applyOnePage(peerDomain, callbacks);
      if (!applied) return; // another process owns the NOWAIT cursor lock

      // A data-bearing final page is not acknowledged at the source until we request once more with
      // its scannedThrough. Continue until the source returns a stable empty/no-advance final page.
      if (applied.hasMore || applied.scannedThrough > applied.requestedAfter) {
        continue;
      }

      const cursor = await this.readCursor(peerDomain);
      if (!cursor) return; // reset removed the peer while the request was in flight
      const advertised = this.advertised.get(peerDomain);
      if (advertised !== undefined && advertised > cursor.remoteHwm) {
        this.pending.delete(peerDomain);
        continue;
      }
      if (advertised !== undefined) this.advertised.delete(peerDomain);
      if (this.pending.delete(peerDomain)) continue;
      return;
    }
  }

  private async applyOnePage(
    peerDomain: string,
    callbacks: FederationMissedPullCallbacks,
  ): Promise<AppliedPage | null> {
    return this.database.db.transaction(async (tx) => {
      const lockResult = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${peerDomain}, 837421)) AS locked`,
      );
      if (!lockResult.rows[0]?.locked) return null;

      const [cursor] = await tx
        .select()
        .from(federationPullCursor)
        .where(eq(federationPullCursor.peerDomain, peerDomain))
        .limit(1);
      if (!cursor) return null;

      const page = await callbacks.fetch(cursor.remoteHwm);
      const scannedThrough = this.parseCursor(
        page.scannedThrough,
        'scannedThrough',
      );
      const allocatedThrough = this.parseCursor(
        page.allocatedThrough,
        'allocatedThrough',
      );
      if (
        scannedThrough < cursor.remoteHwm ||
        scannedThrough > allocatedThrough ||
        (page.hasMore && scannedThrough === cursor.remoteHwm)
      ) {
        throw new Error('peer returned an invalid missed page boundary');
      }

      let previousChangeId = cursor.remoteHwm;
      for (const item of page.messages) {
        const changeId = this.parseCursor(item.changeId, 'message.changeId');
        if (changeId <= previousChangeId || changeId > scannedThrough) {
          throw new Error('peer returned unordered missed messages');
        }
        previousChangeId = changeId;
      }

      await callbacks.apply(tx, page);
      await tx
        .update(federationPullCursor)
        .set({
          remoteHwm: scannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(federationPullCursor.peerDomain, peerDomain));
      return {
        requestedAfter: cursor.remoteHwm,
        scannedThrough,
        hasMore: page.hasMore,
      };
    });
  }

  private async readCursor(peerDomain: string) {
    return this.database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
      columns: { remoteHwm: true },
    });
  }

  private parseCursor(value: string, name: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`invalid ${name}`);
    }
    return BigInt(value);
  }
}
