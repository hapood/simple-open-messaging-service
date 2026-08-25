import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federationTombstonePullCursor,
  peerStateFeedPullCursor,
} from '../database/schema.js';
import type { FederationMessageTombstonePage } from './federation-message-tombstone-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

export interface FederationMessageTombstonePullCallbacks {
  fetch(
    after?: bigint,
    through?: bigint,
  ): Promise<FederationMessageTombstonePage>;
  apply(
    tx: DatabaseTransaction,
    page: FederationMessageTombstonePage,
  ): Promise<void>;
  afterCommit?(page: FederationMessageTombstonePage): Promise<void> | void;
}

@Injectable()
export class FederationMessageTombstonePullService {
  private readonly logger = new Logger(
    FederationMessageTombstonePullService.name,
  );
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly advertised = new Map<string, bigint>();
  private readonly requiredState = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  advertise(peerDomain: string, hwm: bigint, requiredStateRevision = 0n): void {
    const current = this.advertised.get(peerDomain);
    if (current === undefined || hwm > current) {
      this.advertised.set(peerDomain, hwm);
      this.requiredState.set(peerDomain, requiredStateRevision);
    } else if (hwm === current) {
      const state = this.requiredState.get(peerDomain) ?? 0n;
      if (requiredStateRevision > state)
        this.requiredState.set(peerDomain, requiredStateRevision);
    }
  }

  run(
    peerDomain: string,
    callbacks: FederationMessageTombstonePullCallbacks,
  ): Promise<void> {
    this.pending.add(peerDomain);
    const current = this.running.get(peerDomain);
    if (current) return current;
    const task = this.loop(peerDomain, callbacks).finally(() => {
      this.running.delete(peerDomain);
      if (this.pending.has(peerDomain)) {
        queueMicrotask(() => {
          void this.run(peerDomain, callbacks).catch((error: unknown) =>
            this.logger.warn(
              `tombstone drain failed for ${peerDomain}: ${(error as Error).message}`,
            ),
          );
        });
      }
    });
    this.running.set(peerDomain, task);
    return task;
  }

  private async loop(
    peerDomain: string,
    callbacks: FederationMessageTombstonePullCallbacks,
  ): Promise<void> {
    this.pending.delete(peerDomain);
    for (;;) {
      const applied = await this.applyOne(peerDomain, callbacks);
      if (!applied) return;
      if ('cursorReset' in applied) continue;
      await callbacks.afterCommit?.(applied.page);
      if (applied.hasMore) continue;
      const cursor =
        await this.database.db.query.federationTombstonePullCursor.findFirst({
          where: eq(federationTombstonePullCursor.peerDomain, peerDomain),
          columns: { committedThrough: true },
        });
      if (!cursor) return;
      const advertised = this.advertised.get(peerDomain);
      if (advertised !== undefined && advertised > cursor.committedThrough)
        continue;
      this.advertised.delete(peerDomain);
      this.requiredState.delete(peerDomain);
      if (this.pending.delete(peerDomain)) continue;
      return;
    }
  }

  private async applyOne(
    peerDomain: string,
    callbacks: FederationMessageTombstonePullCallbacks,
  ) {
    return this.database.db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${peerDomain}, 837422)) AS locked`,
      );
      if (!lock.rows[0]?.locked) return null;
      const [cursor] = await tx
        .select()
        .from(federationTombstonePullCursor)
        .where(eq(federationTombstonePullCursor.peerDomain, peerDomain))
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
      let page: FederationMessageTombstonePage;
      try {
        page = await callbacks.fetch(
          cursor.initialized ? cursor.committedThrough : undefined,
          trunc,
        );
      } catch (error) {
        if (!(error instanceof RemoteFeedCursorUnavailableError)) throw error;
        if (
          error.resumeAfter < 0n ||
          (cursor.initialized && error.resumeAfter === cursor.committedThrough)
        ) {
          throw new Error(
            'peer returned an invalid tombstone-feed resume cursor',
          );
        }
        this.logger.warn(
          `tombstone-feed cursor for peer ${peerDomain} is unavailable; resuming from ${error.resumeAfter.toString()}`,
        );
        await tx
          .update(federationTombstonePullCursor)
          .set({
            initialized: true,
            committedThrough: error.resumeAfter,
            updatedAt: new Date(),
          })
          .where(eq(federationTombstonePullCursor.peerDomain, peerDomain));
        return {
          cursorReset: true,
        };
      }
      if (!cursor.initialized) {
        throw new Error(
          'peer returned a tombstone page without bootstrap cursor',
        );
      }
      const scannedThrough = this.parse(page.scannedThrough);
      const sourceEnd = this.parse(page.tombstoneFeedEndId);
      if (scannedThrough < cursor.committedThrough) {
        throw new Error('peer returned a regressing tombstone cursor');
      }
      if (
        scannedThrough > sourceEnd ||
        (!page.hasMore &&
          scannedThrough !==
            (trunc === undefined || trunc > sourceEnd ? sourceEnd : trunc))
      )
        throw new Error('peer returned an inconsistent tombstone-feed end');
      let previous = cursor.committedThrough;
      for (const tombstone of page.items) {
        const feedId = this.parse(tombstone.feedId);
        if (feedId <= previous || feedId > scannedThrough) {
          throw new Error('peer returned unordered tombstones');
        }
        previous = feedId;
      }
      await callbacks.apply(tx, page);
      await tx
        .update(federationTombstonePullCursor)
        .set({
          initialized: true,
          committedThrough: scannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(federationTombstonePullCursor.peerDomain, peerDomain));
      return {
        requestedAfter: cursor.committedThrough,
        scannedThrough,
        hasMore: page.hasMore,
        page,
      };
    });
  }

  private parse(value: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('invalid cursor');
    return BigInt(value);
  }
}
