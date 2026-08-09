import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { peerStateFeedPullCursor } from '../database/schema.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

export interface PeerStateFeedPullCallbacks {
  fetch(after: bigint): Promise<PeerStateFeedPage>;
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
      await callbacks.afterCommit?.(applied.page);
      if (applied.hasMore || applied.scannedThrough > applied.requestedAfter)
        continue;
      const cursor =
        await this.database.db.query.peerStateFeedPullCursor.findFirst({
          where: eq(peerStateFeedPullCursor.peerDomain, peerDomain),
          columns: { remoteHwm: true },
        });
      if (!cursor) return;
      const advertised = this.advertised.get(peerDomain);
      if (advertised !== undefined && advertised > cursor.remoteHwm) continue;
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
      const page = await callbacks.fetch(cursor.remoteHwm);
      const scannedThrough = this.parseRev(
        page.scannedThrough,
        'scannedThrough',
      );
      const sourceRev = this.parseRev(page.stateFeedRev, 'stateFeedRev');
      if (
        scannedThrough < cursor.remoteHwm ||
        scannedThrough > sourceRev ||
        (page.hasMore && scannedThrough === cursor.remoteHwm)
      )
        throw new Error('peer returned an invalid state feed boundary');
      let previous = cursor.remoteHwm;
      for (const item of page.items) {
        const rev = this.parseRev(item.rev, 'item.rev');
        this.parseRev(item.revision, 'item.revision');
        if (rev <= previous || rev > scannedThrough)
          throw new Error('peer returned unordered state feed items');
        previous = rev;
      }
      await callbacks.apply(tx, page);
      await tx
        .update(peerStateFeedPullCursor)
        .set({ remoteHwm: scannedThrough, updatedAt: new Date() })
        .where(eq(peerStateFeedPullCursor.peerDomain, peerDomain));
      return {
        requestedAfter: cursor.remoteHwm,
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
