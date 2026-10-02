import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace, profileNamespaceInfo } from '../database/schema.js';

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

/** Batch resolution result: cache answers plus the pairs whose rows were
 *  missing or expired. Callers forward the pending refreshes to
 *  ProfileNamespaceRefreshService; this store never performs network IO. */
export interface ProfileNamespaceResolution {
  entries: ProfileNamespaceResolvedEntry[];
  pendingRefreshes: PendingProfileNamespaceRefresh[];
}

const RESOLVE_BATCH_LIMIT = 100;

/** Local ProfileNamespaceInfo cache: batch resolution for clients and demand
 *  fills with tombstones. Answers from local rows only — the outbound
 *  refresh engine lives in ProfileNamespaceRefreshService, which keeps this
 *  store free of network dependencies (and the provider graph acyclic). */
@Injectable()
export class ProfileNamespaceInfoService {
  constructor(private readonly database: DatabaseService) {}

  /** Resolves a client batch. Direct rows (profileNamespaceId = 0) always
   *  answer synchronously from the authoritative IdentityNamespace row;
   *  third-party rows answer the cache and report a pending refresh when
   *  missing or expired — callers schedule those on the refresh engine. */
  async resolveBatch(
    pairs: ProfileNamespacePair[],
  ): Promise<ProfileNamespaceResolution> {
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
    return { entries, pendingRefreshes };
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
