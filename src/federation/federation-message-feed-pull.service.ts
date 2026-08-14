import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federationPullCursor,
  peerStateFeedPullCursor,
} from '../database/schema.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

export interface FederationMessageFeedPullCallbacks {
  fetch(after?: bigint, through?: bigint): Promise<FederationMessageFeedPage>;
  /** Apply the complete page in the same transaction that advances committedThrough. */
  apply(
    tx: DatabaseTransaction,
    page: FederationMessageFeedPage,
  ): Promise<void>;
  /** Runs only after the page transaction (including committedThrough) committed successfully. */
  afterCommit?(page: FederationMessageFeedPage): Promise<void> | void;
}

interface AppliedPage {
  requestedAfter: bigint;
  scannedThrough: bigint;
  hasMore: boolean;
  page: FederationMessageFeedPage | null;
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
  private readonly requiredState = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  /** Coalesce an ephemeral push/HWM observation. Recovery sends a fresh wake-up after restart. */
  advertise(
    peerDomain: string,
    allocatedThrough: bigint,
    requiredStateRevision = 0n,
  ): void {
    if (allocatedThrough < 0n)
      throw new Error('advertised HWM must be non-negative');
    const current = this.advertised.get(peerDomain);
    if (current === undefined || allocatedThrough > current) {
      this.advertised.set(peerDomain, allocatedThrough);
      this.requiredState.set(peerDomain, requiredStateRevision);
    } else if (allocatedThrough === current) {
      const state = this.requiredState.get(peerDomain) ?? 0n;
      if (requiredStateRevision > state) {
        this.requiredState.set(peerDomain, requiredStateRevision);
      }
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
              `message-feed drain failed for ${peerDomain}: ${(error as Error).message}`,
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

      // A valid 50019 reset is committed atomically by applyOnePage. Retry immediately from the
      // supplied floor without applying or publishing a synthetic page.
      if (!applied.page) continue;

      if (applied.hasMore) continue;

      const cursor = await this.readCursor(peerDomain);
      if (!cursor) return; // reset removed the peer while the request was in flight
      const advertised = this.advertised.get(peerDomain);
      if (advertised !== undefined && advertised > cursor.committedThrough) {
        this.pending.delete(peerDomain);
        continue;
      }
      if (advertised !== undefined) this.advertised.delete(peerDomain);
      this.requiredState.delete(peerDomain);
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

      const advertised = this.advertised.get(peerDomain);
      const requiredState = this.requiredState.get(peerDomain) ?? 0n;
      if (advertised !== undefined && requiredState > 0n) {
        const [stateCursor] = await tx
          .select({
            committedThrough: peerStateFeedPullCursor.committedThrough,
          })
          .from(peerStateFeedPullCursor)
          .where(eq(peerStateFeedPullCursor.peerDomain, peerDomain))
          .limit(1);
        if (!stateCursor || stateCursor.committedThrough < requiredState)
          return null;
      }
      const trunc =
        cursor.initialized &&
        advertised !== undefined &&
        advertised >= cursor.committedThrough
          ? advertised
          : undefined;
      let page: FederationMessageFeedPage;
      try {
        page = await callbacks.fetch(
          cursor.initialized ? cursor.committedThrough : undefined,
          trunc,
        );
      } catch (error) {
        if (!(error instanceof RemoteFeedCursorUnavailableError)) throw error;
        if (error.resumeAfter < 0n) {
          throw new Error(
            'peer returned a negative message-feed resume cursor',
          );
        }
        if (
          cursor.initialized &&
          error.resumeAfter === cursor.committedThrough
        ) {
          throw new Error('peer returned an invalid message-feed cursor reset');
        }
        await tx
          .update(federationPullCursor)
          .set({
            initialized: true,
            retainedAfter: error.resumeAfter,
            committedThrough: error.resumeAfter,
            updatedAt: new Date(),
          })
          .where(eq(federationPullCursor.peerDomain, peerDomain));
        this.logger.warn(
          cursor.initialized
            ? `message-feed history for ${peerDomain} is unavailable before ${error.resumeAfter.toString()}; resumed from that cursor`
            : `initialized message-feed cursor for ${peerDomain} at ${error.resumeAfter.toString()}`,
        );
        return {
          requestedAfter: cursor.committedThrough,
          scannedThrough: error.resumeAfter,
          hasMore: true,
          page: null,
        };
      }
      if (!cursor.initialized) {
        throw new Error(
          'peer returned a message page without bootstrap cursor',
        );
      }
      const scannedThrough = this.parseCursor(
        page.scannedThrough,
        'scannedThrough',
      );
      const sourceEnd = this.parseCursor(
        page.messageFeedEndId,
        'messageFeedEndId',
      );
      if (scannedThrough < cursor.committedThrough) {
        throw new Error('peer returned an invalid message-feed page boundary');
      }
      if (
        scannedThrough > sourceEnd ||
        (!page.hasMore &&
          scannedThrough !==
            (trunc === undefined || trunc > sourceEnd ? sourceEnd : trunc))
      )
        throw new Error('peer returned an inconsistent message-feed end');

      let previousFeedId = cursor.committedThrough;
      for (const item of page.items) {
        const feedId = this.parseCursor(item.feedId, 'item.feedId');
        if (feedId <= previousFeedId || feedId > scannedThrough) {
          throw new Error('peer returned unordered message-feed items');
        }
        previousFeedId = feedId;
      }

      await callbacks.apply(tx, page);
      await tx
        .update(federationPullCursor)
        .set({
          initialized: true,
          committedThrough: scannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(federationPullCursor.peerDomain, peerDomain));
      return {
        requestedAfter: cursor.committedThrough,
        scannedThrough,
        hasMore: page.hasMore,
        page,
      };
    });
  }

  private async readCursor(peerDomain: string) {
    return this.database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
      columns: { committedThrough: true },
    });
  }

  private parseCursor(value: string, name: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`invalid ${name}`);
    }
    return BigInt(value);
  }
}
