import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { ThreadFeedQueryDto } from '../dto/message.dto.js';
import { ThreadPreviewService } from './thread-preview.service.js';
import { toDisplayText } from '../common/message-entity.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';

interface ThreadFeedPreview {
  seq: number;
  createdAt: string;
  sender: { account: string; namespaceId: number; profileRev: number };
  status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  text?: string;
}

interface ThreadFeedState {
  type: 'P2P' | 'GROUP';
  authorityNamespaceId: number;
  conversationState: 'ACTIVE' | 'READ_ONLY';
  blocked: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  profile: { account: string; namespaceId: number; profileRev: number };
  alias: string | null;
  threadId: number;
  threadFeedId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: string | null;
  joinRequestEndFeedId: number;
  joinRequestReadFeedId: number;
  groupInviteEndFeedId: number;
  threadProfileRev: number;
  profileSourceId: number | null;
  lastReadSeq: number;
  announcementReadFeedId: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  previews?: ThreadFeedPreview[];
}

/** Unified compacted thread snapshots. */
@Injectable()
export class ThreadFeedService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(private readonly database: DatabaseService) {}

  async readEndId(accountId: number): Promise<number> {
    const result = await this.database.db.execute<{ head: number }>(sql`
      SELECT "threadFeedEndId" AS head FROM "Account" WHERE id = ${accountId}`);
    if (!result.rows[0]) throw new Error('Thread feed account not found');
    return result.rows[0].head;
  }

  async queryThreadFeedDelta(accountId: number, request: ThreadFeedQueryDto) {
    const previewCount = request.previewCount ?? 0;
    if (
      !Number.isSafeInteger(previewCount) ||
      previewCount < 0 ||
      (previewCount > 0 && previewCount > this.previews.limit)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'previewCount exceeds the configured preview limit',
      );
    return this.database.db.transaction(
      async (tx) => {
        const result = await tx.execute<{ threadFeedEndId: number }>(sql`
        SELECT "threadFeedEndId" FROM "Account" WHERE id = ${accountId}`);
        const head = result.rows[0]?.threadFeedEndId;
        if (head === undefined)
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'account not found',
          );
        const through = request.through ?? head;
        if (request.after > through || through > head) {
          throw new BusinessException(
            BusinessCode.THREAD_FEED_CURSOR_INVALID,
            'invalid attention feed range',
          );
        }
        const take = request.take ?? 100;
        const resultRows = await tx.execute<
          Omit<ThreadFeedState, 'groupMetaFeedEndId' | 'profile'> & {
            groupMetaFeedEndId: number | null;
            profileAccount: string;
            profileNamespaceId: number;
            profileRev: number;
          }
        >(sql`
        SELECT s."threadId", s."threadFeedId", s.alias, s."messageEndSeq", s."tombstoneEndSeq",
               s."groupMetaFeedEndId", s."joinRequestEndFeedId",
               s."joinRequestReadFeedId", s."groupInviteEndFeedId",
               s."threadProfileRev", s."profileSourceId", s."lastReadSeq", s."announcementReadFeedId",
               s."unreadCount", s."lastMentionSeq", t.type, t."authorityNamespaceId",
               CASE WHEN pair.active THEN 'ACTIVE' ELSE 'READ_ONLY' END AS "conversationState",
               s.blocked, CASE WHEN pair.active THEN s.role ELSE NULL END AS role,
               CASE WHEN t.type = 'GROUP' THEN t."groupAccount"
                 WHEN pair."endpointAAccount" = self.account
                   THEN pair."endpointBAccount" ELSE pair."endpointAAccount" END AS "profileAccount",
               CASE WHEN t.type = 'GROUP' THEN t."authorityNamespaceId"
                 WHEN pair."endpointAAccount" = self.account
                   THEN pair."endpointBNamespaceId" ELSE pair."endpointANamespaceId" END AS "profileNamespaceId",
               s."threadProfileRev" AS "profileRev"
        FROM "AccountThreadState" s
        JOIN "Account" self ON self.id = s."accountId"
        JOIN "MessageThread" t ON t.id = s."threadId"
        JOIN "RelationshipPair" pair ON pair."threadId" = t.id AND pair.established
          AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = self.account
            AND pair."endpointANamespaceId" = 0)
            OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = self.account
              AND pair."endpointBNamespaceId" = 0))
        LEFT JOIN "IdentityNamespace" peer_ns
          ON peer_ns.id = CASE WHEN t.type = 'GROUP' THEN t."authorityNamespaceId"
            WHEN pair."endpointAAccount" = self.account
              THEN pair."endpointBNamespaceId" ELSE pair."endpointANamespaceId" END
        WHERE s."accountId" = ${accountId}
          AND s."threadFeedId" > ${request.after} AND s."threadFeedId" <= ${through}
        ORDER BY s."threadFeedId" LIMIT ${take + 1}`);
        const hasMore = resultRows.rows.length > take;
        const items: ThreadFeedState[] = resultRows.rows
          .slice(0, take)
          .map(
            ({ profileAccount, profileNamespaceId, profileRev, ...item }) => ({
              ...item,
              profile: {
                account: profileAccount,
                namespaceId: profileNamespaceId,
                profileRev,
              },
              groupMetaFeedEndId:
                item.groupMetaFeedEndId === null
                  ? null
                  : String(item.groupMetaFeedEndId),
            }),
          );
        if (previewCount > 0) {
          for (const item of items) {
            item.previews = (
              await this.previews.readInTx(
                tx,
                accountId,
                item.threadId,
                previewCount,
              )
            ).map(
              (preview): ThreadFeedPreview => ({
                seq: preview.seq,
                createdAt: new Date(preview.createdAt).toISOString(),
                sender: {
                  account: preview.creatorAccount,
                  namespaceId: preview.profileNamespaceId,
                  profileRev: preview.profileRev,
                },
                status: preview.isDeleted ? preview.deletionType! : 'LIVE',
                ...(!preview.isDeleted
                  ? {
                      text: deriveMessagePreview(
                        preview.contentType!,
                        preview.content!,
                        toDisplayText,
                      ),
                    }
                  : {}),
              }),
            );
          }
        }
        return {
          threadFeedEndId: head,
          through,
          scannedThrough: hasMore
            ? items[items.length - 1].threadFeedId
            : through,
          hasMore,
          items,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
