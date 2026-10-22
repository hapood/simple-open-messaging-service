import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

export interface PeerStateFeedPullCallbacks {
  fetch(after?: bigint, through?: bigint): Promise<PeerStateFeedPage>;
  apply(tx: DatabaseTransaction, page: PeerStateFeedPage): Promise<void>;
  afterCommit?(page: PeerStateFeedPage): Promise<void> | void;
  afterDrain?(through: bigint): Promise<void> | void;
}

@Injectable()
export class PeerStateFeedPullService {
  private readonly logger = new Logger(PeerStateFeedPullService.name);
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly advertised = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  advertise(peerDomain: string, namespaceId: number, rev: bigint): void {
    if (rev < 0n) throw new Error('state feed rev must be non-negative');
    const key = this.key(peerDomain, namespaceId);
    const current = this.advertised.get(key);
    if (current === undefined || rev > current) this.advertised.set(key, rev);
  }

  run(
    peerDomain: string,
    namespaceId: number,
    callbacks: PeerStateFeedPullCallbacks,
  ): Promise<void> {
    const key = this.key(peerDomain, namespaceId);
    this.pending.add(key);
    const active = this.running.get(key);
    if (active) return active;
    const task = this.loop(peerDomain, namespaceId, callbacks).finally(() => {
      this.running.delete(key);
      if (this.pending.has(key))
        queueMicrotask(
          () =>
            void this.run(peerDomain, namespaceId, callbacks).catch(
              (e: unknown) =>
                this.logger.warn(
                  `state drain failed for ${peerDomain}: ${(e as Error).message}`,
                ),
            ),
        );
    });
    this.running.set(key, task);
    return task;
  }

  private async loop(
    peerDomain: string,
    namespaceId: number,
    callbacks: PeerStateFeedPullCallbacks,
  ): Promise<void> {
    const key = this.key(peerDomain, namespaceId);
    this.pending.delete(key);
    let drainTarget: bigint | undefined;
    for (;;) {
      const applied = await this.applyOnePage(
        peerDomain,
        namespaceId,
        callbacks,
        drainTarget,
      );
      if (!applied) return;
      if ('cursorInitialized' in applied) continue;
      drainTarget ??= applied.sourceEndId;
      if (applied.hasMore) continue;
      if (applied.scannedThrough !== drainTarget)
        throw new Error('peer ended state drain before its fixed target');
      await callbacks.afterDrain?.(drainTarget);
      const pulledThrough = await this.readPulledThrough(
        peerDomain,
        namespaceId,
      );
      if (pulledThrough === undefined) return;
      const advertised = this.advertised.get(key);
      if (advertised !== undefined && advertised > pulledThrough) {
        drainTarget = undefined;
        continue;
      }
      if (advertised !== undefined) this.advertised.delete(key);
      if (this.pending.delete(key)) {
        drainTarget = undefined;
        continue;
      }
      return;
    }
  }

  /** The drain progress lives on the peer's epoch row; NULL means the feed was
   * never bootstrapped. */
  private async readPulledThrough(
    peerDomain: string,
    namespaceId: number,
  ): Promise<bigint | undefined> {
    const [row] = await this.database.db
      .select({ pulledThrough: identityNamespace.stateFeedPulledThrough })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no namespace row`);
    return row.pulledThrough ?? undefined;
  }

  private async applyOnePage(
    peerDomain: string,
    namespaceId: number,
    callbacks: PeerStateFeedPullCallbacks,
    through?: bigint,
  ) {
    const [epoch] = await this.database.db
      .select({
        pulledThrough: identityNamespace.stateFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    if (!epoch) return null;
    const initialized = epoch.pulledThrough !== null;
    const committedThrough = epoch.pulledThrough ?? 0n;

    let page: PeerStateFeedPage;
    try {
      page = await callbacks.fetch(
        initialized ? committedThrough : undefined,
        initialized ? through : undefined,
      );
    } catch (error) {
      if (!(error instanceof RemoteFeedCursorUnavailableError)) throw error;
      // Compaction preserves cursor validity within a namespace. A publisher
      // rejecting committed progress is an invariant violation, not a rebuild.
      if (initialized)
        throw new Error(
          `initialized state-feed cursor rejected by peer ${peerDomain} (namespace ${namespaceId}, committedThrough=${committedThrough}, resumeAfter=${error.resumeAfter}, resumeBefore=${error.resumeBefore}); progress retained`,
          { cause: error },
        );
      if (error.resumeAfter !== 0n || error.resumeBefore <= 0n)
        throw new Error('peer returned an invalid state-feed bootstrap cursor');
      await this.database.db.transaction(async (tx) => {
        await tx
          .update(identityNamespace)
          .set({
            stateFeedPulledThrough: error.resumeAfter,
          })
          .where(eq(identityNamespace.id, namespaceId));
      });
      this.logger.log(
        `initialized state-feed cursor for peer ${peerDomain} (namespace ${namespaceId}) at 0`,
      );
      return { cursorInitialized: true };
    }
    if (!initialized)
      throw new Error('peer returned a state page without bootstrap cursor');

    const scannedThrough = this.parseRev(page.scannedThrough, 'scannedThrough');
    const sourceEndId = this.parseRev(page.stateFeedEndId, 'stateFeedEndId');
    const scanEnd =
      through === undefined || sourceEndId < through ? sourceEndId : through;
    if (
      scannedThrough < committedThrough ||
      scannedThrough > scanEnd ||
      (page.hasMore && scannedThrough === committedThrough) ||
      page.hasMore !== scannedThrough < scanEnd
    )
      throw new Error('peer returned an invalid state feed boundary');

    let previous = committedThrough;
    const items = page.items.map((item) => {
      const feedId = this.parseRev(item.feedId, 'item.feedId');
      if (feedId <= previous || feedId > scannedThrough)
        throw new Error('peer returned unordered state feed items');
      previous = feedId;
      return { item, feedId };
    });

    for (const { item, feedId } of items) {
      const itemPage: PeerStateFeedPage = {
        ...page,
        items: [item],
        scannedThrough: item.feedId,
        hasMore: feedId < scanEnd,
      };
      const applied = await this.database.db.transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${peerDomain}:${namespaceId}`}, 912774)) AS locked`,
        );
        if (!lock.rows[0]?.locked)
          throw new Error('state-feed database single-flight is busy');
        const [current] = await tx
          .select({
            pulledThrough: identityNamespace.stateFeedPulledThrough,
          })
          .from(identityNamespace)
          .where(eq(identityNamespace.id, namespaceId))
          .limit(1);
        if (!current)
          throw new Error('state-feed pull namespace row disappeared');
        const currentThrough = current.pulledThrough ?? 0n;
        if (currentThrough >= feedId) return false;
        await callbacks.apply(tx, itemPage);
        await tx
          .update(identityNamespace)
          .set({
            stateFeedPulledThrough: feedId,
          })
          .where(eq(identityNamespace.id, namespaceId));
        return true;
      });
      if (applied) await callbacks.afterCommit?.(itemPage);
    }

    const appliedThrough = items.at(-1)?.feedId ?? committedThrough;
    await this.database.db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${peerDomain}:${namespaceId}`}, 912774)) AS locked`,
      );
      if (!lock.rows[0]?.locked)
        throw new Error('state-feed database single-flight is busy');
      const [current] = await tx
        .select({
          pulledThrough: identityNamespace.stateFeedPulledThrough,
        })
        .from(identityNamespace)
        .where(eq(identityNamespace.id, namespaceId))
        .limit(1);
      if (!current)
        throw new Error('state-feed pull namespace row disappeared');
      const currentThrough = current.pulledThrough ?? 0n;
      if (currentThrough < appliedThrough)
        throw new Error('state-feed item cursor did not commit');
      if (currentThrough >= scannedThrough) return;
      await tx
        .update(identityNamespace)
        .set({
          stateFeedPulledThrough: scannedThrough,
        })
        .where(eq(identityNamespace.id, namespaceId));
    });
    return {
      requestedAfter: committedThrough,
      scannedThrough,
      sourceEndId,
      hasMore: page.hasMore,
      page,
    };
  }

  private parseRev(value: string, name: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`invalid ${name}`);
    return BigInt(value);
  }

  private key(peerDomain: string, namespaceId: number): string {
    return JSON.stringify([peerDomain, namespaceId]);
  }
}
