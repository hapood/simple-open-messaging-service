import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace, profileNamespace } from '../database/schema.js';
import { KeypairService } from './keypair.service.js';

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
  /** Lifecycle status of the bound namespace: ACTIVE (in use) or ARCHIVED
   *  (reset-retired, last bindings retained). UNRECOVERABLE is a separate
   *  federation error code, not an entry status. */
  status: NamespaceStatus;
}

export type NamespaceStatus = 'ACTIVE' | 'ARCHIVED';

/** Single-pair resolution result. READY carries the cached/authoritative
 *  binding (including an expired placeholder); PENDING means no local row
 *  exists — a tomb was planted and the caller must schedule a refresh,
 *  the client should wait for a wake (with a 30s re-request timeout). */
export type ProfileNamespaceResolution =
  | { status: 'READY'; entry: ProfileNamespaceResolvedEntry }
  | { status: 'PENDING' };

/** Local ProfileNamespace cache: single-pair resolution for clients and
 *  demand fills with tombstones. Answers from local rows only — the outbound
 *  refresh engine lives in ProfileNamespaceRefreshService, which keeps this
 *  store free of network dependencies (and the provider graph acyclic). */
@Injectable()
export class ProfileNamespaceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  /** Resolves one pair. A profileNamespaceId is meaningful only inside its
   *  publisher's namespace space, so the routing splits on the publisher:
   *  publisher 0 is this server itself — the pair (0, nsid) answers
   *  synchronously and authoritatively ((0, 0) from the keypair snapshot,
   *  positive nsids from our IdentityNamespace registry) and can never be
   *  PENDING. Any other publisher answers the ProfileNamespace cache when
   *  present (READY, even if expired) and answers PENDING when absent — the
   *  caller plants a tomb and schedules a refresh against the publisher so a
   *  client re-resolves on the next wake. */
  async resolveOne(
    pair: ProfileNamespacePair,
  ): Promise<ProfileNamespaceResolution> {
    if (
      !Number.isSafeInteger(pair.publisherNamespaceId) ||
      pair.publisherNamespaceId < 0 ||
      !Number.isSafeInteger(pair.profileNamespaceId) ||
      pair.profileNamespaceId < 0
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'namespace pair must be non-negative safe integers',
      );
    if (pair.publisherNamespaceId === 0)
      return {
        status: 'READY',
        entry: await this.resolveLocalRow(pair.profileNamespaceId),
      };
    const rows = await this.database.db
      .select({
        publisherNamespaceId: profileNamespace.publisherNamespaceId,
        profileNamespaceId: profileNamespace.profileNamespaceId,
        domain: profileNamespace.domain,
        rootPublicKey: profileNamespace.rootPublicKey,
        updateFeedId: profileNamespace.updateFeedId,
        expired: profileNamespace.expired,
        status: profileNamespace.status,
      })
      .from(profileNamespace)
      .where(
        and(
          eq(profileNamespace.publisherNamespaceId, pair.publisherNamespaceId),
          eq(profileNamespace.profileNamespaceId, pair.profileNamespaceId),
        ),
      )
      .limit(1);
    const cached = rows[0];
    if (cached) return { status: 'READY', entry: this.entryOf(cached) };
    // Demand fill: insert the tomb first so the pair is visible to the
    // expiry matcher while the fetch is in flight.
    await this.database.db
      .insert(profileNamespace)
      .values({
        publisherNamespaceId: pair.publisherNamespaceId,
        profileNamespaceId: pair.profileNamespaceId,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 0n,
        expired: true,
      })
      .onConflictDoNothing();
    return { status: 'PENDING' };
  }

  /** Seeds the handshake row for a freshly activated peer epoch: the
   *  hostname-verified domain and root, updateFeedId 0, not expired, ACTIVE
   *  — the first feed pull refreshes the counter. */
  async seedDirectRowInTx(
    tx: DatabaseTransaction,
    publisherNamespaceId: number,
    domain: string,
    rootPublicKey: string,
  ): Promise<void> {
    await tx
      .insert(profileNamespace)
      .values({
        publisherNamespaceId,
        profileNamespaceId: 0,
        domain,
        rootPublicKey,
        updateFeedId: 0n,
        expired: false,
        status: 'ACTIVE',
      })
      .onConflictDoUpdate({
        target: [
          profileNamespace.publisherNamespaceId,
          profileNamespace.profileNamespaceId,
        ],
        set: {
          domain,
          rootPublicKey,
          updateFeedId: 0n,
          expired: false,
          status: 'ACTIVE',
        },
      });
  }

  /** Answers a pair in this server's own namespace space: nsid 0 is the
   *  server itself (real domain + claimable root from the keypair snapshot —
   *  the local profile namespace is identified by namespace id 0 and uses the
   *  configured IdentityNamespace domain; it is never represented by a sentinel).
   *  No remote fetch is ever involved. */
  private async resolveLocalRow(
    profileNamespaceId: number,
  ): Promise<ProfileNamespaceResolvedEntry> {
    // Read the feed end BEFORE the bindings: a change committing between the
    // two reads then has feedId > end and still expires this answer on the
    // client, while the reverse order could stamp pre-change data as fresh
    // forever (the client guard never regresses updateFeedId).
    const end = await this.readLocalFeedEnd();
    if (profileNamespaceId === 0) {
      const local = await this.database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, 0),
        columns: { domain: true },
      });
      if (!local) throw new Error('local identity namespace is missing');
      return {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        domain: local.domain,
        rootPublicKey: this.keypair.getRootPublicKeyB64(),
        updateFeedId: end,
        expired: false,
        status: 'ACTIVE',
      };
    }
    const [row] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
        retiredAt: identityNamespace.retiredAt,
        active: identityNamespace.active,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, profileNamespaceId))
      .limit(1);
    const status: NamespaceStatus =
      row && row.active && row.retiredAt === null ? 'ACTIVE' : 'ARCHIVED';
    if (!row || row.retiredAt !== null || row.rootPublicKey === null)
      return {
        publisherNamespaceId: 0,
        profileNamespaceId,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 0,
        expired: true,
        status,
      };
    return {
      publisherNamespaceId: 0,
      profileNamespaceId,
      domain: row.domain,
      rootPublicKey: row.rootPublicKey,
      updateFeedId: end,
      expired: false,
      status,
    };
  }

  /** The publisher-feed coordinate of this server's own space: row 0 carries
   *  the per-server feed allocator head, which bounds every change id this
   *  server may have allocated so far. */
  private async readLocalFeedEnd(): Promise<number> {
    const [head] = await this.database.db
      .select({ feedEndId: identityNamespace.profileNamespaceFeedEndId })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, 0))
      .limit(1);
    if (!head) throw new Error('local namespace sentinel row is missing');
    return toClientFeedNumber(head.feedEndId);
  }

  private entryOf(row: CacheRow): ProfileNamespaceResolvedEntry {
    return {
      publisherNamespaceId: row.publisherNamespaceId,
      profileNamespaceId: row.profileNamespaceId,
      domain: row.domain,
      rootPublicKey: row.rootPublicKey,
      updateFeedId: toClientFeedNumber(row.updateFeedId),
      expired: row.expired,
      status: row.status as NamespaceStatus,
    };
  }
}

type CacheRow = {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
  status: string;
};
