import { readThreadHeadSnapshotInTx } from './federation-thread-head-snapshot.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  identityNamespace,
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
  peerDomain: string;
  namespaceId: number;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
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
    body: unknown;
  }>;
  scannedThrough: string;
  stateFeedEndId: string;
  hasMore: boolean;
}

export interface PeerStateFeedNamespaceKey {
  peerDomain: string;
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

  private normalizeAddressDomains<
    T extends {
      domain: string;
      eventType: PeerStateEventType;
      subjectAccount: string;
      subjectDomain: string;
    },
  >(write: T): T {
    const directionalSubject =
      write.eventType === 'RELATIONSHIP_INTENT' || write.subjectAccount !== '';
    return {
      ...write,
      domain: this.toWireDomain(write.domain),
      // Empty subjects on non-directional heads use `local` as a protocol
      // sentinel, not as an account address.
      subjectDomain: directionalSubject
        ? this.toWireDomain(write.subjectDomain)
        : write.subjectDomain,
    };
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
        targets.map((target) => [
          `${target.peerDomain}\u0000${target.namespaceId}`,
          target,
        ]),
      ).values(),
    ].sort((left, right) => left.namespaceId - right.namespaceId);
    for (const target of ordered) {
      const locked = await tx
        .select({ namespaceId: identityNamespace.id })
        .from(identityNamespace)
        .where(
          and(
            eq(identityNamespace.domain, target.peerDomain),
            eq(identityNamespace.id, target.namespaceId),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .for('no key update')
        .limit(1);
      if (!locked[0])
        throw new Error(
          `missing active federation namespace ${target.peerDomain}/${target.namespaceId}`,
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
            AND "groupDomain" = ${write.account.startsWith('!') ? 'local' : write.peerDomain}
            AND "authorityNamespaceId" = ${write.account.startsWith('!') ? 0 : write.namespaceId}
        `);
    return readThreadHeadSnapshotInTx(tx, result.rows[0]?.threadId ?? null);
  }

  /** Writes are ordered by peer and allocate a rev only when the compacted key advances. */
  async writeManyInTx(
    tx: DatabaseTransaction,
    inputWrites: readonly PeerStateFeedWrite[],
  ): Promise<Map<string, bigint>> {
    const writes = inputWrites.map((write) =>
      this.normalizeAddressDomains(write),
    );
    const result = new Map<string, bigint>();
    const ordered = [...writes].sort(
      (a, b) =>
        a.peerDomain.localeCompare(b.peerDomain) ||
        a.namespaceId - b.namespaceId ||
        a.domain.localeCompare(b.domain) ||
        a.account.localeCompare(b.account) ||
        a.eventType.localeCompare(b.eventType) ||
        a.subjectDomain.localeCompare(b.subjectDomain) ||
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
      const subjectDomain = write.subjectDomain;
      const directionalRelationship = write.eventType === 'RELATIONSHIP_INTENT';
      const p2pThreadContent =
        write.eventType === 'THREAD_CONTENT_HEAD' &&
        !write.account.startsWith('!');
      if (
        !write.domain ||
        (directionalRelationship || p2pThreadContent
          ? subjectAccount === '' ||
            subjectDomain === '' ||
            (p2pThreadContent && subjectDomain !== write.peerDomain)
          : subjectAccount !== '' || subjectDomain !== 'local')
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
            eq(peerStateFeed.peerDomain, write.peerDomain),
            eq(peerStateFeed.namespaceId, write.namespaceId),
            eq(peerStateFeed.account, write.account),
            eq(peerStateFeed.domain, write.domain),
            eq(peerStateFeed.eventType, write.eventType),
            eq(peerStateFeed.subjectAccount, subjectAccount),
            eq(peerStateFeed.subjectDomain, subjectDomain),
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
        .update(identityNamespace)
        .set({
          stateFeedEndId: sql`${identityNamespace.stateFeedEndId} + 1`,
        })
        .where(
          and(
            eq(identityNamespace.id, write.namespaceId),
            eq(identityNamespace.domain, write.peerDomain),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .returning({ feedId: identityNamespace.stateFeedEndId });
      if (!allocated)
        throw new Error(
          `missing active federation namespace ${write.peerDomain}`,
        );
      await tx
        .insert(peerStateFeed)
        .values({
          peerDomain: write.peerDomain,
          namespaceId: write.namespaceId,
          account: write.account,
          domain: write.domain,
          eventType: write.eventType,
          subjectAccount,
          subjectDomain,
          feedId: allocated.feedId,
          body,
        })
        .onConflictDoUpdate({
          target: [
            peerStateFeed.namespaceId,
            peerStateFeed.account,
            peerStateFeed.domain,
            peerStateFeed.eventType,
            peerStateFeed.subjectAccount,
            peerStateFeed.subjectDomain,
          ],
          set: {
            feedId: allocated.feedId,
            body,
            updatedAt: new Date(),
          },
        });
      result.set(write.peerDomain, allocated.feedId);
    }
    return result;
  }

  /** Acceptance confirmation republishes an existing compacted relationship key.
   * A changed body is written normally; an unchanged body receives a new feed position. */
  async writeAcceptanceConfirmationsInTx(
    tx: DatabaseTransaction,
    inputWrites: readonly PeerStateFeedWrite[],
  ): Promise<Map<string, bigint>> {
    const writes = inputWrites.map((write) =>
      this.normalizeAddressDomains(write),
    );
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
      const target = await tx.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, write.namespaceId),
      });
      if (!target || target.domain !== write.peerDomain || target.retiredAt)
        throw new Error(
          `missing active federation namespace ${write.peerDomain}`,
        );
      before.set(write.namespaceId, target.stateFeedEndId);
    }
    const result = await this.writeManyInTx(tx, writes);
    for (const write of writes) {
      const key = and(
        eq(peerStateFeed.namespaceId, write.namespaceId),
        eq(peerStateFeed.peerDomain, write.peerDomain),
        eq(peerStateFeed.account, write.account),
        eq(peerStateFeed.domain, write.domain),
        eq(peerStateFeed.eventType, write.eventType),
        eq(peerStateFeed.subjectAccount, write.subjectAccount),
        eq(peerStateFeed.subjectDomain, write.subjectDomain),
      );
      const row = await tx.query.peerStateFeed.findFirst({ where: key });
      if (!row || row.feedId > before.get(write.namespaceId)!) continue;
      const [allocated] = await tx
        .update(identityNamespace)
        .set({
          stateFeedEndId: sql`${identityNamespace.stateFeedEndId} + 1`,
        })
        .where(
          and(
            eq(identityNamespace.id, write.namespaceId),
            eq(identityNamespace.domain, write.peerDomain),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .returning({ feedId: identityNamespace.stateFeedEndId });
      if (!allocated)
        throw new Error(
          `missing active federation namespace ${write.peerDomain}`,
        );
      await tx
        .update(peerStateFeed)
        .set({ feedId: allocated.feedId, updatedAt: new Date() })
        .where(key);
      result.set(write.peerDomain, allocated.feedId);
    }
    return result;
  }

  async readFeedEndId(namespaceId: number): Promise<bigint> {
    const [target] = await this.database.db
      .select({ feedId: identityNamespace.stateFeedEndId })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    return target?.feedId ?? 0n;
  }

  async rejectMissingAfter(
    peerDomain: string,
    namespaceId: number,
  ): Promise<never> {
    const [target] = await this.database.db
      .select({ peerDomain: identityNamespace.domain })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.id, namespaceId),
          eq(identityNamespace.domain, peerDomain),
        ),
      )
      .limit(1);
    if (!target) throw new Error(`peer ${peerDomain} has no state feed`);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the state feed cursor',
      HttpStatus.OK,
      {
        resumeAfter: '0',
        resumeBefore: ((await this.readFeedEndId(namespaceId)) + 1n).toString(),
      },
    );
  }

  async serve(
    peerDomain: string,
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
    return this.database.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(identityNamespace)
        .where(
          and(
            eq(identityNamespace.id, namespaceId),
            eq(identityNamespace.domain, peerDomain),
          ),
        )
        .limit(1);
      if (!target) {
        throw new Error(`peer ${peerDomain} has no federation namespace`);
      }
      const stateFeedEndId = target.stateFeedEndId;
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
          { resumeAfter: '0', resumeBefore: (stateFeedEndId + 1n).toString() },
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
            eq(peerStateFeed.peerDomain, peerDomain),
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
          body: row.body,
          ...(row.eventType === 'RELATIONSHIP_INTENT' ||
          (row.eventType === 'THREAD_CONTENT_HEAD' && row.subjectAccount !== '')
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
      return {
        items,
        scannedThrough: scannedThrough.toString(),
        stateFeedEndId: stateFeedEndId.toString(),
        hasMore,
      };
    });
  }
}
