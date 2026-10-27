import { readThreadHeadSnapshotInTx } from './federation-thread-head-snapshot.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  identityNamespace,
  federationFeedState,
  profileNamespaceFeedHead,
  peerStateFeed,
  peerStateEventType,
} from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { STATE_FEED_PAGE_MAX_BYTES } from '../common/feed-page.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';

export type PeerStateEventType = (typeof peerStateEventType.enumValues)[number];
/** The `/s2s/v1` route is the schema version; bodies contain business state only. */
type PeerStateBody = Record<string, unknown>;

interface PeerStateFeedWriteBase {
  namespaceId: number;
  account: string;
  subjectAccount: string;
  subjectNamespaceId: number;
}

export type PeerStateFeedWrite = PeerStateFeedWriteBase &
  (
    | {
        eventType: 'RELATIONSHIP_INTENT';
        body: PeerStateBody & {
          status: unknown;
          namespaceId: number;
          profileRev: number;
        };
      }
    | {
        eventType: 'THREAD_CONTENT_HEAD';
        body: PeerStateBody & {
          messageEndSeq: number;
          tombstoneEndSeq: number;
          /** Group Meta coordinate carried by group-authored heads only; P2P heads
           * must omit it. Part of the snapshot revision below. */
          groupMetaFeedEndId?: number;
        };
      }
  );

export interface PeerStateFeedPage {
  items: Array<{
    account: string;
    eventType: PeerStateEventType;
    peerAccount?: string;
    feedId: string;
    generatedAt: number;
    body: unknown;
  }>;
  scannedThrough: string;
  stateFeedEndId: string;
  /** Publisher-wide Profile Namespace Feed end, disclosed on every State Feed
   *  page so ordinary pulls can observe it without a separate channel. */
  profileNamespaceFeedEndId: string;
  hasMore: boolean;
}

export interface PeerStateFeedNamespaceKey {
  namespaceId: number;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

const snapshotRevision = (
  eventType: PeerStateEventType,
  body: PeerStateBody,
): string | undefined => {
  if (eventType === 'THREAD_CONTENT_HEAD') {
    const messageEndSeq = body.messageEndSeq;
    const tombstoneEndSeq = body.tombstoneEndSeq;
    // The optional Group Meta value is part of the progress coordinate: a meta-only
    // advance is legitimate progress and must allocate a new feed position.
    const metaFeedEndId = body.groupMetaFeedEndId;
    const metaRevision =
      typeof metaFeedEndId === 'number' &&
      Number.isSafeInteger(metaFeedEndId) &&
      metaFeedEndId >= 0
        ? String(metaFeedEndId)
        : '0';
    return Number.isSafeInteger(messageEndSeq) &&
      Number(messageEndSeq) >= 0 &&
      Number(messageEndSeq) <= FEDERATION_THREAD_SEQUENCE_MAX &&
      Number.isSafeInteger(tombstoneEndSeq) &&
      Number(tombstoneEndSeq) >= 0 &&
      Number(tombstoneEndSeq) <= FEDERATION_THREAD_SEQUENCE_MAX
      ? `${Number(messageEndSeq)}:${Number(tombstoneEndSeq)}:${metaRevision}`
      : undefined;
  }
  return undefined;
};

@Injectable()
export class PeerStateFeedService {
  constructor(private readonly database: DatabaseService) {}

  /** General state-feed addresses are already wire addresses. Profile path
   * conversion is handled by the profile transport helper. */
  toWireDomain(domain: string): string {
    return domain;
  }

  /**
   * Acquires outbound namespace allocators in their global order. This is a
   * terminal implicit lock class: callers must hold every required Account,
   * Pair, and Thread business lock before entering it.
   */
  async lockOutboundStateFeedNamespacesInTx(
    tx: DatabaseTransaction,
    targets: readonly PeerStateFeedNamespaceKey[],
  ): Promise<void> {
    const ordered = [
      ...new Map(
        targets.map((target) => [String(target.namespaceId), target]),
      ).values(),
    ].sort((left, right) => left.namespaceId - right.namespaceId);
    // Pin lifecycle eligibility before taking the independent allocators.
    // Acquire every identity lock first so a multi-peer batch cannot invert
    // identity -> feed-state ordering against recognition or retirement.
    for (const target of ordered) {
      const [identity] = await tx
        .select({ id: identityNamespace.id })
        .from(identityNamespace)
        .where(
          and(
            eq(identityNamespace.id, target.namespaceId),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .for('no key update')
        .limit(1);
      if (!identity)
        throw new Error(
          `missing active federation namespace ${target.namespaceId}`,
        );
    }
    for (const target of ordered) {
      const locked = await tx
        .select({ namespaceId: federationFeedState.namespaceId })
        .from(federationFeedState)
        .innerJoin(
          identityNamespace,
          eq(identityNamespace.id, federationFeedState.namespaceId),
        )
        .where(
          and(
            eq(federationFeedState.namespaceId, target.namespaceId),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .for('no key update', { of: federationFeedState })
        .limit(1);
      if (!locked[0])
        throw new Error(
          `missing active federation namespace ${target.namespaceId}`,
        );
    }
  }

  private async readRelationshipHeadInTx(
    tx: DatabaseTransaction,
    write: PeerStateFeedWrite,
  ) {
    const groupAccount = write.account.startsWith('!')
      ? write.account
      : write.subjectAccount.startsWith('!')
        ? write.subjectAccount
        : null;
    const result =
      groupAccount === null
        ? await tx.execute<{ threadId: number | null }>(sql`
          SELECT "threadId" FROM "RelationshipPair"
          WHERE kind = 'P2P'
            AND "endpointAType" = 'USER'
            AND "endpointAAccount" = ${write.account}
            AND "endpointANamespaceId" = 0
            AND "endpointBType" = 'USER'
            AND "endpointBAccount" = ${write.subjectAccount}
            AND "endpointBNamespaceId" = ${write.namespaceId}
        `)
        : await tx.execute<{ threadId: number | null }>(sql`
          SELECT id AS "threadId" FROM "MessageThread"
          WHERE type = 'GROUP' AND "groupAccount" = ${groupAccount}
            AND "authorityNamespaceId" = ${write.account.startsWith('!') ? 0 : write.namespaceId}
        `);
    return readThreadHeadSnapshotInTx(tx, result.rows[0]?.threadId ?? null);
  }

  /** Writes are ordered by peer and allocate a rev only when the compacted key advances. */
  async writeManyInTx(
    tx: DatabaseTransaction,
    inputWrites: readonly PeerStateFeedWrite[],
  ): Promise<Map<number, bigint>> {
    const writes = inputWrites;
    const result = new Map<number, bigint>();
    const ordered = [...writes].sort(
      (a, b) =>
        a.namespaceId - b.namespaceId ||
        a.account.localeCompare(b.account) ||
        a.eventType.localeCompare(b.eventType) ||
        a.subjectNamespaceId - b.subjectNamespaceId ||
        a.subjectAccount.localeCompare(b.subjectAccount),
    );
    await this.lockOutboundStateFeedNamespacesInTx(tx, ordered);
    for (const write of ordered) {
      // State bodies are persisted as JSONB before the HTTP serializer sees them. Normalize at this
      // boundary so Date/BigInt use the same wire representation as every HTTP and SSE response.
      const snapshot =
        write.eventType === 'RELATIONSHIP_INTENT' &&
        write.body.status !== 'REVOKED'
          ? await this.readRelationshipHeadInTx(tx, write)
          : {};
      const body = serializeBody(
        write.eventType === 'RELATIONSHIP_INTENT' &&
          write.body.status !== 'REVOKED'
          ? { ...write.body, ...snapshot }
          : write.body,
      );
      if (!body || typeof body !== 'object') {
        throw new Error('invalid peer state feed write');
      }
      const subjectAccount = write.subjectAccount;
      const subjectNamespaceId = write.subjectNamespaceId;
      const directionalRelationship = write.eventType === 'RELATIONSHIP_INTENT';
      const p2pThreadContent =
        write.eventType === 'THREAD_CONTENT_HEAD' &&
        !write.account.startsWith('!');
      if (
        directionalRelationship || p2pThreadContent
          ? subjectAccount === '' ||
            subjectNamespaceId <= 0 ||
            (p2pThreadContent && subjectNamespaceId !== write.namespaceId)
          : subjectAccount !== '' || subjectNamespaceId !== 0
      ) {
        throw new Error(
          'state address key is incomplete or has an invalid directional subject',
        );
      }
      const [current] = await tx
        .select({
          body: peerStateFeed.body,
        })
        .from(peerStateFeed)
        .where(
          and(
            eq(peerStateFeed.namespaceId, write.namespaceId),
            eq(peerStateFeed.account, write.account),
            eq(peerStateFeed.eventType, write.eventType),
            eq(peerStateFeed.subjectAccount, subjectAccount),
            eq(peerStateFeed.subjectNamespaceId, subjectNamespaceId),
          ),
        )
        .limit(1);
      const nextSnapshotRevision = snapshotRevision(write.eventType, body);
      const currentSnapshotRevision = current
        ? snapshotRevision(write.eventType, current.body as PeerStateBody)
        : undefined;
      if (
        current &&
        nextSnapshotRevision !== undefined &&
        currentSnapshotRevision === nextSnapshotRevision
      ) {
        if (!isDeepStrictEqual(current.body, body))
          throw new Error(
            `${write.eventType} revision ${nextSnapshotRevision} changed without advancing`,
          );
        continue;
      }
      if (current && isDeepStrictEqual(current.body, body)) continue;
      const [allocated] = await tx
        .update(federationFeedState)
        .set({
          outboundStateFeedEndId: sql`${federationFeedState.outboundStateFeedEndId} + 1`,
        })
        .where(eq(federationFeedState.namespaceId, write.namespaceId))
        .returning({ feedId: federationFeedState.outboundStateFeedEndId });
      if (!allocated)
        throw new Error(
          `missing active federation namespace ${write.namespaceId}`,
        );
      await tx
        .insert(peerStateFeed)
        .values({
          namespaceId: write.namespaceId,
          account: write.account,
          eventType: write.eventType,
          subjectAccount,
          subjectNamespaceId,
          feedId: allocated.feedId,
          body,
        })
        .onConflictDoUpdate({
          target: [
            peerStateFeed.namespaceId,
            peerStateFeed.account,
            peerStateFeed.eventType,
            peerStateFeed.subjectAccount,
            peerStateFeed.subjectNamespaceId,
          ],
          set: {
            feedId: allocated.feedId,
            body,
            updatedAt: new Date(),
          },
        });
      result.set(write.namespaceId, allocated.feedId);
    }
    return result;
  }

  /** Acceptance confirmation republishes an existing compacted relationship key.
   * A changed body is written normally; an unchanged body receives a new feed position. */
  async writeAcceptanceConfirmationsInTx(
    tx: DatabaseTransaction,
    inputWrites: readonly PeerStateFeedWrite[],
  ): Promise<Map<number, bigint>> {
    const writes = inputWrites;
    if (
      writes.some(
        (write) =>
          write.eventType !== 'RELATIONSHIP_INTENT' ||
          write.body.status !== 'ACCEPTED',
      )
    )
      throw new Error(
        'acceptance confirmation requires an accepted relationship',
      );
    await this.lockOutboundStateFeedNamespacesInTx(tx, writes);
    const before = new Map<number, bigint>();
    for (const write of writes) {
      if (before.has(write.namespaceId)) continue;
      const target = await tx.query.federationFeedState.findFirst({
        where: eq(federationFeedState.namespaceId, write.namespaceId),
      });
      if (!target)
        throw new Error(
          `missing active federation namespace ${write.namespaceId}`,
        );
      before.set(write.namespaceId, target.outboundStateFeedEndId);
    }
    const result = await this.writeManyInTx(tx, writes);
    for (const write of writes) {
      const key = and(
        eq(peerStateFeed.namespaceId, write.namespaceId),
        eq(peerStateFeed.account, write.account),
        eq(peerStateFeed.eventType, write.eventType),
        eq(peerStateFeed.subjectAccount, write.subjectAccount),
        eq(peerStateFeed.subjectNamespaceId, write.subjectNamespaceId),
      );
      const row = await tx.query.peerStateFeed.findFirst({ where: key });
      if (!row || row.feedId > before.get(write.namespaceId)!) continue;
      const [allocated] = await tx
        .update(federationFeedState)
        .set({
          outboundStateFeedEndId: sql`${federationFeedState.outboundStateFeedEndId} + 1`,
        })
        .where(eq(federationFeedState.namespaceId, write.namespaceId))
        .returning({ feedId: federationFeedState.outboundStateFeedEndId });
      if (!allocated)
        throw new Error(
          `missing active federation namespace ${write.namespaceId}`,
        );
      await tx
        .update(peerStateFeed)
        .set({ feedId: allocated.feedId, updatedAt: new Date() })
        .where(key);
      result.set(write.namespaceId, allocated.feedId);
    }
    return result;
  }

  async readFeedEndId(namespaceId: number): Promise<bigint> {
    const [target] = await this.database.db
      .select({ feedId: federationFeedState.outboundStateFeedEndId })
      .from(federationFeedState)
      .where(eq(federationFeedState.namespaceId, namespaceId))
      .limit(1);
    return target?.feedId ?? 0n;
  }

  async rejectMissingAfter(namespaceId: number): Promise<never> {
    const feedEndId = await this.readFeedEndId(namespaceId);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the state feed cursor',
      HttpStatus.OK,
      {
        resumeAfter: '0',
        resumeBefore: (feedEndId + 1n).toString(),
      },
    );
  }

  async serve(
    namespaceId: number,
    after: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    const take = requestedTake ?? DEFAULT_TAKE;
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be an integer from 1 to 200',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.database.db.transaction(
      async (tx) => {
        const [target] = await tx
          .select({
            outboundStateFeedEndId: federationFeedState.outboundStateFeedEndId,
          })
          .from(federationFeedState)
          .where(eq(federationFeedState.namespaceId, namespaceId))
          .limit(1);
        if (!target) {
          throw new Error(
            `namespace ${namespaceId} has no federation namespace`,
          );
        }
        const stateFeedEndId = target.outboundStateFeedEndId;
        if (through !== undefined && through < after) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'through must be greater than or equal to after',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (after < 0n || after > stateFeedEndId) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            'state feed cursor is outside the available coordinate space',
            HttpStatus.OK,
            {
              resumeAfter: '0',
              resumeBefore: (stateFeedEndId + 1n).toString(),
            },
          );
        }
        const requestedScanEnd =
          through === undefined || through > stateFeedEndId
            ? stateFeedEndId
            : through;
        const scanEnd = requestedScanEnd;
        const rawRows = await tx
          .select()
          .from(peerStateFeed)
          .where(
            and(
              eq(peerStateFeed.namespaceId, namespaceId),
              gt(peerStateFeed.feedId, after),
              lte(peerStateFeed.feedId, scanEnd),
            ),
          )
          .orderBy(asc(peerStateFeed.feedId))
          .limit(take + 1);
        const rows = rawRows.slice(0, take);
        const items: PeerStateFeedPage['items'] = [];
        let bytes = 0;
        for (const row of rows) {
          const item: PeerStateFeedPage['items'][number] = {
            account: row.account,
            eventType: row.eventType,
            feedId: row.feedId.toString(),
            generatedAt: row.updatedAt.getTime(),
            body: row.body,
            ...(row.eventType === 'RELATIONSHIP_INTENT' ||
            (row.eventType === 'THREAD_CONTENT_HEAD' &&
              row.subjectAccount !== '')
              ? {
                  peerAccount: row.subjectAccount,
                }
              : {}),
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
          scannedThrough = rows.at(-1)?.feedId ?? after;
        } else {
          scannedThrough = scanEnd;
        }
        const hasMore = scannedThrough < scanEnd;
        const [local] = await tx
          .select({
            profileNamespaceFeedEndId: profileNamespaceFeedHead.endId,
          })
          .from(profileNamespaceFeedHead)
          .where(eq(profileNamespaceFeedHead.id, 0))
          .limit(1);
        if (!local) throw new Error('local namespace sentinel row is missing');
        return {
          items,
          scannedThrough: scannedThrough.toString(),
          stateFeedEndId: stateFeedEndId.toString(),
          profileNamespaceFeedEndId: local.profileNamespaceFeedEndId.toString(),
          hasMore,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
