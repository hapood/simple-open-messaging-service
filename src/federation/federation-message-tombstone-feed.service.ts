import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MessageDeleteType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  deletedMessage,
  federationMessageDelivery,
  federationTombstoneFeedIndex,
  federationTombstoneServeCursor,
  message,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import {
  type FederationThreadAddress,
  type FederationThreadQuery,
} from './federation-message-feed.service.js';
import { loadFederationConfig } from './federation.config.js';
import {
  FederationFeedFillState,
  type FederationFeedFillQuantumResult,
} from './federation-message-feed-indexer.service.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export interface FederationMessageTombstoneItem {
  deletionSeq: string;
  thread: FederationThreadAddress;
  target: {
    creator: { account: string; domain: string };
    originSeq: number;
  };
  type: MessageDeleteType;
  deletedAt: number;
}

export interface FederationMessageTombstonePage {
  items: Array<{
    feedId: string;
    thread: FederationThreadAddress;
    tombstoneEndSeq: string;
  }>;
  scannedThrough: string;
  tombstoneFeedEndId: string;
  hasMore: boolean;
  /** Consumer-only materialization; never serialized by the source endpoint. */
  tombstones?: FederationMessageTombstoneItem[];
  queryCursors?: Array<{ threadKey: string; committedThrough: string }>;
}

export interface FederationMessageTombstoneQueryPage {
  tombstones: FederationMessageTombstoneItem[];
  scannedThrough: string;
  hasMore: boolean;
}

@Injectable()
export class FederationMessageTombstoneFeedService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(private readonly database: DatabaseService) {}

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    await this.requireTarget(peerDomain);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the tombstone feed cursor',
      HttpStatus.OK,
      { resumeAfter: '0' },
    );
  }

  state(_peerDomain: string): FederationFeedFillState {
    return FederationFeedFillState.CAUGHT_UP;
  }

  async fill(peerDomain: string): Promise<FederationFeedFillState> {
    await this.database.db.transaction(async (tx) => {
      const [cursor] = await tx
        .select()
        .from(federationTombstoneServeCursor)
        .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
        .for('update')
        .limit(1);
      if (!cursor)
        throw new Error(`peer ${peerDomain} has no tombstone feed target`);
      const rows = await tx
        .select({
          deletionId: deletedMessage.id,
          threadId: deletedMessage.threadId,
          messageId: message.id,
        })
        .from(deletedMessage)
        .innerJoin(
          message,
          and(
            eq(message.threadId, deletedMessage.threadId),
            eq(message.seq, deletedMessage.seq),
          ),
        )
        .innerJoin(
          federationMessageDelivery,
          and(
            eq(federationMessageDelivery.peerDomain, peerDomain),
            eq(federationMessageDelivery.messageId, message.id),
          ),
        )
        // Delivery proof can be materialized after the deletion transaction (for example while
        // draining an audience during relationship closure). Reconsider permanent local facts on
        // every fill so advancing the global scan watermark can never hide a newly eligible proof.
        .where(isNull(deletedMessage.federationSourceDomain))
        .orderBy(asc(deletedMessage.id));
      const latest = new Map<number, bigint>();
      for (const row of rows) latest.set(row.threadId, row.deletionId);
      let feedId = cursor.allocatedThrough;
      for (const [threadId, tombstoneEndSeq] of latest) {
        const [current] = await tx
          .select({ end: federationTombstoneFeedIndex.tombstoneEndSeq })
          .from(federationTombstoneFeedIndex)
          .where(
            and(
              eq(federationTombstoneFeedIndex.peerDomain, peerDomain),
              eq(federationTombstoneFeedIndex.threadId, threadId),
            ),
          )
          .limit(1);
        if (current && current.end >= tombstoneEndSeq) continue;
        feedId += 1n;
        await tx
          .insert(federationTombstoneFeedIndex)
          .values({ peerDomain, threadId, feedId, tombstoneEndSeq })
          .onConflictDoUpdate({
            target: [
              federationTombstoneFeedIndex.peerDomain,
              federationTombstoneFeedIndex.threadId,
            ],
            set: { feedId, tombstoneEndSeq, updatedAt: new Date() },
          });
      }
      const [globalEnd] = await tx
        .select({ end: sql<bigint>`COALESCE(MAX(${deletedMessage.id}), 0)` })
        .from(deletedMessage);
      await tx
        .update(federationTombstoneServeCursor)
        .set({
          allocatedThrough: feedId,
          sourceScannedThrough: globalEnd?.end ?? cursor.sourceScannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain));
    });
    return FederationFeedFillState.CAUGHT_UP;
  }

  async fillQuantum(
    peerDomain: string,
    _maxWork: number,
  ): Promise<FederationFeedFillQuantumResult> {
    await this.fill(peerDomain);
    return { state: FederationFeedFillState.CAUGHT_UP, work: 1 };
  }

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<FederationMessageTombstonePage> {
    const take = this.pageSize(requestedTake);
    if (through !== undefined && through < after) this.invalidThrough();
    await this.fill(peerDomain);
    return this.database.db.transaction(async (tx) => {
      const end = await this.readEndInTx(tx, peerDomain);
      if (after < 0n || after > end) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'tombstone feed cursor is outside the available coordinate space',
          HttpStatus.OK,
          { resumeAfter: '0' },
        );
      }
      const requestEnd = through === undefined || through > end ? end : through;
      const rows = await tx
        .select({
          threadId: federationTombstoneFeedIndex.threadId,
          feedId: federationTombstoneFeedIndex.feedId,
          tombstoneEndSeq: federationTombstoneFeedIndex.tombstoneEndSeq,
        })
        .from(federationTombstoneFeedIndex)
        .where(
          and(
            eq(federationTombstoneFeedIndex.peerDomain, peerDomain),
            gt(federationTombstoneFeedIndex.feedId, after),
            lte(federationTombstoneFeedIndex.feedId, requestEnd),
          ),
        )
        .orderBy(asc(federationTombstoneFeedIndex.feedId))
        .limit(take + 1);
      const selected = rows.slice(0, take);
      const addresses = await this.threadAddressesInTx(
        tx,
        selected.map((row) => row.threadId),
      );
      const items = selected.map((row) => ({
        feedId: row.feedId.toString(),
        thread: this.requiredAddress(addresses, row.threadId),
        tombstoneEndSeq: row.tombstoneEndSeq.toString(),
      }));
      const scannedThrough =
        rows.length > take ? selected.at(-1)!.feedId : requestEnd;
      return {
        items,
        scannedThrough: scannedThrough.toString(),
        tombstoneFeedEndId: end.toString(),
        hasMore: scannedThrough < requestEnd,
      };
    });
  }

  async rejectMissingQueryAfter(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<never> {
    await this.resolveAuthorizedThread(peerDomain, selector);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the tombstone query cursor',
      HttpStatus.OK,
      { resumeAfter: '0' },
    );
  }

  async query(
    peerDomain: string,
    selector: FederationThreadQuery,
    after: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<FederationMessageTombstoneQueryPage> {
    const take = this.pageSize(requestedTake);
    if (through !== undefined && through < after) this.invalidThrough();
    const threadId = await this.resolveAuthorizedThread(peerDomain, selector);
    return this.database.db.transaction(async (tx) => {
      const [tail] = await tx
        .select({ end: sql<bigint>`COALESCE(MAX(${deletedMessage.id}), 0)` })
        .from(deletedMessage)
        .innerJoin(
          message,
          and(
            eq(message.threadId, deletedMessage.threadId),
            eq(message.seq, deletedMessage.seq),
          ),
        )
        .innerJoin(
          federationMessageDelivery,
          and(
            eq(federationMessageDelivery.peerDomain, peerDomain),
            eq(federationMessageDelivery.messageId, message.id),
          ),
        )
        .where(eq(deletedMessage.threadId, threadId));
      const currentEnd = tail?.end ?? 0n;
      if (after > currentEnd) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'tombstone query cursor is beyond the current thread end',
          HttpStatus.OK,
          { resumeAfter: currentEnd.toString() },
        );
      }
      const queryEnd =
        through === undefined || through > currentEnd ? currentEnd : through;
      const rows = await tx
        .select({
          deletionId: deletedMessage.id,
          threadId: deletedMessage.threadId,
          type: deletedMessage.type,
          deletedAt: deletedMessage.createdAt,
          messageSeq: message.seq,
          originSeq: message.originSeq,
          creatorAccount: user.account,
          creatorDomain: user.domain,
        })
        .from(deletedMessage)
        .innerJoin(
          message,
          and(
            eq(message.threadId, deletedMessage.threadId),
            eq(message.seq, deletedMessage.seq),
          ),
        )
        .innerJoin(user, eq(user.id, message.creator))
        .innerJoin(
          federationMessageDelivery,
          and(
            eq(federationMessageDelivery.peerDomain, peerDomain),
            eq(federationMessageDelivery.messageId, message.id),
          ),
        )
        .where(
          and(
            eq(deletedMessage.threadId, threadId),
            isNull(deletedMessage.federationSourceDomain),
            gt(deletedMessage.id, after),
            lte(deletedMessage.id, queryEnd),
          ),
        )
        .orderBy(asc(deletedMessage.id))
        .limit(take + 1);
      const selected = rows.slice(0, take);
      const addresses = await this.threadAddressesInTx(tx, [threadId]);
      const thread = this.requiredAddress(addresses, threadId);
      const tombstones = selected.map((row) => ({
        deletionSeq: row.deletionId.toString(),
        thread,
        target: {
          creator: {
            account: row.creatorAccount,
            domain: this.wireDomain(row.creatorDomain),
          },
          originSeq: row.originSeq ?? row.messageSeq,
        },
        type: row.type,
        deletedAt: row.deletedAt.getTime(),
      }));
      const scannedThrough =
        rows.length > take ? selected.at(-1)!.deletionId : queryEnd;
      return {
        tombstones,
        scannedThrough: scannedThrough.toString(),
        hasMore: scannedThrough < queryEnd,
      };
    });
  }

  async readAllocatedThrough(peerDomain: string): Promise<bigint> {
    return this.database.db.transaction((tx) =>
      this.readEndInTx(tx, peerDomain),
    );
  }

  private async resolveAuthorizedThread(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<number> {
    const rows =
      selector.type === 'GROUP'
        ? await this.database.db.execute<{ threadId: number }>(sql`
            SELECT thread.id AS "threadId"
            FROM "MessageThread" thread
            JOIN "User" group_user ON group_user.id = thread."groupUserId"
            WHERE thread.type = 'GROUP' AND group_user.account = ${selector.groupAccount}
              AND (CASE WHEN group_user.domain = 'local' THEN ${this.localDomain} ELSE group_user.domain END) = ${selector.groupDomain}
              AND (
                EXISTS (SELECT 1 FROM "ThreadAudience" audience
                  WHERE audience."threadId" = thread.id
                    AND audience."targetDomain" = ${peerDomain}
                    AND audience."localUserId" IS NULL)
                OR EXISTS (
                  SELECT 1 FROM "FederationMessageDelivery" delivery
                  JOIN "Message" delivered_message ON delivered_message.id = delivery."messageId"
                  WHERE delivery."peerDomain" = ${peerDomain}
                    AND delivered_message."threadId" = thread.id
                )
              )
            LIMIT 1
          `)
        : await this.database.db.execute<{ threadId: number }>(sql`
            SELECT thread.id AS "threadId"
            FROM "MessageThread" thread
            WHERE thread.type = 'P2P'
              AND (
                EXISTS (SELECT 1 FROM "ThreadAudience" audience
                  WHERE audience."threadId" = thread.id
                    AND audience."targetDomain" = ${peerDomain}
                    AND audience."localUserId" IS NULL)
                OR EXISTS (
                  SELECT 1 FROM "FederationMessageDelivery" delivery
                  JOIN "Message" delivered_message ON delivered_message.id = delivery."messageId"
                  WHERE delivery."peerDomain" = ${peerDomain}
                    AND delivered_message."threadId" = thread.id
                )
              )
              AND EXISTS (SELECT 1 FROM "ThreadParticipant" p JOIN "User" u ON u.id = p."userId"
                WHERE p."threadId" = thread.id AND u.account = ${selector.account} AND u."isForeigner" = false)
              AND EXISTS (SELECT 1 FROM "ThreadParticipant" p JOIN "User" u ON u.id = p."userId"
                WHERE p."threadId" = thread.id AND u.account = ${selector.peerAccount}
                  AND u."isForeigner" = true AND u.domain = ${peerDomain})
            LIMIT 1
          `);
    const threadId = rows.rows[0]?.threadId;
    if (threadId === undefined) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'the signed peer has neither current access nor a durable message delivery proof for this thread',
        HttpStatus.OK,
      );
    }
    return threadId;
  }

  private async threadAddressesInTx(
    tx: DatabaseTransaction,
    threadIds: number[],
  ): Promise<Map<number, FederationThreadAddress>> {
    if (threadIds.length === 0) return new Map();
    const rows = await tx.execute<{
      threadId: number;
      type: 'P2P' | 'GROUP';
      groupAccount: string | null;
      groupDomain: string | null;
    }>(sql`
      SELECT thread.id AS "threadId", thread.type,
             group_user.account AS "groupAccount", group_user.domain AS "groupDomain"
      FROM "MessageThread" thread
      LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
      WHERE thread.id IN (${sql.join(
        threadIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    const participants = await tx
      .select({
        threadId: threadParticipant.threadId,
        account: user.account,
        domain: user.domain,
      })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.userId))
      .where(inArray(threadParticipant.threadId, threadIds));
    return new Map(
      rows.rows.map((row) => [
        row.threadId,
        row.type === 'GROUP'
          ? {
              type: 'GROUP' as const,
              account: row.groupAccount!,
              domain: this.wireDomain(row.groupDomain!),
            }
          : {
              type: 'P2P' as const,
              participants: participants
                .filter((member) => member.threadId === row.threadId)
                .map((member) => ({
                  account: member.account,
                  domain: this.wireDomain(member.domain),
                }))
                .sort(
                  (a, b) =>
                    a.domain.localeCompare(b.domain) ||
                    a.account.localeCompare(b.account),
                ),
            },
      ]),
    );
  }

  private requiredAddress(
    addresses: Map<number, FederationThreadAddress>,
    threadId: number,
  ): FederationThreadAddress {
    const address = addresses.get(threadId);
    if (!address) throw new Error(`thread ${threadId} has no wire address`);
    return address;
  }

  private async requireTarget(peerDomain: string): Promise<void> {
    const [row] = await this.database.db
      .select({ peerDomain: federationTombstoneServeCursor.peerDomain })
      .from(federationTombstoneServeCursor)
      .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row)
      throw new Error(`peer ${peerDomain} has no tombstone feed target`);
  }

  private async readEndInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
  ): Promise<bigint> {
    const [row] = await tx
      .select({ end: federationTombstoneServeCursor.allocatedThrough })
      .from(federationTombstoneServeCursor)
      .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row)
      throw new Error(`peer ${peerDomain} has no tombstone feed target`);
    return row.end;
  }

  private pageSize(value?: number): number {
    if (value === undefined) return DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be a positive safe integer no greater than 200',
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }

  private invalidThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be greater than or equal to after',
      HttpStatus.BAD_REQUEST,
    );
  }

  private wireDomain(domain: string): string {
    return domain === 'local' ? this.localDomain : domain;
  }
}
