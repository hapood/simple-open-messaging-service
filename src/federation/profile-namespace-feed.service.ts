import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { STATE_FEED_PAGE_MAX_BYTES } from '../common/feed-page.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  identityNamespace,
  profileNamespaceChangeFeed,
  profileNamespaceChangeFeedHead,
  profileNamespaceFeed,
} from '../database/schema.js';
import { loadFederationConfig } from './federation.config.js';
import { KeypairService } from './keypair.service.js';

export interface ProfileNamespaceFeedItem {
  namespaceId: number;
  feedId: string;
}

export interface ProfileNamespaceFeedPage {
  items: ProfileNamespaceFeedItem[];
  scannedThrough: string;
  feedEndId: string;
  hasMore: boolean;
}

export interface ProfileNamespaceBindings {
  domain: string;
  rootPublicKey: string;
  profileNamespaceFeedEndId: string;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;
/** Row 0 is the reserved local namespace: the sentinel for "the publisher
 *  itself" and the carrier of the per-server Profile Namespace Feed
 *  allocator. */
const LOCAL_NAMESPACE_ID = 0;

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

/** Publisher side of the Profile Namespace Feed: the shared compacted record
 *  of identity-namespace binding changes (root replacement, domain re-bind,
 *  new namespace item). Consumer-side expiry lives in the pull service. */
@Injectable()
export class ProfileNamespaceFeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  /** Publishes one binding change of `namespaceId` by allocating the next
   *  feed position from the row-0 allocator and upserting the nsid's
   *  compacted item. MUST run in the same transaction as the identity
   *  mutation it publishes. The allocator row is a terminal lock: callers
   *  must already hold every business lock they need. */
  async recordNamespaceChangeInTx(
    tx: DatabaseTransaction,
    namespaceId: number,
  ): Promise<bigint> {
    if (
      !Number.isSafeInteger(namespaceId) ||
      namespaceId < LOCAL_NAMESPACE_ID
    ) {
      throw new Error('namespace id must be a non-negative safe integer');
    }
    const [allocated] = await tx
      .update(identityNamespace)
      .set({
        profileNamespaceFeedEndId: sql`${identityNamespace.profileNamespaceFeedEndId} + 1`,
      })
      .where(eq(identityNamespace.id, LOCAL_NAMESPACE_ID))
      .returning({ feedId: identityNamespace.profileNamespaceFeedEndId });
    if (!allocated) {
      throw new Error('local namespace sentinel row is missing');
    }
    await tx
      .insert(profileNamespaceFeed)
      .values({ namespaceId, feedId: allocated.feedId })
      .onConflictDoUpdate({
        target: profileNamespaceFeed.namespaceId,
        set: { feedId: allocated.feedId, updatedAt: new Date() },
      });
    return allocated.feedId;
  }

  /** The publisher-wide feed end (row-0 allocator value). The sentinel row
   *  is created by the base migration and never deleted; a missing row is a
   *  corrupted invariant and fails loudly instead of answering 0. */
  async readFeedEndId(): Promise<bigint> {
    const [row] = await this.database.db
      .select({ feedEndId: identityNamespace.profileNamespaceFeedEndId })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, LOCAL_NAMESPACE_ID))
      .limit(1);
    if (!row) throw new Error('local namespace sentinel row is missing');
    return row.feedEndId;
  }

  /** Serves one page of the shared compacted feed. An omitted `after`
   *  triggers the sender-side zero fallback defined by the spec: serve every
   *  current item from 0 together with the current feed end, so a first-time
   *  puller initializes its cursor directly from the response. */
  /** Records one client-visible binding change: allocates the next change
   *  position from the single-row head and upserts the pair's compacted
   *  item. MUST run in the same transaction as the ProfileNamespaceInfo /
   *  IdentityNamespace mutation it publishes, and callers must already hold
   *  every business lock (the head row is a terminal lock). Returns the
   *  allocated position so orchestrators can broadcast a wake after commit. */
  async recordClientChangeInTx(
    tx: DatabaseTransaction,
    pair: { publisherNamespaceId: number; profileNamespaceId: number },
  ): Promise<bigint> {
    const [head] = await tx
      .select({ endId: profileNamespaceChangeFeedHead.endId })
      .from(profileNamespaceChangeFeedHead)
      .where(eq(profileNamespaceChangeFeedHead.id, 0))
      .for('update')
      .limit(1);
    if (!head) throw new Error('profile namespace change head row is missing');
    const changeId = head.endId + 1n;
    await tx
      .insert(profileNamespaceChangeFeedHead)
      .values({ id: 0, endId: changeId })
      .onConflictDoUpdate({
        target: profileNamespaceChangeFeedHead.id,
        set: { endId: changeId },
      });
    await tx
      .insert(profileNamespaceChangeFeed)
      .values({
        publisherNamespaceId: pair.publisherNamespaceId,
        profileNamespaceId: pair.profileNamespaceId,
        changeId,
      })
      .onConflictDoUpdate({
        target: [
          profileNamespaceChangeFeed.publisherNamespaceId,
          profileNamespaceChangeFeed.profileNamespaceId,
        ],
        set: { changeId, updatedAt: sql`now()` },
      });
    return changeId;
  }

  /** Serves the merged client changelog: compacted (pair, changeId) items
   *  after a cursor, plus the current head. Items carry no binding data — a
   *  client applies them as expiry/tomb facts and converges the data through
   *  profile-namespaces/resolve. Client-facing coordinates are JSON numbers
   *  (safe-integer guarded); the s2s wire stays DecimalString. */
  async serveClientChanges(
    after?: number,
    requestedTake?: number,
  ): Promise<{
    items: Array<{
      publisherNamespaceId: number;
      profileNamespaceId: number;
      changeId: number;
    }>;
    scannedThrough: number;
    endId: number;
    hasMore: boolean;
  }> {
    const take = requestedTake ?? DEFAULT_TAKE;
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'take must be an integer from 1 to 200',
        HttpStatus.BAD_REQUEST,
      );
    const endId = await this.clientChangeEnd();
    const cursor =
      after === undefined
        ? 0n
        : globalThis.Number.isSafeInteger(after)
          ? BigInt(after)
          : null;
    if (cursor === null || cursor < 0n || cursor > endId)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'profile namespace change cursor is outside the available coordinate space',
        HttpStatus.BAD_REQUEST,
      );
    const rawRows = await this.database.db
      .select({
        publisherNamespaceId: profileNamespaceChangeFeed.publisherNamespaceId,
        profileNamespaceId: profileNamespaceChangeFeed.profileNamespaceId,
        changeId: profileNamespaceChangeFeed.changeId,
      })
      .from(profileNamespaceChangeFeed)
      .where(gt(profileNamespaceChangeFeed.changeId, cursor))
      .orderBy(asc(profileNamespaceChangeFeed.changeId))
      .limit(take + 1);
    const rows = rawRows.slice(0, take);
    const scannedThrough =
      rawRows.length > take
        ? rows.at(-1)!.changeId
        : rows.length > 0
          ? rows.at(-1)!.changeId
          : cursor;
    return {
      items: rows.map((row) => ({
        publisherNamespaceId: row.publisherNamespaceId,
        profileNamespaceId: row.profileNamespaceId,
        changeId: toClientFeedNumber(row.changeId),
      })),
      scannedThrough: toClientFeedNumber(scannedThrough),
      endId: toClientFeedNumber(endId),
      hasMore: rawRows.length > take,
    };
  }

  /** Current changelog head. Row 0 always exists (0012 inserts it). */
  async clientChangeEnd(): Promise<bigint> {
    const [head] = await this.database.db
      .select({ endId: profileNamespaceChangeFeedHead.endId })
      .from(profileNamespaceChangeFeedHead)
      .where(eq(profileNamespaceChangeFeedHead.id, 0))
      .limit(1);
    if (!head) throw new Error('profile namespace change head row is missing');
    return head.endId;
  }

  async serve(
    after?: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<ProfileNamespaceFeedPage> {
    const take = requestedTake ?? DEFAULT_TAKE;
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be an integer from 1 to 200',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.database.db.transaction(async (tx) => {
      const [head] = await tx
        .select({ feedEndId: identityNamespace.profileNamespaceFeedEndId })
        .from(identityNamespace)
        .where(eq(identityNamespace.id, LOCAL_NAMESPACE_ID))
        .limit(1);
      if (!head) throw new Error('local namespace sentinel row is missing');
      const feedEndId = head.feedEndId;
      const cursor = after ?? 0n;
      if (through !== undefined && through < cursor) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'through must be greater than or equal to after',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (cursor < 0n || cursor > feedEndId) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'profile namespace feed cursor is outside the available coordinate space',
          HttpStatus.BAD_REQUEST,
        );
      }
      const scanEnd =
        through === undefined || through > feedEndId ? feedEndId : through;
      const rawRows = await tx
        .select()
        .from(profileNamespaceFeed)
        .where(
          and(
            gt(profileNamespaceFeed.feedId, cursor),
            lte(profileNamespaceFeed.feedId, scanEnd),
          ),
        )
        .orderBy(asc(profileNamespaceFeed.feedId))
        .limit(take + 1);
      const rows = rawRows.slice(0, take);
      const items: ProfileNamespaceFeedPage['items'] = [];
      let bytes = 0;
      for (const row of rows) {
        const item: ProfileNamespaceFeedPage['items'][number] = {
          namespaceId: row.namespaceId,
          feedId: row.feedId.toString(),
        };
        const itemBytes = Buffer.byteLength(JSON.stringify(item));
        if (items.length > 0 && bytes + itemBytes > STATE_FEED_PAGE_MAX_BYTES)
          break;
        items.push(item);
        bytes += itemBytes;
      }
      const last = items.at(-1);
      let scannedThrough: bigint;
      if (items.length < rows.length && last) {
        scannedThrough = BigInt(last.feedId);
      } else if (rawRows.length > take) {
        scannedThrough = rows.at(-1)?.feedId ?? cursor;
      } else {
        scannedThrough = scanEnd;
      }
      const hasMore = scannedThrough < scanEnd;
      return {
        items,
        scannedThrough: scannedThrough.toString(),
        feedEndId: feedEndId.toString(),
        hasMore,
      };
    });
  }

  /** Resolves one namespace id in this responder's own namespace space.
   *  Id 0 answers the responder itself from local authority; a positive id
   *  answers the identity currently bound there. A retired or unknown id is
   *  a business miss (HTTP 200 + NOT_FOUND), never a protocol 404. The
   *  answer is display/vouching data only. */
  async resolveBindings(nsid: number): Promise<ProfileNamespaceBindings> {
    if (!Number.isSafeInteger(nsid) || nsid < 0) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'nsid must be a non-negative safe integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const feedEndId = await this.readFeedEndId();
    if (nsid === LOCAL_NAMESPACE_ID) {
      return {
        domain: loadFederationConfig().domain,
        rootPublicKey: this.keypair.getRootPublicKeyB64(),
        profileNamespaceFeedEndId: feedEndId.toString(),
      };
    }
    const [row] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, nsid))
      .limit(1);
    // An id that never completed a handshake is unknown; everything else
    // is disclosed regardless of trust or retirement state: these are
    // display/vouching bindings, admission gating stays in the recognition
    // machinery, and a reset-retired id keeps answering with its last
    // retained bindings so historical references stay renderable.
    if (!row || row.rootPublicKey === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'namespace id is not bound to a servable identity',
        HttpStatus.OK,
      );
    }
    return {
      domain: row.domain,
      rootPublicKey: row.rootPublicKey,
      profileNamespaceFeedEndId: feedEndId.toString(),
    };
  }
}
