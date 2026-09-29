import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lte, ne } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MessageDeleteType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { deletedMessage, message, peerStateFeed } from '../database/schema.js';
import {
  type FederationThreadAddress,
  type FederationThreadQuery,
} from './federation-message-feed.service.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

interface FederationMessageTombstoneItem {
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
  private readonly localDomain = 'local';

  constructor(private readonly database: DatabaseService) {}

  async rejectMissingQueryAfter(
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
  ): Promise<never> {
    const currentEnd = await this.database.db.transaction(
      async (tx) => {
        const authorized = await resolveAuthorizedFederationThreadInTx(
          tx,
          peerDomain,
          namespaceId,
          selector,
        );
        return this.readAdvertisedDeletionEnd(
          tx,
          peerDomain,
          namespaceId,
          selector,
        );
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
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
    namespaceId: number,
    selector: FederationThreadQuery,
    after: number,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
    maxMessageSeq?: number,
  ): Promise<FederationMessageTombstoneQueryPage> {
    const take = this.pageSize(requestedTake);
    if (through !== undefined && through < after) this.invalidThrough();
    return this.database.db.transaction(
      async (tx) => {
        const { threadId, address, groupQueryDirection } =
          await resolveAuthorizedFederationThreadInTx(
            tx,
            peerDomain,
            namespaceId,
            selector,
          );
        const currentEnd = await this.readAdvertisedDeletionEnd(
          tx,
          peerDomain,
          namespaceId,
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
              eq(deletedMessage.sourceNamespaceId, 0),
              groupQueryDirection === 'MIRROR_TO_ORIGIN' ||
                selector.type === 'P2P'
                ? eq(message.creatorDomain, 'local')
                : undefined,
              includeSelf ? undefined : ne(message.creatorDomain, peerDomain),
              maxMessageSeq !== undefined
                ? lte(message.seq, maxMessageSeq)
                : undefined,
              gt(deletedMessage.deletionSeq, after),
              lte(deletedMessage.deletionSeq, queryEnd),
            ),
          )
          .orderBy(asc(deletedMessage.deletionSeq))
          .limit(take + 1);
        const selected = rows.slice(0, take);
        const tombstones = selected.map((row) => ({
          deletionSeq: row.deletionSeq,
          thread: address,
          messageSeq: row.messageSeq,
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
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async readAdvertisedDeletionEnd(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
  ): Promise<number> {
    const [row] = await tx
      .select({ body: peerStateFeed.body })
      .from(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, peerDomain),
          eq(peerStateFeed.namespaceId, namespaceId),
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
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be a positive safe integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    return Math.min(value, MAX_PAGE_SIZE);
  }

  private invalidThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be greater than or equal to after',
      HttpStatus.BAD_REQUEST,
    );
  }
}
