import { readThreadHeadSnapshotInTx } from './federation-thread-head-snapshot.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  peerStateFeed,
  peerStateFeedTarget,
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
export type PeerStateBody = Record<string, unknown>;

interface PeerStateFeedWriteBase {
  peerDomain: string;
  namespaceId: number;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  /** Reallocate the same body after one of its referenced compacted keys moved later. */
  forceReindex?: boolean;
}

export type PeerStateFeedWrite = PeerStateFeedWriteBase &
  (
    | {
        eventType: 'RELATIONSHIP_INTENT';
        body: PeerStateBody & { status: unknown; profileRev: number };
      }
    | {
        eventType: 'GROUP_META_FEED_HEAD';
        body: PeerStateBody & { groupMetaFeedEndId: string };
      }
    | {
        eventType: 'THREAD_CONTENT_HEAD';
        body: PeerStateBody & {
          messageEndSeq: number;
          tombstoneEndSeq: number;
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

export interface PeerStateFeedTargetKey {
  peerDomain: string;
  namespaceId: number;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

const snapshotRevision = (
  eventType: PeerStateEventType,
  body: PeerStateBody,
): number | string | undefined => {
  if (eventType === 'GROUP_META_FEED_HEAD')
    return typeof body.groupMetaFeedEndId === 'string' &&
      /^(0|[1-9]\d*)$/.test(body.groupMetaFeedEndId)
      ? body.groupMetaFeedEndId
      : undefined;
  if (eventType === 'THREAD_CONTENT_HEAD') {
    const messageEndSeq = body.messageEndSeq;
    const tombstoneEndSeq = body.tombstoneEndSeq;
    return Number.isSafeInteger(messageEndSeq) &&
      Number(messageEndSeq) >= 0 &&
      Number(messageEndSeq) <= FEDERATION_THREAD_SEQUENCE_MAX &&
      Number.isSafeInteger(tombstoneEndSeq) &&
      Number(tombstoneEndSeq) >= 0 &&
      Number(tombstoneEndSeq) <= FEDERATION_THREAD_SEQUENCE_MAX
      ? `${Number(messageEndSeq)}:${Number(tombstoneEndSeq)}`
      : undefined;
  }
  return undefined;
};

@Injectable()
export class PeerStateFeedService {
  constructor(private readonly database: DatabaseService) {}

  async initializePeerInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
  ): Promise<void> {
    await tx
      .insert(peerStateFeedTarget)
      .values({ peerDomain, namespaceId })
      .onConflictDoNothing();
  }

  /**
   * Acquires peer feed allocators in their global order. Transactions that can
   * also allocate client state must call this after their business-scope locks
   * and before the first Account allocator is touched.
   */
  async lockTargetsInTx(
    tx: DatabaseTransaction,
    targets: readonly PeerStateFeedTargetKey[],
  ): Promise<void> {
    const ordered = [
      ...new Map(
        targets.map((target) => [
          `${target.peerDomain}\u0000${target.namespaceId}`,
          target,
        ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.peerDomain.localeCompare(right.peerDomain) ||
        left.namespaceId - right.namespaceId,
    );
    for (const target of ordered) {
      await this.initializePeerInTx(tx, target.peerDomain, target.namespaceId);
      const locked = await tx
        .select({ namespaceId: peerStateFeedTarget.namespaceId })
        .from(peerStateFeedTarget)
        .where(
          and(
            eq(peerStateFeedTarget.peerDomain, target.peerDomain),
            eq(peerStateFeedTarget.namespaceId, target.namespaceId),
          ),
        )
        .for('update')
        .limit(1);
      if (!locked[0])
        throw new Error(
          `missing state feed target for ${target.peerDomain}/${target.namespaceId}`,
        );
    }
  }

  async deleteProjectionInTx(
    tx: DatabaseTransaction,
    key: Omit<PeerStateFeedWrite, 'body'>,
  ): Promise<void> {
    await tx
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, key.peerDomain),
          eq(peerStateFeed.namespaceId, key.namespaceId),
          eq(peerStateFeed.account, key.account),
          eq(peerStateFeed.domain, key.domain),
          eq(peerStateFeed.eventType, key.eventType),
          eq(peerStateFeed.subjectAccount, key.subjectAccount),
          eq(peerStateFeed.subjectDomain, key.subjectDomain),
        ),
      );
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
            AND "endpointANamespaceId" = ${write.namespaceId}
            AND "endpointBNamespaceId" = ${write.namespaceId}
            AND ((("endpointAAccount", "endpointADomain") = (${write.account}, 'local')
              AND ("endpointBAccount", "endpointBDomain") = (${write.subjectAccount}, ${write.peerDomain}))
              OR (("endpointBAccount", "endpointBDomain") = (${write.account}, 'local')
              AND ("endpointAAccount", "endpointADomain") = (${write.subjectAccount}, ${write.peerDomain})))
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
    writes: readonly PeerStateFeedWrite[],
  ): Promise<Map<string, bigint>> {
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
    await this.lockTargetsInTx(tx, ordered);
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
        if (!write.forceReindex) continue;
      }
      if (
        current &&
        isDeepStrictEqual(current.body, body) &&
        !write.forceReindex
      )
        continue;
      const [allocated] = await tx
        .update(peerStateFeedTarget)
        .set({
          allocatedThrough: sql`${peerStateFeedTarget.allocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(peerStateFeedTarget.namespaceId, write.namespaceId))
        .returning({ feedId: peerStateFeedTarget.allocatedThrough });
      if (!allocated)
        throw new Error(`missing state feed target for ${write.peerDomain}`);
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
      if (write.eventType === 'GROUP_META_FEED_HEAD') {
        const dependents = await tx
          .select()
          .from(peerStateFeed)
          .where(
            and(
              eq(peerStateFeed.peerDomain, write.peerDomain),
              eq(peerStateFeed.namespaceId, write.namespaceId),
              eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
              eq(peerStateFeed.account, write.account),
            ),
          );
        if (dependents.length > 0) {
          const route = await tx.execute<{
            threadId: number;
            messageAccessAfterSeq: number;
          }>(sql`
            SELECT thread.id AS "threadId", audience."messageAccessAfterSeq"
            FROM "MessageThread" thread
            JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
              AND audience."targetDomain" = ${write.peerDomain}
              AND audience."targetNamespaceId" = ${write.namespaceId}
              AND audience."localUserId" IS NULL
            WHERE thread.type = 'GROUP' AND thread."groupDomain" = 'local'
              AND thread."groupAccount" = ${write.account}
              AND thread."authorityNamespaceId" = 0
          `);
          const thread = route.rows[0];
          if (!thread)
            throw new Error('group content head has no authorized thread');
          const latestHead = await readThreadHeadSnapshotInTx(
            tx,
            thread.threadId,
            thread.messageAccessAfterSeq,
          );
          const moved = await this.writeManyInTx(
            tx,
            dependents.map((dependent) => ({
              peerDomain: dependent.peerDomain,
              namespaceId: dependent.namespaceId,
              account: dependent.account,
              domain: dependent.domain,
              eventType: 'THREAD_CONTENT_HEAD' as const,
              subjectAccount: dependent.subjectAccount,
              subjectDomain: dependent.subjectDomain,
              body: latestHead,
              forceReindex: true,
            })),
          );
          for (const entry of moved) result.set(...entry);
        }
      }
    }
    return result;
  }

  async readFeedEndId(namespaceId: number): Promise<bigint> {
    const [target] = await this.database.db
      .select({ feedId: peerStateFeedTarget.allocatedThrough })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.namespaceId, namespaceId))
      .limit(1);
    return target?.feedId ?? 0n;
  }

  async rejectMissingAfter(
    peerDomain: string,
    namespaceId: number,
  ): Promise<never> {
    const [target] = await this.database.db
      .select({ peerDomain: peerStateFeedTarget.peerDomain })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.namespaceId, namespaceId))
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
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.namespaceId, namespaceId))
        .limit(1);
      if (!target) {
        throw new Error(
          `peer ${peerDomain} has no initialized state-feed target`,
        );
      }
      const stateFeedEndId = target.allocatedThrough;
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
