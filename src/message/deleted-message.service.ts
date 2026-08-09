import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, max, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { MessageDeleteType } from '../database/enums.js';
import {
  deletedMessage,
  federatedMessageTombstone,
  federationDeletedCursor,
  federatedPeer,
  fileSyncProgress,
  message,
  messageThread,
  pendingMedia,
} from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { derivePreview } from './message.service.js';

@Injectable()
export class DeletedMessageService {
  constructor(private readonly database: DatabaseService) {}

  private async assertFederatedResponseWritable(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    expectedFederationVersion: number,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('federation-reset-global', 0))`,
    );
    const [state] = await tx
      .select({
        federationTruncated: messageThread.federationTruncated,
        federationVersion: messageThread.federationVersion,
        trustLevel: federatedPeer.trustLevel,
      })
      .from(messageThread)
      .innerJoin(federatedPeer, eq(federatedPeer.domain, peerDomain))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (
      !state ||
      state.federationTruncated ||
      state.federationVersion !== expectedFederationVersion ||
      state.trustLevel === 'reset_in_progress' ||
      state.trustLevel === 'identity_lost'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation deletion response for thread ${threadId}`,
        HttpStatus.LOCKED,
      );
    }
  }

  async currentHwm(): Promise<string> {
    const [row] = await this.database.db
      .select({ id: max(deletedMessage.id) })
      .from(deletedMessage);
    return (row.id ?? 0n).toString();
  }

  async queryThread(threadId: number, afterId: bigint, take: number) {
    const rows = await this.database.db.query.deletedMessage.findMany({
      where: and(
        eq(deletedMessage.threadId, threadId),
        gt(deletedMessage.id, afterId),
      ),
      orderBy: asc(deletedMessage.id),
      limit: take,
    });
    return rows.map((row) => ({ ...row, id: row.id.toString() }));
  }

  async withdraw(userId: number, threadId: number, seq: number) {
    return this.database.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, creator, "contentType", "isDeleted"
        FROM "Message"
        WHERE "threadId" = ${threadId} AND seq = ${seq}
        FOR UPDATE
      `);
      const target = locked.rows[0] as
        | {
            id: string;
            creator: number;
            contentType: string;
            isDeleted: boolean;
          }
        | undefined;
      if (
        !target ||
        target.creator !== userId ||
        target.contentType === 'INVITE' ||
        target.contentType === 'SYSTEM' ||
        target.contentType === 'CALL'
      ) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message not found',
        );
      }

      const now = new Date();
      await tx
        .update(message)
        .set({ isDeleted: true, updatedAt: now })
        .where(and(eq(message.threadId, threadId), eq(message.seq, seq)));
      const [inserted] = await tx
        .insert(deletedMessage)
        .values({
          threadId,
          seq,
          type: MessageDeleteType.WITHDRAW,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [deletedMessage.threadId, deletedMessage.seq],
        })
        .returning({ id: deletedMessage.id });
      const deletionId =
        inserted?.id ??
        (
          await tx.query.deletedMessage.findFirst({
            where: and(
              eq(deletedMessage.threadId, threadId),
              eq(deletedMessage.seq, seq),
            ),
            columns: { id: true },
          })
        )?.id;
      if (deletionId === undefined)
        throw new Error('deleted message log was not persisted');

      const replacement = await tx.query.message.findFirst({
        where: and(
          eq(message.threadId, threadId),
          eq(message.isDeleted, false),
        ),
        orderBy: [desc(message.createdAt), desc(message.id)],
      });
      await tx
        .update(messageThread)
        .set({
          lastMessageSeq: replacement?.seq ?? null,
          lastMessagePreview: replacement
            ? derivePreview(replacement.contentType, replacement.content)
            : null,
          lastMessageAt: replacement?.createdAt ?? null,
          updatedAt: now,
        })
        .where(eq(messageThread.id, threadId));
      return { id: deletionId.toString(), threadId, seq };
    });
  }

  /** Admin moderation path. The caller owns the surrounding transaction so report status and the
   * deletion fact commit atomically. Idempotency is inherited from DeletedMessage(threadId, seq). */
  async deleteByReportInTx(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
  ): Promise<string> {
    const locked = await tx.execute(sql`
      SELECT id, "isDeleted"
      FROM "Message"
      WHERE "threadId" = ${threadId} AND seq = ${seq}
      FOR UPDATE
    `);
    const target = locked.rows[0] as
      | { id: string; isDeleted: boolean }
      | undefined;
    if (!target) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'message not found');
    }

    const now = new Date();
    await tx
      .update(message)
      .set({ isDeleted: true, updatedAt: now })
      .where(and(eq(message.threadId, threadId), eq(message.seq, seq)));
    const [inserted] = await tx
      .insert(deletedMessage)
      .values({
        threadId,
        seq,
        type: MessageDeleteType.REPORT,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [deletedMessage.threadId, deletedMessage.seq],
      })
      .returning({ id: deletedMessage.id });
    const deletionId =
      inserted?.id ??
      (
        await tx.query.deletedMessage.findFirst({
          where: and(
            eq(deletedMessage.threadId, threadId),
            eq(deletedMessage.seq, seq),
          ),
          columns: { id: true },
        })
      )?.id;
    if (deletionId === undefined)
      throw new Error('deleted message log was not persisted');

    if (!target.isDeleted) {
      const replacement = await tx.query.message.findFirst({
        where: and(
          eq(message.threadId, threadId),
          eq(message.isDeleted, false),
        ),
        orderBy: [desc(message.createdAt), desc(message.id)],
      });
      await tx
        .update(messageThread)
        .set({
          lastMessageSeq: replacement?.seq ?? null,
          lastMessagePreview: replacement
            ? derivePreview(replacement.contentType, replacement.content)
            : null,
          lastMessageAt: replacement?.createdAt ?? null,
          updatedAt: now,
        })
        .where(eq(messageThread.id, threadId));
    }
    return deletionId.toString();
  }

  /** Both deletion arrival and federated message insertion take this exact lock. There need not be a
   * Message row yet, which is why a stable-identity advisory lock is used instead of FOR UPDATE. */
  static lockFederatedIdentity(
    tx: DatabaseTransaction,
    threadId: number,
    creatorId: number,
    originSeq: number,
  ) {
    const identity = `${threadId}:${creatorId}:${originSeq}`;
    return tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
    );
  }

  /** Consume a remote stream item that is intentionally a no-op locally (currently: a group origin
   * relaying this server's own-author tombstone back to it). This never touches Message state. */
  async advanceFederatedCursor(params: {
    threadId: number;
    remoteDeletedId: bigint;
    cursor: { peerDomain: string; streamAccount: string; streamKind: string };
    expectedFederationVersion: number;
  }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.assertFederatedResponseWritable(
        tx,
        params.threadId,
        params.cursor.peerDomain,
        params.expectedFederationVersion,
      );
      await tx
        .insert(federationDeletedCursor)
        .values({
          threadId: params.threadId,
          peerDomain: params.cursor.peerDomain,
          streamAccount: params.cursor.streamAccount,
          streamKind: params.cursor.streamKind,
          deletedHwm: params.remoteDeletedId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            federationDeletedCursor.threadId,
            federationDeletedCursor.peerDomain,
            federationDeletedCursor.streamAccount,
            federationDeletedCursor.streamKind,
          ],
          set: {
            deletedHwm: sql`GREATEST(${federationDeletedCursor.deletedHwm}, ${params.remoteDeletedId})`,
            updatedAt: new Date(),
          },
        });
    });
  }

  async applyFederated(params: {
    threadId: number;
    creatorId: number;
    originSeq: number;
    authorityDomain: string;
    sourceDomain: string;
    remoteDeletedId: bigint;
    type: MessageDeleteType;
    cursor: { peerDomain: string; streamAccount: string; streamKind: string };
    expectedFederationVersion: number;
  }) {
    return this.database.db.transaction(async (tx) => {
      await this.assertFederatedResponseWritable(
        tx,
        params.threadId,
        params.sourceDomain,
        params.expectedFederationVersion,
      );
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        params.threadId,
        params.creatorId,
        params.originSeq,
      );
      await tx
        .insert(federatedMessageTombstone)
        .values({
          threadId: params.threadId,
          creatorId: params.creatorId,
          originSeq: params.originSeq,
          authorityDomain: params.authorityDomain,
          sourceDomain: params.sourceDomain,
          remoteDeletedId: params.remoteDeletedId,
          type: params.type,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      const target = await tx.query.message.findFirst({
        where: and(
          eq(message.threadId, params.threadId),
          eq(message.creator, params.creatorId),
          eq(message.originSeq, params.originSeq),
        ),
        columns: { seq: true, isDeleted: true },
      });
      let localDeletedId: bigint | null = null;
      if (target) {
        const now = new Date();
        await tx
          .update(message)
          .set({ isDeleted: true, updatedAt: now })
          .where(
            and(
              eq(message.threadId, params.threadId),
              eq(message.creator, params.creatorId),
              eq(message.originSeq, params.originSeq),
            ),
          );
        const [created] = await tx
          .insert(deletedMessage)
          .values({
            threadId: params.threadId,
            seq: target.seq,
            type: params.type,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [deletedMessage.threadId, deletedMessage.seq],
          })
          .returning({ id: deletedMessage.id });
        localDeletedId = created?.id ?? null;
        if (!target.isDeleted) {
          const replacement = await tx.query.message.findFirst({
            where: and(
              eq(message.threadId, params.threadId),
              eq(message.isDeleted, false),
            ),
            orderBy: [desc(message.createdAt), desc(message.id)],
          });
          await tx
            .update(messageThread)
            .set({
              lastMessageSeq: replacement?.seq ?? null,
              lastMessagePreview: replacement
                ? derivePreview(replacement.contentType, replacement.content)
                : null,
              lastMessageAt: replacement?.createdAt ?? null,
              updatedAt: now,
            })
            .where(eq(messageThread.id, params.threadId));
        }
      }

      // Download-inbox (§12.8): if the deleted message is still staged, terminate its logical download
      // without destroying resumable digest state. Another authorized message may reference the same
      // digest later, so FileSyncProgress and the shared CAS partial are retained for inspection/reuse.
      // TOMBSTONED is a protocol terminal, distinct from an operator-retryable transfer failure. The
      // advisory lock serializes this with promotion; the message tombstone prevents replay re-staging.
      const staged = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(pendingMedia.threadId, params.threadId),
          eq(pendingMedia.creatorId, params.creatorId),
          eq(pendingMedia.originSeq, params.originSeq),
        ),
        columns: { batchId: true },
      });
      if (staged) {
        await tx
          .update(fileSyncProgress)
          .set({
            status: 'TOMBSTONED',
            errorKind: 'SOURCE_MESSAGE_DELETED',
            updatedAt: new Date(),
          })
          .where(eq(fileSyncProgress.batchId, staged.batchId));
        await tx
          .update(pendingMedia)
          .set({
            status: 'tombstoned',
            anyFailed: true,
            failReason: 'SOURCE_MESSAGE_DELETED',
            updatedAt: new Date(),
          })
          .where(eq(pendingMedia.batchId, staged.batchId));
      }

      await tx
        .insert(federationDeletedCursor)
        .values({
          threadId: params.threadId,
          peerDomain: params.cursor.peerDomain,
          streamAccount: params.cursor.streamAccount,
          streamKind: params.cursor.streamKind,
          deletedHwm: params.remoteDeletedId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            federationDeletedCursor.threadId,
            federationDeletedCursor.peerDomain,
            federationDeletedCursor.streamAccount,
            federationDeletedCursor.streamKind,
          ],
          set: {
            deletedHwm: sql`GREATEST(${federationDeletedCursor.deletedHwm}, ${params.remoteDeletedId})`,
            updatedAt: new Date(),
          },
        });
      return target && localDeletedId !== null
        ? { id: localDeletedId.toString(), seq: target.seq }
        : null;
    });
  }
}
