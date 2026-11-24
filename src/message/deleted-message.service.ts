import { HttpStatus, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { ContentType, MessageDeleteType } from '../database/enums.js';
import {
  accountThreadState,
  deletedMessage,
  federatedMessageTombstone,
  fileSyncProgress,
  message,
  messageReport,
  messageThread,
  pendingMedia,
} from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { enqueueDeletionFanoutsInTx } from './thread-fanout-task.js';
import {
  acquireThreadContentLockInTx,
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';

@Injectable()
export class DeletedMessageService {
  constructor(private readonly database: DatabaseService) {}

  /** Thread locks precede message rows and federated identity locks on every content path. */
  static async lockThreadInTx(tx: DatabaseTransaction, threadId: number) {
    return acquireThreadContentLockInTx(tx, threadId);
  }

  /** Allocate one thread-local deletion coordinate and persist the immutable fact. The thread row is
   * the serialization point for both allocation and target idempotency, so retries consume no sequence. */
  static async ensureFactInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      messageSeq: number;
      type: MessageDeleteType;
      publisherNamespaceId?: number;
      updatedAt?: Date;
      threadLock?: ThreadContentLock;
    },
  ): Promise<{ deletionSeq: number; created: boolean }> {
    await requireThreadContentLockInTx(tx, params.threadId, params.threadLock);
    const existing = await tx.query.deletedMessage.findFirst({
      where: and(
        eq(deletedMessage.threadId, params.threadId),
        eq(deletedMessage.messageSeq, params.messageSeq),
      ),
      columns: { deletionSeq: true },
    });
    if (existing) return { deletionSeq: existing.deletionSeq, created: false };
    const [allocated] = await tx
      .update(messageThread)
      .set({
        tombstoneEndSeq: sql`${messageThread.tombstoneEndSeq} + 1`,
      })
      .where(eq(messageThread.id, params.threadId))
      .returning({
        deletionSeq: messageThread.tombstoneEndSeq,
      });
    if (!allocated) throw new Error('deletion sequence allocation failed');
    const now = params.updatedAt ?? new Date();
    await tx.insert(deletedMessage).values({
      threadId: params.threadId,
      deletionSeq: allocated.deletionSeq,
      messageSeq: params.messageSeq,
      type: params.type,
      publisherNamespaceId: params.publisherNamespaceId ?? 0,
      updatedAt: now,
    });
    return { deletionSeq: allocated.deletionSeq, created: true };
  }

  /** Mark an already stored federated fact consumed. createdAt stays at first receipt. */
  static async markFederatedTombstoneConsumedInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      publisherNamespaceId: number;
      messageSeq: number;
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(federatedMessageTombstone)
      .set({ consumed: true, updatedAt: new Date() })
      .where(
        and(
          eq(federatedMessageTombstone.threadId, params.threadId),
          eq(
            federatedMessageTombstone.publisherNamespaceId,
            params.publisherNamespaceId,
          ),
          eq(federatedMessageTombstone.messageSeq, params.messageSeq),
        ),
      )
      .returning({ id: federatedMessageTombstone.id });
    return updated.length > 0;
  }

  /** Retain a federated fact that is consumed on arrival without allocating a local coordinate. */
  static async retainConsumedFederatedTombstoneInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      publisherNamespaceId: number;
      messageSeq: number;
      remoteDeletionSeq: number;
      type: MessageDeleteType;
      authorityDeletedAt?: Date;
    },
  ): Promise<void> {
    if (await this.markFederatedTombstoneConsumedInTx(tx, params)) return;
    const now = new Date();
    await tx
      .insert(federatedMessageTombstone)
      .values({
        threadId: params.threadId,
        publisherNamespaceId: params.publisherNamespaceId,
        messageSeq: params.messageSeq,
        remoteDeletionSeq: params.remoteDeletionSeq,
        type: params.type,
        authorityDeletedAt: params.authorityDeletedAt ?? now,
        consumed: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          federatedMessageTombstone.threadId,
          federatedMessageTombstone.publisherNamespaceId,
          federatedMessageTombstone.messageSeq,
        ],
        set: { consumed: true, updatedAt: now },
      });
  }

  private async assertFederatedResponseWritable(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<void> {
    const [state] = await tx
      .select({ id: messageThread.id })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation deletion response for thread ${threadId}`,
      );
    }
  }

  async queryThread(
    userId: number,
    threadId: number,
    after: number | undefined,
    take: number,
    through?: number,
    before?: number,
    maxMessageSeq?: number,
  ) {
    return this.database.db.transaction(
      async (tx) => {
        const [scope] = await tx
          .select({
            tombstoneEndSeq: messageThread.tombstoneEndSeq,
            tombstoneVisibleThroughSeq:
              accountThreadState.tombstoneVisibleThroughSeq,
          })
          .from(accountThreadState)
          .innerJoin(
            messageThread,
            eq(messageThread.id, accountThreadState.threadId),
          )
          .where(
            and(
              eq(accountThreadState.accountId, userId),
              eq(accountThreadState.threadId, threadId),
            ),
          )
          .limit(1);
        if (!scope)
          throw new BusinessException(
            BusinessCode.THREAD_NOT_FOUND,
            `no thread [${threadId}]`,
          );
        const end =
          scope.tombstoneVisibleThroughSeq === null
            ? scope.tombstoneEndSeq
            : Math.min(scope.tombstoneEndSeq, scope.tombstoneVisibleThroughSeq);
        const cursorData = {
          resumeAfter: 0,
          resumeBefore: end + 1,
        };
        if (after === undefined && before === undefined)
          throw new BusinessException(
            BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
            'after or before is required; initialize the tombstone query cursor',
            HttpStatus.OK,
            cursorData,
          );
        if (
          (after !== undefined && (after < 0 || after > end)) ||
          (before !== undefined && (before <= 1 || before > end + 1))
        )
          throw new BusinessException(
            BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
            'tombstone query cursor is outside the available coordinate space',
            HttpStatus.OK,
            cursorData,
          );
        const forward = after !== undefined;
        const queryEnd = forward
          ? through === undefined || through > end
            ? end
            : through
          : 0;
        const queryStart = forward ? 0 : (through ?? 1);
        const queryBefore = forward ? 0 : before! < end + 1 ? before! : end + 1;
        const rows = await tx.query.deletedMessage.findMany({
          where: and(
            eq(deletedMessage.threadId, threadId),
            maxMessageSeq === undefined
              ? undefined
              : lte(deletedMessage.messageSeq, maxMessageSeq),
            forward
              ? gt(deletedMessage.deletionSeq, after!)
              : gte(deletedMessage.deletionSeq, queryStart),
            forward
              ? lte(deletedMessage.deletionSeq, queryEnd)
              : lt(deletedMessage.deletionSeq, queryBefore),
          ),
          orderBy: forward
            ? asc(deletedMessage.deletionSeq)
            : desc(deletedMessage.deletionSeq),
          limit: take + 1,
        });
        const selected = rows.slice(0, take);
        const scannedThrough =
          rows.length > take
            ? selected.at(-1)!.deletionSeq
            : forward
              ? queryEnd
              : queryStart;
        return {
          tombstones: selected,
          scannedThrough,
          hasMore: rows.length > take,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async withdraw(
    userId: number,
    threadId: number,
    seq: number,
    onFirstWithdraw?: (tx: DatabaseTransaction) => Promise<void>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const threadLock = await DeletedMessageService.lockThreadInTx(
        tx,
        threadId,
      );
      if (!threadLock)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message not found',
        );
      const locked = await tx.execute(sql`
        SELECT message.id, message."creatorAccount", message."profileNamespaceId",
               message."contentType", message."isDeleted"
        FROM "Message" message
        JOIN "Account" author
         ON author.account = message."creatorAccount"
         AND author."namespaceId" = message."profileNamespaceId"
        WHERE message."threadId" = ${threadId}
          AND message.seq = ${seq}
          AND author.id = ${userId}
        FOR NO KEY UPDATE OF message
      `);
      const target = locked.rows[0] as
        | {
            id: string;
            creatorAccount: string;
            profileNamespaceId: number;
            contentType: string;
            isDeleted: boolean;
          }
        | undefined;
      if (!target || target.contentType === 'SYSTEM') {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message not found',
        );
      }

      const deletionSeq = await this.removeInTx(
        tx,
        threadLock,
        seq,
        MessageDeleteType.USER_RETRACTION,
        onFirstWithdraw,
      );

      return {
        deletionSeq,
        threadId,
        messageSeq: seq,
        creator: {
          account: target.creatorAccount,
          namespaceId: target.profileNamespaceId,
        },
      };
    });
  }

  /** Administrative deletion uses the same transactional writer as withdrawals. */
  async deleteByModeration(threadId: number, seq: number) {
    return this.database.db.transaction(async (tx) => ({
      threadId,
      messageSeq: seq,
      deletionSeq: await this.deleteByModerationInTx(tx, threadId, seq),
    }));
  }

  /** Callers own the transaction; the source write admits durable content projection. */
  async deleteByModerationInTx(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
  ): Promise<number> {
    const threadLock = await DeletedMessageService.lockThreadInTx(tx, threadId);
    if (!threadLock)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'message not found');
    const target = await tx.query.message.findFirst({
      where: and(eq(message.threadId, threadId), eq(message.seq, seq)),
      columns: { contentType: true },
    });
    if (!target || target.contentType === 'SYSTEM')
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'message cannot be deleted',
      );
    return this.removeInTx(
      tx,
      threadLock,
      seq,
      MessageDeleteType.MODERATION_REMOVAL,
    );
  }

  private async removeInTx(
    tx: DatabaseTransaction,
    threadLock: ThreadContentLock,
    seq: number,
    type: MessageDeleteType,
    onFirstDeletion?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<number> {
    const { threadId } = threadLock;
    const now = new Date();
    const deletion = await DeletedMessageService.ensureFactInTx(tx, {
      threadLock,
      threadId,
      messageSeq: seq,
      type,
      updatedAt: now,
    });
    if (deletion.created) {
      await tx
        .update(message)
        .set({ isDeleted: true, updatedAt: now })
        .where(and(eq(message.threadId, threadId), eq(message.seq, seq)));
      // Charge withdrawal quota only once, in the deletion transaction.
      if (onFirstDeletion) await onFirstDeletion(tx);
      const head = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { curSeq: true, tombstoneEndSeq: true },
      });
      if (!head) throw new Error('Deletion thread disappeared');
      await enqueueDeletionFanoutsInTx(tx, threadLock, {
        threadId,
        messageEndSeq: head.curSeq,
        tombstoneEndSeq: head.tombstoneEndSeq,
      });
    }
    await tx
      .update(messageReport)
      .set({ isDeleted: true, updatedAt: now })
      .where(
        and(
          eq(messageReport.threadId, threadId),
          eq(messageReport.seq, seq),
          eq(messageReport.isDeleted, false),
        ),
      );
    return deletion.deletionSeq;
  }

  /** Both deletion arrival and federated message insertion take this exact lock. There need not be a
   * Message row yet, which is why a stable-identity advisory lock is used instead of FOR NO KEY UPDATE. */
  static async lockFederatedIdentity(
    tx: DatabaseTransaction,
    threadId: number,
    namespaceId: number,
    messageSeq: number,
    held?: ThreadContentLock,
  ) {
    const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
    const identity = `${threadId}:${namespaceId}:${messageSeq}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
    );
    return threadLock;
  }

  async applyFederated(params: {
    threadId: number;
    messageSeq: number;
    publisherNamespaceId: number;
    remoteDeletionSeq: number;
    type: MessageDeleteType;
    authorityDeletedAt?: Date;
    authority: 'P2P_HOME' | 'GROUP_ORIGIN' | 'GROUP_MEMBER';
  }) {
    return this.database.db.transaction((tx) =>
      this.applyFederatedInTx(tx, params),
    );
  }

  async applyPendingReceiptInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      peerSeq: number;
      namespaceId: number;
      authority: 'P2P_HOME' | 'GROUP_ORIGIN';
      threadLock?: ThreadContentLock;
      resolvedMessage?: typeof message.$inferSelect;
    },
  ): Promise<void> {
    const threadLock = await DeletedMessageService.lockFederatedIdentity(
      tx,
      params.threadId,
      params.namespaceId,
      params.peerSeq,
      params.threadLock,
    );
    const pending = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(federatedMessageTombstone.threadId, params.threadId),
        eq(federatedMessageTombstone.publisherNamespaceId, params.namespaceId),
        eq(federatedMessageTombstone.messageSeq, params.peerSeq),
      ),
    });
    if (!pending) return;
    if (params.authority === 'P2P_HOME') {
      // A P2P publisher cannot delete a message authored by this server.
      await tx
        .delete(federatedMessageTombstone)
        .where(eq(federatedMessageTombstone.id, pending.id));
      return;
    }
    await this.applyFederatedInTx(tx, {
      threadId: params.threadId,
      messageSeq: params.peerSeq,
      publisherNamespaceId: params.namespaceId,
      remoteDeletionSeq: pending.remoteDeletionSeq,
      type: pending.type,
      authorityDeletedAt: pending.authorityDeletedAt,
      authority: params.authority,
      threadLock,
      resolvedMessage: params.resolvedMessage,
    });
  }

  async applyFederatedInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      messageSeq: number;
      publisherNamespaceId: number;
      remoteDeletionSeq: number;
      type: MessageDeleteType;
      authorityDeletedAt?: Date;
      authority: 'P2P_HOME' | 'GROUP_ORIGIN' | 'GROUP_MEMBER';
      threadLock?: ThreadContentLock;
      resolvedMessage?: typeof message.$inferSelect;
    },
  ) {
    await this.assertFederatedResponseWritable(tx, params.threadId);
    const threadLock = await DeletedMessageService.lockFederatedIdentity(
      tx,
      params.threadId,
      params.publisherNamespaceId,
      params.messageSeq,
      params.threadLock,
    );
    const peerCoordinate = and(
      eq(message.threadId, params.threadId),
      eq(message.publisherNamespaceId, params.publisherNamespaceId),
      eq(message.originSeq, params.messageSeq),
    );
    let target = params.resolvedMessage
      ? {
          seq: params.resolvedMessage.seq,
          creatorAccount: params.resolvedMessage.creatorAccount,
          profileNamespaceId: params.resolvedMessage.profileNamespaceId,
          publisherNamespaceId: params.resolvedMessage.publisherNamespaceId,
          contentType: params.resolvedMessage.contentType,
          isDeleted: params.resolvedMessage.isDeleted,
          localState: params.resolvedMessage.localState,
        }
      : await tx.query.message.findFirst({
          where: peerCoordinate,
          columns: {
            seq: true,
            creatorAccount: true,
            profileNamespaceId: true,
            publisherNamespaceId: true,
            contentType: true,
            isDeleted: true,
            localState: true,
          },
        });
    if (!target && params.authority !== 'GROUP_MEMBER') {
      // A locally authored submission carries the peer-assigned coordinate directly on its
      // row once the peer's processing receipt confirmed it. Only a confirmed row (with the
      // acceptance time) matches; an unconfirmed local row merely mirrors its own seq.
      const confirmedLocal = await tx.query.message.findFirst({
        where: and(
          eq(message.threadId, params.threadId),
          eq(message.publisherNamespaceId, 0),
          eq(message.originSeq, params.messageSeq),
          isNotNull(message.originServerTime),
        ),
        columns: {
          seq: true,
          creatorAccount: true,
          profileNamespaceId: true,
          publisherNamespaceId: true,
          contentType: true,
          isDeleted: true,
          localState: true,
        },
      });
      if (confirmedLocal && params.authority === 'P2P_HOME') {
        // A peer-assigned P2P sequence for our own submission is not a
        // deletion authority, even when the matching peer copy is absent.
        await tx
          .delete(federatedMessageTombstone)
          .where(
            and(
              eq(federatedMessageTombstone.threadId, params.threadId),
              eq(
                federatedMessageTombstone.publisherNamespaceId,
                params.publisherNamespaceId,
              ),
              eq(federatedMessageTombstone.messageSeq, params.messageSeq),
            ),
          );
        return null;
      }
      target = confirmedLocal;
    }
    if (
      target &&
      params.authority === 'P2P_HOME' &&
      messageAuthorHomeNamespaceId(target) !== params.publisherNamespaceId
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'P2P tombstone is not from the message author home',
        HttpStatus.BAD_REQUEST,
      );
    if (
      target &&
      params.authority === 'GROUP_MEMBER' &&
      target.publisherNamespaceId !== params.publisherNamespaceId
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'group member tombstone is not from the message author home',
        HttpStatus.BAD_REQUEST,
      );
    const targetWhere = target
      ? and(eq(message.threadId, params.threadId), eq(message.seq, target.seq))
      : peerCoordinate;
    const pending = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(federatedMessageTombstone.threadId, params.threadId),
        eq(
          federatedMessageTombstone.publisherNamespaceId,
          params.publisherNamespaceId,
        ),
        eq(federatedMessageTombstone.messageSeq, params.messageSeq),
      ),
      columns: { id: true, type: true },
    });
    // An earlier pending fact wins over later, differently typed tombstones.
    const effectiveType = pending?.type ?? params.type;
    const ignored =
      target?.publisherNamespaceId === 0 &&
      params.authority === 'GROUP_ORIGIN' &&
      effectiveType === MessageDeleteType.USER_RETRACTION;

    const now = new Date();
    if (!target) {
      if (!pending)
        await tx
          .insert(federatedMessageTombstone)
          .values({
            threadId: params.threadId,
            messageSeq: params.messageSeq,
            publisherNamespaceId: params.publisherNamespaceId,
            remoteDeletionSeq: params.remoteDeletionSeq,
            type: params.type,
            authorityDeletedAt: params.authorityDeletedAt ?? now,
            consumed: false,
            updatedAt: now,
          })
          .onConflictDoNothing();
    }
    let localDeletionSeq: number | null = null;
    if (target && !ignored) {
      if (
        target.contentType === ContentType.SYSTEM ||
        target.creatorAccount === null
      )
        throw new Error('SYSTEM messages cannot enter deletion processing');
      await tx
        .update(message)
        .set({ isDeleted: true, updatedAt: now })
        .where(targetWhere);
      const localDeletion = await DeletedMessageService.ensureFactInTx(tx, {
        threadLock,
        threadId: params.threadId,
        messageSeq: target.seq,
        type: effectiveType,
        publisherNamespaceId:
          params.authority === 'GROUP_MEMBER' ? 0 : params.publisherNamespaceId,
        updatedAt: now,
      });
      localDeletionSeq = localDeletion.created
        ? localDeletion.deletionSeq
        : null;
      await DeletedMessageService.retainConsumedFederatedTombstoneInTx(tx, {
        threadId: params.threadId,
        publisherNamespaceId: params.publisherNamespaceId,
        messageSeq: params.messageSeq,
        remoteDeletionSeq: params.remoteDeletionSeq,
        type: effectiveType,
        authorityDeletedAt: params.authorityDeletedAt,
      });
      if (localDeletion.created) {
        const head = await tx.query.messageThread.findFirst({
          where: eq(messageThread.id, params.threadId),
          columns: { curSeq: true, tombstoneEndSeq: true },
        });
        if (!head) throw new Error('Deletion thread disappeared');
        await enqueueDeletionFanoutsInTx(tx, threadLock, {
          threadId: params.threadId,
          messageEndSeq: head.curSeq,
          tombstoneEndSeq: head.tombstoneEndSeq,
        });
      }
    } else if (target && pending) {
      // An inapplicable fact is not consumed and must not occupy the client feed.
      await tx
        .delete(federatedMessageTombstone)
        .where(eq(federatedMessageTombstone.id, pending.id));
    }

    // A tombstone makes staged media terminal without waiting for localization.
    const [staged] = await tx
      .select({ batchId: pendingMedia.batchId })
      .from(pendingMedia)
      .innerJoin(message, eq(message.id, pendingMedia.messageId))
      .where(and(eq(pendingMedia.direction, 'INBOUND'), targetWhere))
      .limit(1);
    if (staged) {
      await tx
        .delete(fileSyncProgress)
        .where(eq(fileSyncProgress.batchId, staged.batchId));
      await tx
        .delete(pendingMedia)
        .where(eq(pendingMedia.batchId, staged.batchId));
    }
    return target && !ignored && localDeletionSeq !== null
      ? {
          deletionSeq: localDeletionSeq,
          messageSeq: target.seq,
        }
      : null;
  }
}

/** The namespace whose server is allowed to publish author-home tombstones for a
 * message. Namespace zero in stored profile coordinates means "the publisher's
 * local profile", so a federated mirror row with profile namespace zero belongs
 * to the peer publisher, not to this server. Non-zero profile namespaces name an
 * explicit remote author home and take precedence over the publisher. */
export function messageAuthorHomeNamespaceId(row: {
  profileNamespaceId: number;
  publisherNamespaceId: number;
}): number {
  return row.profileNamespaceId === 0
    ? row.publisherNamespaceId
    : row.profileNamespaceId;
}
