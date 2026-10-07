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
  deletedMessage,
  federatedMessageTombstone,
  fileSyncProgress,
  message,
  messageThread,
  messageReport,
  pendingMedia,
} from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { enqueueMessageFanoutsInTx } from './thread-fanout-task.js';
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
    await tx.insert(deletedMessage).values({
      threadId: params.threadId,
      deletionSeq: allocated.deletionSeq,
      messageSeq: params.messageSeq,
      type: params.type,
      publisherNamespaceId: params.publisherNamespaceId ?? 0,
      updatedAt: params.updatedAt ?? new Date(),
    });
    return { deletionSeq: allocated.deletionSeq, created: true };
  }

  private async assertFederatedResponseWritable(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedFederationVersion: number,
  ): Promise<void> {
    const [state] = await tx
      .select({
        federationVersion: messageThread.federationVersion,
      })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state || state.federationVersion !== expectedFederationVersion) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation deletion response for thread ${threadId}`,
      );
    }
  }

  async queryThread(
    threadId: number,
    after: number | undefined,
    take: number,
    through?: number,
    before?: number,
    maxMessageSeq?: number,
  ) {
    const tail = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { tombstoneEndSeq: true },
    });
    const end = tail?.tombstoneEndSeq ?? 0;
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
    const rows = await this.database.db.query.deletedMessage.findMany({
      where: and(
        eq(deletedMessage.threadId, threadId),
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
      tombstones: selected
        .filter(
          (row) =>
            maxMessageSeq === undefined || row.messageSeq <= maxMessageSeq,
        )
        .map((row) => ({
          deletionSeq: row.deletionSeq,
          threadId: row.threadId,
          messageSeq: row.messageSeq,
          type: row.type,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      scannedThrough,
      hasMore: rows.length > take,
    };
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
      await enqueueMessageFanoutsInTx(tx, threadLock, {
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
    sourceDomain: string,
    namespaceId: number,
    messageSeq: number,
    held?: ThreadContentLock,
  ) {
    const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
    const identity = `${threadId}:${sourceDomain}:${namespaceId}:${messageSeq}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
    );
    return threadLock;
  }

  async applyFederated(params: {
    threadId: number;
    messageSeq: number;
    sourceDomain: string;
    publisherNamespaceId: number;
    remoteDeletionSeq: number;
    type: MessageDeleteType;
    authorityDeletedAt?: Date;
    expectedFederationVersion: number;
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
      peerDomain: string;
      namespaceId: number;
      authority: 'P2P_HOME' | 'GROUP_ORIGIN';
      expectedFederationVersion: number;
      threadLock?: ThreadContentLock;
      resolvedMessage?: typeof message.$inferSelect;
    },
  ): Promise<void> {
    const threadLock = await DeletedMessageService.lockFederatedIdentity(
      tx,
      params.threadId,
      params.peerDomain,
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
        .where(
          and(
            eq(federatedMessageTombstone.threadId, params.threadId),
            eq(
              federatedMessageTombstone.publisherNamespaceId,
              params.namespaceId,
            ),
            eq(federatedMessageTombstone.messageSeq, params.peerSeq),
          ),
        );
      return;
    }
    await this.applyFederatedInTx(tx, {
      threadId: params.threadId,
      messageSeq: params.peerSeq,
      sourceDomain: params.peerDomain,
      publisherNamespaceId: params.namespaceId,
      remoteDeletionSeq: pending.remoteDeletionSeq,
      type: pending.type,
      authorityDeletedAt: pending.authorityDeletedAt,
      authority: params.authority,
      expectedFederationVersion: params.expectedFederationVersion,
      threadLock,
      resolvedMessage: params.resolvedMessage,
    });
  }

  async applyFederatedInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      messageSeq: number;
      sourceDomain: string;
      publisherNamespaceId: number;
      remoteDeletionSeq: number;
      type: MessageDeleteType;
      authorityDeletedAt?: Date;
      authority: 'P2P_HOME' | 'GROUP_ORIGIN' | 'GROUP_MEMBER';
      expectedFederationVersion: number;
      threadLock?: ThreadContentLock;
      resolvedMessage?: typeof message.$inferSelect;
    },
  ) {
    await this.assertFederatedResponseWritable(
      tx,
      params.threadId,
      params.sourceDomain,
      params.publisherNamespaceId,
      params.expectedFederationVersion,
    );
    const threadLock = await DeletedMessageService.lockFederatedIdentity(
      tx,
      params.threadId,
      params.sourceDomain,
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
      target.profileNamespaceId !== params.publisherNamespaceId
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
      columns: { type: true },
    });
    // An earlier pending fact wins over later, differently typed tombstones.
    const effectiveType = pending?.type ?? params.type;
    const ignored =
      target?.publisherNamespaceId === 0 &&
      params.authority === 'GROUP_ORIGIN' &&
      effectiveType === MessageDeleteType.USER_RETRACTION;

    if (!target) {
      if (params.authority === 'GROUP_MEMBER')
        throw new BusinessException(
          BusinessCode.FEDERATION_BINDING_VIOLATION,
          'group origin cannot accept a deletion for an unknown message',
          HttpStatus.BAD_REQUEST,
        );
      if (!pending)
        await tx
          .insert(federatedMessageTombstone)
          .values({
            threadId: params.threadId,
            messageSeq: params.messageSeq,
            publisherNamespaceId: params.publisherNamespaceId,
            remoteDeletionSeq: params.remoteDeletionSeq,
            type: params.type,
            authorityDeletedAt: params.authorityDeletedAt ?? new Date(),
            updatedAt: new Date(),
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
      const now = new Date();
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
      if (localDeletion.created) {
        const head = await tx.query.messageThread.findFirst({
          where: eq(messageThread.id, params.threadId),
          columns: { curSeq: true, tombstoneEndSeq: true },
        });
        if (!head) throw new Error('Deletion thread disappeared');
        await enqueueMessageFanoutsInTx(tx, threadLock, {
          threadId: params.threadId,
          messageEndSeq: head.curSeq,
          tombstoneEndSeq: head.tombstoneEndSeq,
        });
      }
    }
    if (target) {
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
