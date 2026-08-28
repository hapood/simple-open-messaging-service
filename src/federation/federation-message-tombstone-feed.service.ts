import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MessageDeleteType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  deletedMessage,
  message,
  peerStateFeed,
  threadMember,
  user,
} from '../database/schema.js';
import {
  type FederationThreadAddress,
  type FederationThreadQuery,
} from './federation-message-feed.service.js';
import { loadFederationConfig } from './federation.config.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export interface FederationMessageTombstoneItem {
  deletionSeq: number;
  thread: FederationThreadAddress;
  messageSeq: number;
  type: MessageDeleteType;
  deletedAt: number;
}

export interface FederationMessageTombstoneQueryPage {
  tombstones: FederationMessageTombstoneItem[];
  scannedThrough: number;
  hasMore: boolean;
}

@Injectable()
export class FederationMessageTombstoneFeedService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(private readonly database: DatabaseService) {}

  async rejectMissingQueryAfter(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<never> {
    await this.resolveAuthorizedThread(peerDomain, selector);
    const currentEnd = await this.database.db.transaction((tx) =>
      this.readAdvertisedDeletionEnd(tx, peerDomain, selector),
    );
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the tombstone query cursor',
      HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: currentEnd + 1 },
    );
  }

  async query(
    peerDomain: string,
    selector: FederationThreadQuery,
    after: number,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
    maxMessageSeq?: number,
  ): Promise<FederationMessageTombstoneQueryPage> {
    const take = this.pageSize(requestedTake);
    if (through !== undefined && through < after) this.invalidThrough();
    const { threadId, messageAccessAfterSeq } =
      await this.resolveAuthorizedThread(peerDomain, selector);
    return this.database.db.transaction(async (tx) => {
      const currentEnd = await this.readAdvertisedDeletionEnd(
        tx,
        peerDomain,
        selector,
      );
      const resumeAfter = 0;
      const resumeBefore = currentEnd + 1;
      if (after < resumeAfter || after >= resumeBefore) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'tombstone query cursor is beyond the current thread end',
          HttpStatus.OK,
          {
            resumeAfter,
            resumeBefore,
          },
        );
      }
      const queryEnd =
        through === undefined || through > currentEnd ? currentEnd : through;
      const rows = await tx
        .select({
          deletionSeq: deletedMessage.deletionSeq,
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
            eq(message.seq, deletedMessage.messageSeq),
          ),
        )
        .where(
          and(
            eq(deletedMessage.threadId, threadId),
            gt(message.seq, messageAccessAfterSeq),
            isNull(deletedMessage.federationSourceDomain),
            includeSelf ? undefined : ne(message.creatorDomain, peerDomain),
            maxMessageSeq !== undefined
              ? lte(
                  sql<number>`COALESCE(${message.originSeq}, ${message.seq})`,
                  maxMessageSeq,
                )
              : undefined,
            gt(deletedMessage.deletionSeq, after),
            lte(deletedMessage.deletionSeq, queryEnd),
          ),
        )
        .orderBy(asc(deletedMessage.deletionSeq))
        .limit(take + 1);
      const selected = rows.slice(0, take);
      const addresses = await this.threadAddressesInTx(
        tx,
        [threadId],
        peerDomain,
      );
      const thread = this.requiredAddress(addresses, threadId);
      const tombstones = selected.map((row) => ({
        deletionSeq: row.deletionSeq,
        thread,
        messageSeq: row.originSeq ?? row.messageSeq,
        type: row.type,
        deletedAt: row.deletedAt.getTime(),
      }));
      const scannedThrough =
        rows.length > take ? selected.at(-1)!.deletionSeq : queryEnd;
      return {
        tombstones,
        scannedThrough,
        hasMore: scannedThrough < queryEnd,
      };
    });
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

  private async readAdvertisedDeletionEnd(
    tx: DatabaseTransaction,
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<number> {
    const [row] = await tx
      .select({ body: peerStateFeed.body })
      .from(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, peerDomain),
          eq(peerStateFeed.account, selector.account),
          eq(peerStateFeed.domain, this.localDomain),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          selector.type === 'P2P'
            ? and(
                eq(peerStateFeed.subjectAccount, selector.peerAccount),
                eq(peerStateFeed.subjectDomain, peerDomain),
              )
            : and(
                eq(peerStateFeed.subjectAccount, ''),
                eq(peerStateFeed.subjectDomain, 'local'),
              ),
        ),
      )
      .limit(1);
    const value = (row?.body as { tombstoneEndSeq?: unknown } | undefined)
      ?.tombstoneEndSeq;
    return Number.isSafeInteger(value) && Number(value) >= 0
      ? Number(value)
      : 0;
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
