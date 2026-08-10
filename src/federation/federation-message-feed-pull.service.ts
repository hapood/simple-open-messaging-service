import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { federationPullCursor } from '../database/schema.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

export interface FederationMessageFeedPullCallbacks {
  fetch(after: bigint): Promise<FederationMessageFeedPage>;
  /** Apply the complete page in the same transaction that advances remoteHwm. */
  apply(
    tx: DatabaseTransaction,
    page: FederationMessageFeedPage,
  ): Promise<void>;
  /** Runs only after the page transaction (including remoteHwm) committed successfully. */
  afterCommit?(page: FederationMessageFeedPage): Promise<void> | void;
}

interface AppliedPage {
  requestedAfter: bigint;
  scannedThrough: bigint;
  hasMore: boolean;
  page: FederationMessageFeedPage | null;
}

export class RemoteMessageFeedCursorResetError extends Error {
  constructor(
    public readonly startChangeId: bigint,
    public readonly availableCursor: bigint,
    public readonly allocatedThrough: bigint,
  ) {
    super('remote message-feed cursor floor advanced');
    this.name = 'RemoteMessageFeedCursorResetError';
  }
}

/**
 * Receiver-side global missed loop. The database cursor is the durable truth; running/pending only
 * coalesce wake-ups in this process. One cursor row lock covers the HTTP page and its local commit,
 * so another process fails NOWAIT instead of issuing a concurrent request to the same peer.
 */
@Injectable()
export class FederationMessageFeedPullService {
  private readonly logger = new Logger(FederationMessageFeedPullService.name);
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
    callbacks: FederationMessageFeedPullCallbacks,
  ): Promise<void> {
    this.pending.add(peerDomain);
    const current = this.running.get(peerDomain);
    if (current) return current;

    const task = this.loop(peerDomain, callbacks).finally(() => {
      this.running.delete(peerDomain);
      if (this.pending.has(peerDomain)) {
        queueMicrotask(() => {
          void this.run(peerDomain, callbacks).catch((error: unknown) => {
            // This continuation has no external caller to observe its promise. A malformed page or
            // transient apply failure must stop this drain, not become an unhandled rejection that
            // terminates the API process; the next HWM push/reconnect wake-up retries durably.
            this.logger.warn(
              `missed drain failed for ${peerDomain}: ${(error as Error).message}`,
            );
          });
        });
      }
    });
    this.running.set(peerDomain, task);
    return task;
  }

  private async loop(
    peerDomain: string,
    callbacks: FederationMessageFeedPullCallbacks,
  ): Promise<void> {
    this.pending.delete(peerDomain);
    for (;;) {
      const applied = await this.applyOnePage(peerDomain, callbacks);
      if (!applied) return; // another process owns the NOWAIT cursor lock

      if (applied.page) await callbacks.afterCommit?.(applied.page);

      // The source discarded an over-limit backlog and supplied a new floor. The local cursor reset
      // committed atomically below; immediately retry from that floor without publishing page effects.
      if (!applied.page) continue;

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
    callbacks: FederationMessageFeedPullCallbacks,
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

      let page: FederationMessageFeedPage;
      try {
        page = await callbacks.fetch(cursor.remoteHwm);
      } catch (error) {
        if (!(error instanceof RemoteMessageFeedCursorResetError)) throw error;
        if (
          error.startChangeId < cursor.startChangeId ||
          error.availableCursor < error.startChangeId ||
          error.availableCursor <= cursor.remoteHwm ||
          error.availableCursor > error.allocatedThrough
        ) {
          throw new Error('peer returned an invalid message-feed cursor reset');
        }
        await tx
          .update(federationPullCursor)
          .set({
            startChangeId: error.startChangeId,
            remoteHwm: error.availableCursor,
            updatedAt: new Date(),
          })
          .where(eq(federationPullCursor.peerDomain, peerDomain));
        this.logger.warn(
          `message-feed history for ${peerDomain} was truncated; resumed at ${error.availableCursor.toString()}`,
        );
        return {
          requestedAfter: cursor.remoteHwm,
          scannedThrough: error.availableCursor,
          hasMore: true,
          page: null,
        };
      }
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
        page,
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
