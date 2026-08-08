import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  discoveryChange,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import { ContentType } from '../database/enums.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { loadFederationConfig } from './federation.config.js';

export const FEDERATION_MISSED_DEFAULT_PAGE_SIZE = 100;
export const FEDERATION_MISSED_MAX_PAGE_SIZE = 200;
const STATEMENT_TIMEOUT_MS = 10_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface FederationMissedAsset {
  digest: string;
  bytes: string;
  status: 'READY' | 'DELETED';
}

export interface FederationMissedMessage {
  changeId: string;
  thread:
    | { type: 'GROUP'; account: string; domain: string }
    | {
        type: 'P2P';
        participants: Array<{ account: string; domain: string }>;
      };
  author: { account: string; domain: string };
  seq: number;
  /** Stable source-author coordinate. Locally-authored messages use their source thread seq. */
  originSeq: number;
  contentType: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  clientMessageId: string | null;
  quoteTarget?: {
    creator: { account: string; domain: string };
    originSeq: number;
  };
  assets: FederationMissedAsset[];
}

export interface FederationMissedPage {
  messages: FederationMissedMessage[];
  scannedThrough: string;
  allocatedThrough: string;
  hasMore: boolean;
}

@Injectable()
export class FederationMissedService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(private readonly cursor: FederationCursorService) {}

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
  ): Promise<FederationMissedPage> {
    const take = this.pageSize(requestedTake);
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const result = await this.cursor.servePage(
      peerDomain,
      after,
      async ({ tx, targetId, allocatedThrough }) => {
        // Both settings are transaction-local. statement_timeout cancels a slow page SQL; the idle
        // timeout is only a final safety net if application code stops progressing after BEGIN.
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`),
        );
        await tx.execute(
          sql.raw(
            `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TRANSACTION_TIMEOUT_MS}ms'`,
          ),
        );
        this.assertBeforeDeadline(deadline);

        const changes = await tx
          .select({
            changeId: discoveryChange.changeId,
            messageId: discoveryChange.messageId,
            threadId: discoveryChange.threadId,
            seq: message.seq,
            originSeq: message.originSeq,
            contentType: message.contentType,
            content: message.content,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            clientMessageId: message.clientMessageId,
            threadType: messageThread.type,
            groupUserId: messageThread.groupUserId,
            authorAccount: user.account,
            authorDomain: user.domain,
          })
          .from(discoveryChange)
          .innerJoin(message, eq(message.id, discoveryChange.messageId))
          .innerJoin(
            messageThread,
            eq(messageThread.id, discoveryChange.threadId),
          )
          .innerJoin(user, eq(user.id, message.creator))
          .where(
            and(
              eq(discoveryChange.targetId, targetId),
              gt(discoveryChange.changeId, after),
              lte(discoveryChange.changeId, allocatedThrough),
              eq(message.isDeleted, false),
            ),
          )
          .orderBy(asc(discoveryChange.changeId))
          .limit(take);
        this.assertBeforeDeadline(deadline);

        const messageIds = changes.map((row) => row.messageId);
        const threadIds = [
          ...new Set(
            changes
              .filter((row) => row.threadType === 'P2P')
              .map((row) => row.threadId),
          ),
        ];
        const groupIds = [
          ...new Set(
            changes
              .map((row) => row.groupUserId)
              .filter((id): id is number => id !== null),
          ),
        ];
        const [assetRows, participantRows, groupRows] = await Promise.all([
          messageIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  messageId: messageAsset.messageId,
                  digest: messageAsset.digest,
                  bytes: mediaAsset.bytes,
                  status: sql<
                    'READY' | 'DELETED'
                  >`CASE WHEN ${mediaAsset.isDeleted} THEN 'DELETED' ELSE 'READY' END`,
                })
                .from(messageAsset)
                .innerJoin(
                  mediaAsset,
                  eq(mediaAsset.digest, messageAsset.digest),
                )
                .where(inArray(messageAsset.messageId, messageIds)),
          threadIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  threadId: threadParticipant.threadId,
                  account: user.account,
                  domain: user.domain,
                })
                .from(threadParticipant)
                .innerJoin(user, eq(user.id, threadParticipant.userId))
                .where(inArray(threadParticipant.threadId, threadIds)),
          groupIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  id: user.id,
                  account: user.account,
                  domain: user.domain,
                })
                .from(user)
                .where(inArray(user.id, groupIds)),
        ]);
        this.assertBeforeDeadline(deadline);

        const assets = new Map<bigint, FederationMissedAsset[]>();
        for (const row of assetRows) {
          const list = assets.get(row.messageId) ?? [];
          list.push({
            digest: row.digest,
            bytes: row.bytes.toString(),
            status: row.status,
          });
          assets.set(row.messageId, list);
        }
        const participants = new Map<
          number,
          Array<{ account: string; domain: string }>
        >();
        for (const row of participantRows) {
          const list = participants.get(row.threadId) ?? [];
          list.push({
            account: row.account,
            domain: this.wireDomain(row.domain),
          });
          participants.set(row.threadId, list);
        }
        const groups = new Map(
          groupRows.map((row) => [
            row.id,
            { account: row.account, domain: this.wireDomain(row.domain) },
          ]),
        );

        // Message content stores a quote as this server's local thread seq. Federation wire data must
        // instead carry the quoted author's stable (address, originSeq) coordinate, because the receiver
        // allocates its own unrelated local seq. Resolve all quoted targets for the page in one query.
        const quoteRefs = new Map<string, { threadId: number; seq: number }>();
        for (const row of changes) {
          if (row.contentType !== ContentType.PURE_TEXT) continue;
          const quoteSeq = parseTextMessageContent(row.content)?.quote?.seq;
          if (quoteSeq !== undefined) {
            quoteRefs.set(`${row.threadId}\u0000${quoteSeq}`, {
              threadId: row.threadId,
              seq: quoteSeq,
            });
          }
        }
        const quotedRows =
          quoteRefs.size === 0
            ? []
            : await tx
                .select({
                  threadId: message.threadId,
                  seq: message.seq,
                  originSeq: message.originSeq,
                  account: user.account,
                  domain: user.domain,
                })
                .from(message)
                .innerJoin(user, eq(user.id, message.creator))
                .where(
                  sql`(${message.threadId}, ${message.seq}) IN (${sql.join(
                    [...quoteRefs.values()].map(
                      (ref) => sql`(${ref.threadId}, ${ref.seq})`,
                    ),
                    sql`, `,
                  )})`,
                );
        const quoteTargets = new Map(
          quotedRows.map((row) => [
            `${row.threadId}\u0000${row.seq}`,
            {
              creator: {
                account: row.account,
                domain: this.wireDomain(row.domain),
              },
              // All newly-created messages persist originSeq=seq. COALESCE keeps old local rows safe
              // during the pre-release migration window.
              originSeq: row.originSeq ?? row.seq,
            },
          ]),
        );

        const messages = changes.map((row): FederationMissedMessage => {
          const group = row.groupUserId
            ? groups.get(row.groupUserId)
            : undefined;
          if (row.threadType === 'GROUP' && !group) {
            throw new Error(
              `group identity missing for thread ${row.threadId}`,
            );
          }
          const quoteSeq =
            row.contentType === ContentType.PURE_TEXT
              ? parseTextMessageContent(row.content)?.quote?.seq
              : undefined;
          const quoteTarget =
            quoteSeq === undefined
              ? undefined
              : quoteTargets.get(`${row.threadId}\u0000${quoteSeq}`);
          if (quoteSeq !== undefined && !quoteTarget) {
            throw new Error(
              `quoted message ${row.threadId}/${quoteSeq} is missing`,
            );
          }
          return {
            changeId: row.changeId.toString(),
            thread: group
              ? { type: 'GROUP', ...group }
              : {
                  type: 'P2P',
                  participants: participants.get(row.threadId) ?? [],
                },
            author: {
              account: row.authorAccount,
              domain: this.wireDomain(row.authorDomain),
            },
            seq: row.seq,
            originSeq: row.originSeq ?? row.seq,
            contentType: row.contentType,
            content: row.content,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
            clientMessageId: row.clientMessageId,
            ...(quoteTarget ? { quoteTarget } : {}),
            assets: assets.get(row.messageId) ?? [],
          };
        });
        this.assertBeforeDeadline(deadline);
        const scannedThrough =
          changes.length === take
            ? changes[changes.length - 1].changeId
            : allocatedThrough;
        return {
          scannedThrough,
          value: {
            messages,
            scannedThrough: scannedThrough.toString(),
            allocatedThrough: allocatedThrough.toString(),
            hasMore: scannedThrough < allocatedThrough,
          },
        };
      },
    );
    return result.value;
  }

  private pageSize(value?: number): number {
    if (value === undefined) return FEDERATION_MISSED_DEFAULT_PAGE_SIZE;
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > FEDERATION_MISSED_MAX_PAGE_SIZE
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `take must be an integer from 1 to ${FEDERATION_MISSED_MAX_PAGE_SIZE}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }

  private assertBeforeDeadline(deadline: number): void {
    if (Date.now() > deadline) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'federation missed request exceeded its application deadline',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private wireDomain(domain: string): string {
    return domain === 'local' ? this.localDomain : domain;
  }
}
