import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { peerStateFeedPullCursor } from '../database/schema.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

export interface PeerStateFeedPullCallbacks {
  fetch(after?: bigint): Promise<PeerStateFeedPage>;
  apply(tx: DatabaseTransaction, page: PeerStateFeedPage): Promise<void>;
  afterCommit?(page: PeerStateFeedPage): Promise<void> | void;
}

@Injectable()
export class PeerStateFeedPullService {
  private readonly logger = new Logger(PeerStateFeedPullService.name);
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly advertised = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  advertise(peerDomain: string, rev: bigint): void {
    if (rev < 0n) throw new Error('state feed rev must be non-negative');
    const current = this.advertised.get(peerDomain);
    if (current === undefined || rev > current)
      this.advertised.set(peerDomain, rev);
  }

  run(
    peerDomain: string,
    callbacks: PeerStateFeedPullCallbacks,
  ): Promise<void> {
    this.pending.add(peerDomain);
    const active = this.running.get(peerDomain);
    if (active) return active;
    const task = this.loop(peerDomain, callbacks).finally(() => {
      this.running.delete(peerDomain);
      if (this.pending.has(peerDomain))
        queueMicrotask(
          () =>
            void this.run(peerDomain, callbacks).catch((e: unknown) =>
              this.logger.warn(
                `state drain failed for ${peerDomain}: ${(e as Error).message}`,
              ),
            ),
        );
    });
    this.running.set(peerDomain, task);
    return task;
  }

  private async loop(
    peerDomain: string,
    callbacks: PeerStateFeedPullCallbacks,
  ): Promise<void> {
    this.pending.delete(peerDomain);
    for (;;) {
      const applied = await this.applyOnePage(peerDomain, callbacks);
      if (!applied) return;
      if (!applied.page) continue;
      await callbacks.afterCommit?.(applied.page);
      if (applied.hasMore) continue;
      const cursor =
        await this.database.db.query.peerStateFeedPullCursor.findFirst({
          where: eq(peerStateFeedPullCursor.peerDomain, peerDomain),
          columns: { committedThrough: true },
        });
      if (!cursor) return;
      const advertised = this.advertised.get(peerDomain);
      if (advertised !== undefined && advertised > cursor.committedThrough)
        continue;
      if (advertised !== undefined) this.advertised.delete(peerDomain);
      if (this.pending.delete(peerDomain)) continue;
      return;
    }
  }

  private async applyOnePage(
    peerDomain: string,
    callbacks: PeerStateFeedPullCallbacks,
  ) {
    return this.database.db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${peerDomain}, 912774)) AS locked`,
      );
      if (!lock.rows[0]?.locked) return null;
      const [cursor] = await tx
        .select()
        .from(peerStateFeedPullCursor)
        .where(eq(peerStateFeedPullCursor.peerDomain, peerDomain))
        .limit(1);
      if (!cursor) return null;
      let page: PeerStateFeedPage;
      try {
        page = await callbacks.fetch(
          cursor.initialized ? cursor.committedThrough : undefined,
        );
      } catch (error) {
        if (!(error instanceof RemoteFeedCursorUnavailableError)) throw error;
        if (
          error.resumeAfter < 0n ||
          (cursor.initialized && error.resumeAfter === cursor.committedThrough)
        ) {
          throw new Error('peer returned an invalid state-feed resume cursor');
        }
        await tx
          .update(peerStateFeedPullCursor)
          .set({
            initialized: true,
            committedThrough: error.resumeAfter,
            updatedAt: new Date(),
          })
          .where(eq(peerStateFeedPullCursor.peerDomain, peerDomain));
        return {
          requestedAfter: cursor.committedThrough,
          scannedThrough: error.resumeAfter,
          hasMore: true,
          page: null,
        };
      }
      if (!cursor.initialized) {
        throw new Error('peer returned a state page without bootstrap cursor');
      }
      const scannedThrough = this.parseRev(
        page.scannedThrough,
        'scannedThrough',
      );
      const sourceEndId = this.parseRev(page.stateFeedEndId, 'stateFeedEndId');
      if (
        scannedThrough < cursor.committedThrough ||
        scannedThrough > sourceEndId ||
        (page.hasMore && scannedThrough === cursor.committedThrough)
      )
        throw new Error('peer returned an invalid state feed boundary');
      let previous = cursor.committedThrough;
      for (const item of page.items) {
        const feedId = this.parseRev(item.feedId, 'item.feedId');
        this.parseRev(item.revision, 'item.revision');
        if (feedId <= previous || feedId > scannedThrough)
          throw new Error('peer returned unordered state feed items');
        previous = feedId;
      }
      await callbacks.apply(tx, page);
      await tx
        .update(peerStateFeedPullCursor)
        .set({
          initialized: true,
          committedThrough: scannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(peerStateFeedPullCursor.peerDomain, peerDomain));
      return {
        requestedAfter: cursor.committedThrough,
        scannedThrough,
        hasMore: page.hasMore,
        page,
      };
    });
  }

  private parseRev(value: string, name: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`invalid ${name}`);
    return BigInt(value);
  }
}
