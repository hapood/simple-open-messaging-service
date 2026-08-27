import { HttpStatus, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MessageDeleteType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  deletedMessage,
  federationTombstoneFeedIndex,
  federationTombstoneServeCursor,
  message,
  threadAudience,
  threadMember,
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
  messageSeq: number;
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
    await this.fill(peerDomain);
    const end = await this.database.db.transaction((tx) =>
      this.readEndInTx(tx, peerDomain),
    );
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the tombstone feed cursor',
      HttpStatus.OK,
      { resumeAfter: '0', resumeBefore: (end + 1n).toString() },
    );
  }

  state(_peerDomain: string): FederationFeedFillState {
    void _peerDomain;
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
          threadAudience,
          and(
            eq(threadAudience.threadId, deletedMessage.threadId),
            eq(threadAudience.targetDomain, peerDomain),
            isNull(threadAudience.localUserId),
          ),
        )
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
    void _maxWork;
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
          { resumeAfter: '0', resumeBefore: (end + 1n).toString() },
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
        peerDomain,
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
    const { threadId } = await this.resolveAuthorizedThread(
      peerDomain,
      selector,
    );
    const currentEnd = await this.readThreadEnd(threadId);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the tombstone query cursor',
      HttpStatus.OK,
      { resumeAfter: '0', resumeBefore: (currentEnd + 1n).toString() },
    );
  }

  async query(
    peerDomain: string,
    selector: FederationThreadQuery,
    after: bigint | undefined,
    requestedTake?: number,
    through?: bigint,
    includeSelf = true,
    before?: bigint,
  ): Promise<FederationMessageTombstoneQueryPage> {
    const take = this.pageSize(requestedTake);
    if ((after === undefined) === (before === undefined))
      this.invalidDirection();
    if (after !== undefined && through !== undefined && through < after)
      this.invalidThrough();
    if (before !== undefined && through !== undefined && through > before)
      this.invalidReverseThrough();
    const { threadId, messageAccessAfterSeq } =
      await this.resolveAuthorizedThread(peerDomain, selector);
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
        .where(eq(deletedMessage.threadId, threadId));
      const currentEnd = tail?.end ?? 0n;
      const resumeAfter = 0n;
      const resumeBefore = currentEnd + 1n;
      if (
        (after !== undefined &&
          (after < resumeAfter || after >= resumeBefore)) ||
        (before !== undefined &&
          (before <= resumeAfter + 1n || before > resumeBefore))
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'tombstone query cursor is beyond the current thread end',
          HttpStatus.OK,
          {
            resumeAfter: resumeAfter.toString(),
            resumeBefore: resumeBefore.toString(),
          },
        );
      }
      const forward = after !== undefined;
      const queryEnd = forward
        ? through === undefined || through > currentEnd
          ? currentEnd
          : through
        : 0n;
      const queryStart = forward ? 0n : (through ?? resumeAfter + 1n);
      const queryBefore = forward
        ? 0n
        : before! < resumeBefore
          ? before!
          : resumeBefore;
      const rows = await tx
        .select({
          deletionId: deletedMessage.id,
          threadId: deletedMessage.threadId,
          type: deletedMessage.type,
          deletedAt: deletedMessage.createdAt,
          messageSeq: message.seq,
          originSeq: message.originSeq,
        })
        .from(deletedMessage)
        .innerJoin(
          message,
          and(
            eq(message.threadId, deletedMessage.threadId),
            eq(message.seq, deletedMessage.seq),
          ),
        )
        .where(
          and(
            eq(deletedMessage.threadId, threadId),
            gt(message.seq, messageAccessAfterSeq),
            isNull(deletedMessage.federationSourceDomain),
            includeSelf ? undefined : ne(message.creatorDomain, peerDomain),
            forward
              ? gt(deletedMessage.id, after!)
              : gte(deletedMessage.id, queryStart),
            forward
              ? lte(deletedMessage.id, queryEnd)
              : lt(deletedMessage.id, queryBefore),
          ),
        )
        .orderBy(forward ? asc(deletedMessage.id) : desc(deletedMessage.id))
        .limit(take + 1);
      const selected = rows.slice(0, take);
      const addresses = await this.threadAddressesInTx(
        tx,
        [threadId],
        peerDomain,
      );
      const thread = this.requiredAddress(addresses, threadId);
      const tombstones = selected.map((row) => ({
        deletionSeq: row.deletionId.toString(),
        thread,
        messageSeq: row.originSeq ?? row.messageSeq,
        type: row.type,
        deletedAt: row.deletedAt.getTime(),
      }));
      const scannedThrough =
        rows.length > take
          ? selected.at(-1)!.deletionId
          : forward
            ? queryEnd
            : queryStart;
      return {
        tombstones,
        scannedThrough: scannedThrough.toString(),
        hasMore: forward
          ? scannedThrough < queryEnd
          : scannedThrough > queryStart,
      };
    });
  }

  private async readThreadEnd(threadId: number): Promise<bigint> {
    const [tail] = await this.database.db
      .select({ end: sql<bigint>`COALESCE(MAX(${deletedMessage.id}), 0)` })
      .from(deletedMessage)
      .innerJoin(
        message,
        and(
          eq(message.threadId, deletedMessage.threadId),
          eq(message.seq, deletedMessage.seq),
        ),
      )
      .where(eq(deletedMessage.threadId, threadId));
    return tail?.end ?? 0n;
  }

  private invalidDirection(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'exactly one of after or before is required',
      HttpStatus.BAD_REQUEST,
    );
  }

  private invalidReverseThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be less than or equal to before',
      HttpStatus.BAD_REQUEST,
    );
  }

  async readAllocatedThrough(peerDomain: string): Promise<bigint> {
    return this.database.db.transaction((tx) =>
      this.readEndInTx(tx, peerDomain),
    );
  }

  private async resolveAuthorizedThread(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<{ threadId: number; messageAccessAfterSeq: number }> {
    const rows =
      selector.type === 'GROUP'
        ? await this.database.db.execute<{
            threadId: number;
            messageAccessAfterSeq: number;
          }>(sql`
            SELECT thread.id AS "threadId",
              audience."messageAccessAfterSeq" AS "messageAccessAfterSeq"
            FROM "MessageThread" thread
            JOIN "Group" group_user ON group_user.id = thread."groupId"
            JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
              AND audience."targetDomain" = ${peerDomain}
              AND audience."localUserId" IS NULL
            WHERE thread.type = 'GROUP' AND group_user.account = ${selector.account}
            LIMIT 1
          `)
        : await this.database.db.execute<{
            threadId: number;
            messageAccessAfterSeq: number;
          }>(sql`
            SELECT thread.id AS "threadId",
              audience."messageAccessAfterSeq" AS "messageAccessAfterSeq"
            FROM "MessageThread" thread
            JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
              AND audience."targetDomain" = ${peerDomain}
              AND audience."localUserId" IS NULL
            WHERE thread.type = 'P2P'
              AND EXISTS (SELECT 1 FROM "ThreadMember" p JOIN "User" u ON u.id = p."userId"
                WHERE p."threadId" = thread.id AND u.account = ${selector.account} AND u.domain = 'local')
              AND EXISTS (SELECT 1 FROM "ThreadMember" p JOIN "User" u ON u.id = p."userId"
                WHERE p."threadId" = thread.id AND u.account = ${selector.peerAccount}
                  AND u.domain = ${peerDomain} AND u.domain <> 'local')
            LIMIT 1
          `);
    const authorized = rows.rows[0];
    if (!authorized) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'the signed peer does not currently have access to this thread',
        HttpStatus.OK,
      );
    }
    return authorized;
  }

  private async threadAddressesInTx(
    tx: DatabaseTransaction,
    threadIds: number[],
    peerDomain: string,
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
      LEFT JOIN "Group" group_user ON group_user.id = thread."groupId"
      WHERE thread.id IN (${sql.join(
        threadIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    const participants = await tx
      .select({
        threadId: threadMember.threadId,
        account: user.account,
        domain: user.domain,
      })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .where(inArray(threadMember.threadId, threadIds));
    return new Map(
      rows.rows.map((row) => [
        row.threadId,
        row.type === 'GROUP'
          ? {
              account: row.groupAccount!,
            }
          : this.p2pThreadAddress(row.threadId, participants, peerDomain),
      ]),
    );
  }

  private p2pThreadAddress(
    threadId: number,
    participants: Array<{ threadId: number; account: string; domain: string }>,
    peerDomain: string,
  ): FederationThreadAddress {
    const members = participants.filter(
      (member) => member.threadId === threadId,
    );
    const source = members.find(
      (member) => this.wireDomain(member.domain) === this.localDomain,
    );
    const target = members.find(
      (member) => this.wireDomain(member.domain) === peerDomain,
    );
    if (!source || !target)
      throw new Error(`P2P thread ${threadId} has no peer-relative address`);
    return { account: source.account, peerAccount: target.account };
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
