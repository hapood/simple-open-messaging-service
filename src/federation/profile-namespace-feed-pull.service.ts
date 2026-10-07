import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import type { ProfileNamespaceFeedPage } from './profile-namespace-feed.service.js';
import type { ProfileNamespaceItemEffect } from './profile-namespace-feed-consumer.service.js';

export interface ProfileNamespaceFeedPullCallbacks {
  fetch(after?: bigint, through?: bigint): Promise<ProfileNamespaceFeedPage>;
  apply(
    tx: DatabaseTransaction,
    item: ProfileNamespaceFeedPage['items'][number],
  ): Promise<ProfileNamespaceItemEffect>;
  afterCommit?(item: ProfileNamespaceItemEffect): Promise<void> | void;
}

/** Bounded drain engine for the Profile Namespace Feed, mirroring
 *  PeerStateFeedPullService. Differences from the State Feed engine: the
 *  progress column defaults to 0 (no NULL bootstrap marker — a fresh puller
 *  simply starts at 0, equivalent to the wire's omitted-after form), and the
 *  feed defines no cursor-unavailable recovery. */
@Injectable()
export class ProfileNamespaceFeedPullService {
  private static readonly LOCK_SALT = 770664;

  private readonly logger = new Logger(ProfileNamespaceFeedPullService.name);
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly advertised = new Map<string, bigint>();

  constructor(private readonly database: DatabaseService) {}

  advertise(peerDomain: string, namespaceId: number, rev: bigint): void {
    if (rev < 0n)
      throw new Error('profile namespace feed rev must be non-negative');
    const key = this.key(peerDomain, namespaceId);
    const current = this.advertised.get(key);
    if (current === undefined || rev > current) this.advertised.set(key, rev);
  }

  run(
    peerDomain: string,
    namespaceId: number,
    callbacks: ProfileNamespaceFeedPullCallbacks,
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
                  `profile namespace drain failed for ${peerDomain}: ${(e as Error).message}`,
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
    callbacks: ProfileNamespaceFeedPullCallbacks,
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
      drainTarget ??= applied.sourceEndId;
      if (applied.hasMore) continue;
      if (applied.scannedThrough !== drainTarget)
        throw new Error(
          'peer ended profile namespace drain before its fixed target',
        );
      const pulledThrough = await this.readPulledThrough(namespaceId);
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

  private async readPulledThrough(
    namespaceId: number,
  ): Promise<bigint | undefined> {
    const [row] = await this.database.db
      .select({
        pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    if (!row) return undefined;
    return row.pulledThrough;
  }

  private async applyOnePage(
    peerDomain: string,
    namespaceId: number,
    callbacks: ProfileNamespaceFeedPullCallbacks,
    through?: bigint,
  ) {
    const [epoch] = await this.database.db
      .select({
        pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    if (!epoch) return null;
    const committedThrough = epoch.pulledThrough;

    // Cursor 0 is a legal exclusive bound; the wire's omitted-after form is a
    // first-pull convenience for consumers without a coordinate, not a state
    // this engine can be in.
    const page = await callbacks.fetch(committedThrough, through);
    const scannedThrough = this.parseRev(page.scannedThrough, 'scannedThrough');
    const sourceEndId = this.parseRev(page.feedEndId, 'feedEndId');
    const scanEnd =
      through === undefined || sourceEndId < through ? sourceEndId : through;
    if (
      scannedThrough < committedThrough ||
      scannedThrough > scanEnd ||
      (page.hasMore && scannedThrough === committedThrough) ||
      page.hasMore !== scannedThrough < scanEnd
    )
      throw new Error(
        'peer returned an invalid profile namespace feed boundary',
      );

    let previous = committedThrough;
    const items = page.items.map((item) => {
      const feedId = this.parseRev(item.feedId, 'item.feedId');
      if (feedId <= previous || feedId > scannedThrough)
        throw new Error('peer returned unordered profile namespace feed items');
      previous = feedId;
      return { item, feedId };
    });

    for (const { item } of items) {
      const applied = await this.database.db.transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${peerDomain}:${namespaceId}`}, ${ProfileNamespaceFeedPullService.LOCK_SALT})) AS locked`,
        );
        if (!lock.rows[0]?.locked)
          throw new Error('profile namespace feed single-flight is busy');
        const [current] = await tx
          .select({
            pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
            observedEndId: identityNamespace.profileNamespaceFeedEndId,
          })
          .from(identityNamespace)
          .where(eq(identityNamespace.id, namespaceId))
          .limit(1);
        if (!current)
          throw new Error('profile namespace pull namespace row disappeared');
        if (current.pulledThrough >= this.parseRev(item.feedId, 'item.feedId'))
          return null;
        const effect = await callbacks.apply(tx, item);
        await tx
          .update(identityNamespace)
          .set({
            profileNamespaceFeedEndId:
              sourceEndId > current.observedEndId
                ? sourceEndId
                : current.observedEndId,
            profileNamespaceFeedPulledThrough: this.parseRev(
              item.feedId,
              'item.feedId',
            ),
          })
          .where(eq(identityNamespace.id, namespaceId));
        return effect;
      });
      if (applied) await callbacks.afterCommit?.(applied);
    }

    const appliedThrough = items.at(-1)?.feedId ?? committedThrough;
    await this.database.db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${peerDomain}:${namespaceId}`}, ${ProfileNamespaceFeedPullService.LOCK_SALT})) AS locked`,
      );
      if (!lock.rows[0]?.locked)
        throw new Error('profile namespace feed single-flight is busy');
      const [current] = await tx
        .select({
          pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
          observedEndId: identityNamespace.profileNamespaceFeedEndId,
        })
        .from(identityNamespace)
        .where(eq(identityNamespace.id, namespaceId))
        .limit(1);
      if (!current)
        throw new Error('profile namespace pull namespace row disappeared');
      if (current.pulledThrough < appliedThrough)
        throw new Error('profile namespace item cursor did not commit');
      if (current.pulledThrough >= scannedThrough) {
        if (current.observedEndId >= sourceEndId) return;
        await tx
          .update(identityNamespace)
          .set({ profileNamespaceFeedEndId: sourceEndId })
          .where(eq(identityNamespace.id, namespaceId));
        return;
      }
      await tx
        .update(identityNamespace)
        .set({
          profileNamespaceFeedEndId:
            sourceEndId > current.observedEndId
              ? sourceEndId
              : current.observedEndId,
          profileNamespaceFeedPulledThrough: scannedThrough,
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
