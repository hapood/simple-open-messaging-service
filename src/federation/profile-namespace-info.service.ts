import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace, profileNamespaceInfo } from '../database/schema.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';
import { TrailingSingleFlight } from '../../shared/trailing-single-flight.js';
import type { ProfileNamespaceBindings } from './profile-namespace-feed.service.js';

/** Client-facing coordinates are JSON numbers; the s2s wire keeps
 *  DecimalString. Overflow fails loudly rather than corrupting a cursor. */
function toClientFeedNumber(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric))
    throw new Error(
      `feed coordinate ${value.toString()} exceeds the client-safe integer range`,
    );
  return numeric;
}

export interface ProfileNamespacePair {
  publisherNamespaceId: number;
  profileNamespaceId: number;
}

export interface ProfileNamespaceResolvedEntry {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  /** Client-facing feed coordinate as a JSON number (safe-integer guarded);
   *  the s2s wire stays DecimalString. */
  updateFeedId: number;
  expired: boolean;
}

export interface PendingProfileNamespaceRefresh {
  pair: ProfileNamespacePair;
  triggerFeedId: bigint;
}

const RESOLVE_BATCH_LIMIT = 100;
const STALE_FETCH_MAX_ATTEMPTS = 3;

/** Local ProfileNamespaceInfo cache: batch resolution for clients, demand
 *  fills with tombstones, and per-(publisher, nsid) refresh with the
 *  stale-response guard. Avatar-request-shaped: coalescing per pair, in-flight
 *  deduplication, no business locks. */
@Injectable()
export class ProfileNamespaceInfoService {
  private readonly logger = new Logger(ProfileNamespaceInfoService.name);
  /** Per-pair refresh schedulers: joins concurrent triggers (max
   *  triggerFeedId) and runs one trailing refresh so a higher counter that
   *  lands mid-refresh is still observed without waiting for the next
   *  external wake. Entries are retired once a sequence settles. */
  private readonly refreshFlights = new Map<
    string,
    TrailingSingleFlight<bigint>
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly feed: ProfileNamespaceFeedService,
    private readonly sse: SseService,
  ) {}

  /** Resolves a client batch. Direct rows (profileNamespaceId = 0) always
   *  answer synchronously from the authoritative IdentityNamespace row;
   *  third-party rows answer the cache and schedule a background refresh when
   *  missing or expired. */
  async resolveBatch(
    pairs: ProfileNamespacePair[],
  ): Promise<ProfileNamespaceResolvedEntry[]> {
    const deduped = [
      ...new Map(pairs.map((pair) => [this.pairKey(pair), pair])).values(),
    ].slice(0, RESOLVE_BATCH_LIMIT);
    for (const pair of deduped) {
      if (
        !Number.isSafeInteger(pair.publisherNamespaceId) ||
        pair.publisherNamespaceId < 0 ||
        !Number.isSafeInteger(pair.profileNamespaceId) ||
        pair.profileNamespaceId < 0
      )
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'namespace pairs must be non-negative safe integers',
        );
    }
    const pendingRefreshes: PendingProfileNamespaceRefresh[] = [];
    const entries: ProfileNamespaceResolvedEntry[] = [];
    const cachePairs = deduped.filter((pair) => pair.profileNamespaceId !== 0);
    const cacheRows = cachePairs.length
      ? await this.database.db.execute<CacheRow>(sql`
          SELECT "publisherNamespaceId", "profileNamespaceId", domain,
                 "rootPublicKey", "updateFeedId", expired
          FROM "ProfileNamespaceInfo"
          WHERE ("publisherNamespaceId", "profileNamespaceId") IN (${sql.join(
            cachePairs.map(
              (pair) =>
                sql`(${pair.publisherNamespaceId}, ${pair.profileNamespaceId})`,
            ),
            sql`, `,
          )})
        `)
      : { rows: [] as CacheRow[] };
    const cacheByPair = new Map(
      cacheRows.rows.map((row) => [
        JSON.stringify([row.publisherNamespaceId, row.profileNamespaceId]),
        row,
      ]),
    );
    for (const pair of deduped) {
      if (pair.profileNamespaceId === 0) {
        entries.push(await this.resolveDirectRow(pair.publisherNamespaceId));
        continue;
      }
      const cached = cacheByPair.get(this.pairKey(pair));
      if (cached) {
        entries.push(this.entryOf(cached));
        if (cached.expired)
          pendingRefreshes.push({ pair, triggerFeedId: cached.updateFeedId });
        continue;
      }
      // Demand fill: insert the tomb first so the pair is visible to the
      // expiry matcher while the fetch is in flight.
      const tomb = await this.database.db
        .insert(profileNamespaceInfo)
        .values({
          publisherNamespaceId: pair.publisherNamespaceId,
          profileNamespaceId: pair.profileNamespaceId,
          domain: null,
          rootPublicKey: null,
          updateFeedId: 0n,
          expired: true,
        })
        .onConflictDoNothing()
        .returning();
      entries.push(
        tomb[0]
          ? this.entryOf(tomb[0])
          : {
              ...pair,
              domain: null,
              rootPublicKey: null,
              updateFeedId: 0,
              expired: true,
            },
      );
      pendingRefreshes.push({ pair, triggerFeedId: 0n });
    }
    for (const refresh of pendingRefreshes)
      this.scheduleRefresh(refresh.pair, refresh.triggerFeedId);
    return entries;
  }

  /** Seeds the handshake row for a freshly activated peer epoch: the
   *  hostname-verified domain and root, updateFeedId 0, not expired — the
   *  first feed pull refreshes the counter. */
  async seedDirectRowInTx(
    tx: DatabaseTransaction,
    publisherNamespaceId: number,
    domain: string,
    rootPublicKey: string,
  ): Promise<void> {
    await tx
      .insert(profileNamespaceInfo)
      .values({
        publisherNamespaceId,
        profileNamespaceId: 0,
        domain,
        rootPublicKey,
        updateFeedId: 0n,
        expired: false,
      })
      .onConflictDoUpdate({
        target: [
          profileNamespaceInfo.publisherNamespaceId,
          profileNamespaceInfo.profileNamespaceId,
        ],
        set: { domain, rootPublicKey, updateFeedId: 0n, expired: false },
      });
  }

  /** Refreshes one cached pair. Direct rows (nsid 0) rewrite from the local
   *  authoritative IdentityNamespace row; third-party rows pull the
   *  publisher's bindings query with the stale-response guard. Fire-and-forget
   *  safe: every caller may race, only one fetch per pair runs at a time. */
  scheduleRefresh(pair: ProfileNamespacePair, triggerFeedId: bigint): void {
    const key = this.pairKey(pair);
    let flight = this.refreshFlights.get(key);
    if (!flight) {
      flight = new TrailingSingleFlight<bigint>(
        (id) =>
          this.refresh(pair, id).catch((error: unknown) => {
            this.logger.warn(
              `profile namespace refresh failed for (${pair.publisherNamespaceId}, ${pair.profileNamespaceId}): ${(error as Error).message}`,
            );
          }),
        (a, b) => (a > b ? a : b),
      );
      this.refreshFlights.set(key, flight);
    }
    const sequence = flight.trigger(triggerFeedId);
    void sequence.finally(() => {
      // Retire the entry only if no new round started meanwhile; a running
      // sequence keeps its entry (a later trigger must join, not fork).
      if (this.refreshFlights.get(key) === flight && !flight.running)
        this.refreshFlights.delete(key);
    });
  }

  private async refresh(
    pair: ProfileNamespacePair,
    triggerFeedId: bigint,
  ): Promise<void> {
    if (pair.profileNamespaceId === 0) {
      await this.refreshDirectRow(pair.publisherNamespaceId);
      return;
    }
    for (let attempt = 1; attempt <= STALE_FETCH_MAX_ATTEMPTS; attempt += 1) {
      const answer = await this.fetchBindings(
        pair.publisherNamespaceId,
        pair.profileNamespaceId,
      );
      // Stale guard: a response whose disclosed feed end is behind the
      // triggering feedId describes the pre-change bindings and must never
      // persist as current.
      const end = BigInt(answer.profileNamespaceFeedEndId);
      if (end < triggerFeedId) continue;
      await this.database.db
        .insert(profileNamespaceInfo)
        .values({
          publisherNamespaceId: pair.publisherNamespaceId,
          profileNamespaceId: pair.profileNamespaceId,
          domain: answer.domain,
          rootPublicKey: answer.rootPublicKey,
          updateFeedId: end,
          expired: false,
        })
        .onConflictDoUpdate({
          target: [
            profileNamespaceInfo.publisherNamespaceId,
            profileNamespaceInfo.profileNamespaceId,
          ],
          set: {
            domain: answer.domain,
            rootPublicKey: answer.rootPublicKey,
            updateFeedId: end,
            expired: false,
          },
        });
      return;
    }
    throw new Error(
      `publisher kept serving bindings behind trigger ${triggerFeedId.toString()}`,
    );
  }

  private async refreshDirectRow(publisherNamespaceId: number): Promise<void> {
    const [row] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
        retiredAt: identityNamespace.retiredAt,
        pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, publisherNamespaceId))
      .limit(1);
    if (!row || row.retiredAt !== null || row.rootPublicKey === null)
      throw new Error(
        `publisher namespace ${publisherNamespaceId} has no authoritative binding`,
      );
    // updateFeedId aligns with the drain progress we have already applied, so
    // feed entries at or below it never re-expire this row. The converged
    // binding is a client-visible change: record it and wake devices, since
    // the drain that scheduled this refresh already expired their copies.
    const changeId = await this.database.db.transaction(async (tx) => {
      await tx
        .insert(profileNamespaceInfo)
        .values({
          publisherNamespaceId,
          profileNamespaceId: 0,
          domain: row.domain,
          rootPublicKey: row.rootPublicKey,
          updateFeedId: row.pulledThrough,
          expired: false,
        })
        .onConflictDoUpdate({
          target: [
            profileNamespaceInfo.publisherNamespaceId,
            profileNamespaceInfo.profileNamespaceId,
          ],
          set: {
            domain: row.domain,
            rootPublicKey: row.rootPublicKey,
            updateFeedId: row.pulledThrough,
            expired: false,
          },
        });
      return this.feed.recordClientChangeInTx(tx, {
        publisherNamespaceId,
        profileNamespaceId: 0,
      });
    });
    this.sse.notifyProfileNamespaceChange(changeId);
  }

  private async resolveDirectRow(
    publisherNamespaceId: number,
  ): Promise<ProfileNamespaceResolvedEntry> {
    const [row] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
        retiredAt: identityNamespace.retiredAt,
        pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, publisherNamespaceId))
      .limit(1);
    if (!row || row.retiredAt !== null || row.rootPublicKey === null)
      return {
        publisherNamespaceId,
        profileNamespaceId: 0,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 0,
        expired: true,
      };
    return {
      publisherNamespaceId,
      profileNamespaceId: 0,
      domain: row.domain,
      rootPublicKey: row.rootPublicKey,
      updateFeedId: toClientFeedNumber(row.pulledThrough),
      expired: false,
    };
  }

  private async fetchBindings(
    publisherNamespaceId: number,
    nsid: number,
  ): Promise<ProfileNamespaceBindings> {
    const [publisher] = await this.database.db
      .select({ domain: identityNamespace.domain })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, publisherNamespaceId))
      .limit(1);
    if (!publisher)
      throw new Error(`publisher namespace ${publisherNamespaceId} is unknown`);
    const context = await this.threadAccess.capturePeerResponseToken(
      publisher.domain,
    );
    try {
      return await this.trustedPeers.run(context.domain, () =>
        this.peerHttp.get<ProfileNamespaceBindings>(
          `/s2s/v1/profile-namespaces/${nsid}`,
          context.domain,
          64 * 1024,
        ),
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.NOT_FOUND
      ) {
        // A retired or unknown nsid stays a tomb: the identity is dead and
        // the expired marker keeps clients on the fallback rendering.
        throw new Error(`nsid ${nsid} is not bound at the publisher`);
      }
      throw error;
    }
  }

  private entryOf(row: CacheRow): ProfileNamespaceResolvedEntry {
    return {
      publisherNamespaceId: row.publisherNamespaceId,
      profileNamespaceId: row.profileNamespaceId,
      domain: row.domain,
      rootPublicKey: row.rootPublicKey,
      updateFeedId: toClientFeedNumber(row.updateFeedId),
      expired: row.expired,
    };
  }

  private pairKey(pair: ProfileNamespacePair): string {
    return JSON.stringify([pair.publisherNamespaceId, pair.profileNamespaceId]);
  }
}

type CacheRow = {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
};
