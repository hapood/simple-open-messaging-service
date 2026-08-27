import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { ContentType, MessageDeleteType } from '../database/enums.js';
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
import { ClientMessageFeedWriter } from './client-message-feed.service.js';
import {
  MessageService,
  type Message,
  type PublicMessage,
} from './message.service.js';
import { SystemMessageType } from './system-message.js';

@Injectable()
export class DeletedMessageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessageService,
  ) {}

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
        resetInProgress: federatedPeer.resetInProgress,
      })
      .from(messageThread)
      .innerJoin(federatedPeer, eq(federatedPeer.domain, peerDomain))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (
      !state ||
      state.federationTruncated ||
      state.federationVersion !== expectedFederationVersion ||
      state.resetInProgress ||
      state.trustLevel === 'halted'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation deletion response for thread ${threadId}`,
      );
    }
  }

  async queryThread(
    threadId: number,
    after: bigint | undefined,
    take: number,
    through?: bigint,
    before?: bigint,
  ) {
    const [tail] = await this.database.db
      .select({ end: sql<bigint>`COALESCE(MAX(${deletedMessage.id}), 0)` })
      .from(deletedMessage)
      .where(eq(deletedMessage.threadId, threadId));
    const end = tail?.end ?? 0n;
    const cursorData = {
      resumeAfter: '0',
      resumeBefore: (end + 1n).toString(),
    };
    if (after === undefined && before === undefined)
      throw new BusinessException(
        BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
        'after or before is required; initialize the tombstone query cursor',
        HttpStatus.OK,
        cursorData,
      );
    if (
      (after !== undefined && (after < 0n || after > end)) ||
      (before !== undefined && (before <= 1n || before > end + 1n))
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
      : 0n;
    const queryStart = forward ? 0n : (through ?? 1n);
    const queryBefore = forward ? 0n : before! < end + 1n ? before! : end + 1n;
    const rows = await this.database.db.query.deletedMessage.findMany({
      where: and(
        eq(deletedMessage.threadId, threadId),
        forward
          ? gt(deletedMessage.id, after!)
          : gte(deletedMessage.id, queryStart),
        forward
          ? lte(deletedMessage.id, queryEnd)
          : lt(deletedMessage.id, queryBefore),
      ),
      orderBy: forward ? asc(deletedMessage.id) : desc(deletedMessage.id),
      limit: take + 1,
    });
    const selected = rows.slice(0, take);
    const scannedThrough =
      rows.length > take
        ? selected.at(-1)!.id
        : forward
          ? queryEnd
          : queryStart;
    return {
      tombstones: selected.map((row) => ({
        id: row.id.toString(),
        threadId: row.threadId,
        seq: row.seq,
        type: row.type,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      scannedThrough: scannedThrough.toString(),
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
      const locked = await tx.execute(sql`
        SELECT message.id, message."creatorAccount", message."creatorDomain",
               message."contentType", message."isDeleted"
        FROM "Message" message
        JOIN "User" author
          ON author.account = message."creatorAccount"
         AND author.domain = message."creatorDomain"
        WHERE message."threadId" = ${threadId}
          AND message.seq = ${seq}
          AND author.id = ${userId}
        FOR UPDATE
      `);
      const target = locked.rows[0] as
        | {
            id: string;
            creatorAccount: string;
            creatorDomain: string;
            contentType: string;
            isDeleted: boolean;
          }
        | undefined;
      if (
        !target ||
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
          type: MessageDeleteType.USER_RETRACTION,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [deletedMessage.threadId, deletedMessage.seq],
        })
        .returning({ id: deletedMessage.id });
      // A withdrawal is a message-quota event, but retries are idempotent: only the transaction that
      // creates the durable deletion fact may charge it. Keeping the callback in this transaction also
      // rolls the deletion back if its quota gate rejects the operation.
      if (inserted && onFirstWithdraw) await onFirstWithdraw(tx);
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
      await ClientMessageFeedWriter.publishTombstone(tx, threadId, deletionId);
      const systemMessage = inserted
        ? (
            await this.messages.writeSystemMessageInTx(
              tx,
              threadId,
              SystemMessageType.MESSAGE_WITHDRAWN,
              userId,
              { actorUserId: userId },
            )
          ).message
        : null;

      return {
        id: deletionId.toString(),
        threadId,
        seq,
        creator: {
          account: target.creatorAccount,
          domain: target.creatorDomain,
        },
        systemMessage,
      };
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
        type: MessageDeleteType.MODERATION_REMOVAL,
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
    await ClientMessageFeedWriter.publishTombstone(tx, threadId, deletionId);

    return deletionId.toString();
  }

  /** Both deletion arrival and federated message insertion take this exact lock. There need not be a
   * Message row yet, which is why a stable-identity advisory lock is used instead of FOR UPDATE. */
  static lockFederatedIdentity(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    messageSeq: number,
  ) {
    const identity = `${threadId}:${sourceDomain}:${messageSeq}`;
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
    messageSeq: number;
    authorityDomain: string;
    sourceDomain: string;
    remoteDeletedId: bigint;
    type: MessageDeleteType;
    authorityDeletedAt?: Date;
    allowPending?: boolean;
    federationSourceDomain?: string | null;
    cursor: { peerDomain: string; streamAccount: string; streamKind: string };
    expectedFederationVersion: number;
  }) {
    return this.database.db.transaction((tx) =>
      this.applyFederatedInTx(tx, params),
    );
  }

  async applyFederatedInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      messageSeq: number;
      authorityDomain: string;
      sourceDomain: string;
      remoteDeletedId: bigint;
      type: MessageDeleteType;
      authorityDeletedAt?: Date;
      /** Group origins reject unmatched member submissions instead of treating them as facts. */
      allowPending?: boolean;
      /** Null means this server accepted the deletion as its own authoritative group fact. */
      federationSourceDomain?: string | null;
      cursor?: {
        peerDomain: string;
        streamAccount: string;
        streamKind: string;
      };
      expectedFederationVersion: number;
    },
  ) {
    await this.assertFederatedResponseWritable(
      tx,
      params.threadId,
      params.sourceDomain,
      params.expectedFederationVersion,
    );
    await DeletedMessageService.lockFederatedIdentity(
      tx,
      params.threadId,
      params.sourceDomain,
      params.messageSeq,
    );
    const target = await tx.query.message.findFirst({
      where: and(
        eq(message.threadId, params.threadId),
        eq(message.federationSourceDomain, params.sourceDomain),
        eq(message.originSeq, params.messageSeq),
      ),
      columns: {
        seq: true,
        creatorAccount: true,
        creatorDomain: true,
        contentType: true,
        isDeleted: true,
      },
    });
    const pending = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(federatedMessageTombstone.threadId, params.threadId),
        eq(federatedMessageTombstone.sourceDomain, params.sourceDomain),
        eq(federatedMessageTombstone.messageSeq, params.messageSeq),
      ),
      columns: {
        authorityDomain: true,
        type: true,
        authorityDeletedAt: true,
      },
    });
    if (
      pending &&
      (pending.authorityDomain !== params.authorityDomain ||
        pending.type !== params.type ||
        (params.authorityDeletedAt !== undefined &&
          pending.authorityDeletedAt.getTime() !==
            params.authorityDeletedAt.getTime()))
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated tombstone conflicts with an existing stable fact',
        HttpStatus.BAD_REQUEST,
      );

    if (!target) {
      if (params.allowPending === false)
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
            authorityDomain: params.authorityDomain,
            sourceDomain: params.sourceDomain,
            remoteDeletedId: params.remoteDeletedId,
            type: params.type,
            authorityDeletedAt: params.authorityDeletedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
    }
    let localDeletedId: bigint | null = null;
    let systemMessage: PublicMessage | null = null;
    if (target) {
      if (
        target.contentType === ContentType.SYSTEM ||
        target.creatorAccount === null ||
        target.creatorDomain === null
      )
        throw new Error('SYSTEM messages cannot enter deletion processing');
      const now = new Date();
      await tx
        .update(message)
        .set({ isDeleted: true, updatedAt: now })
        .where(
          and(
            eq(message.threadId, params.threadId),
            eq(message.federationSourceDomain, params.sourceDomain),
            eq(message.originSeq, params.messageSeq),
          ),
        );
      const [created] = await tx
        .insert(deletedMessage)
        .values({
          threadId: params.threadId,
          seq: target.seq,
          type: params.type,
          federationSourceDomain:
            params.federationSourceDomain === undefined
              ? params.sourceDomain
              : params.federationSourceDomain,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [deletedMessage.threadId, deletedMessage.seq],
        })
        .returning({ id: deletedMessage.id });
      localDeletedId = created?.id ?? null;
      if (localDeletedId !== null)
        await ClientMessageFeedWriter.publishTombstone(
          tx,
          params.threadId,
          localDeletedId,
        );
      if (localDeletedId !== null) {
        systemMessage = (
          await this.messages.writeSystemMessageInTx(
            tx,
            params.threadId,
            params.type === MessageDeleteType.USER_RETRACTION
              ? SystemMessageType.MESSAGE_WITHDRAWN
              : SystemMessageType.MESSAGES_MODERATED,
            undefined,
            params.type === MessageDeleteType.MODERATION_REMOVAL
              ? { count: 1 }
              : {
                  subjectAddress: {
                    account: target.creatorAccount,
                    domain: target.creatorDomain,
                  },
                  actorAddress: {
                    account: target.creatorAccount,
                    domain: target.creatorDomain,
                  },
                },
          )
        ).message;
      } else {
        systemMessage = null;
      }
      // This table is only an unmatched-deletion inbox. Once the target exists, DeletedMessage is
      // the durable local fact and the pending row must disappear in the same transaction.
      await tx
        .delete(federatedMessageTombstone)
        .where(
          and(
            eq(federatedMessageTombstone.threadId, params.threadId),
            eq(federatedMessageTombstone.sourceDomain, params.sourceDomain),
            eq(federatedMessageTombstone.messageSeq, params.messageSeq),
          ),
        );
    }

    // Download-inbox (§12.8): if the deleted message is still staged, terminate its logical download
    // without destroying resumable digest state. Another authorized message may reference the same
    // digest later, so FileSyncProgress and the shared CAS partial are retained for inspection/reuse.
    // TOMBSTONED is a protocol terminal, distinct from an operator-retryable transfer failure. The
    // advisory lock serializes this with promotion; the message tombstone prevents replay re-staging.
    const staged = await tx.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.threadId, params.threadId),
        eq(pendingMedia.originDomain, params.sourceDomain),
        eq(pendingMedia.originSeq, params.messageSeq),
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

      // A quote waiting for this staged target can never acquire a local seq after the authoritative
      // deletion. It has no useful terminal representation, so remove the whole dependent chain.
      await tx.execute(sql`
        WITH RECURSIVE dependents AS (
          SELECT child."batchId", child."threadId", child."originDomain", child."originSeq"
            FROM "PendingMedia" child
           WHERE child."threadId" = ${params.threadId}
             AND child."originDomain" = ${params.sourceDomain}
             AND child."dependsOnOriginSeq" = ${params.messageSeq}
          UNION
          SELECT child."batchId", child."threadId", child."originDomain", child."originSeq"
            FROM "PendingMedia" child
            JOIN dependents parent
              ON child."threadId" = parent."threadId"
             AND child."originDomain" = parent."originDomain"
             AND child."dependsOnOriginSeq" = parent."originSeq"
        )
        DELETE FROM "FileSyncProgress"
         WHERE "batchId" IN (SELECT "batchId" FROM dependents)
      `);
      await tx.execute(sql`
        WITH RECURSIVE dependents AS (
          SELECT child."batchId", child."threadId", child."originDomain", child."originSeq"
            FROM "PendingMedia" child
           WHERE child."threadId" = ${params.threadId}
             AND child."originDomain" = ${params.sourceDomain}
             AND child."dependsOnOriginSeq" = ${params.messageSeq}
          UNION
          SELECT child."batchId", child."threadId", child."originDomain", child."originSeq"
            FROM "PendingMedia" child
            JOIN dependents parent
              ON child."threadId" = parent."threadId"
             AND child."originDomain" = parent."originDomain"
             AND child."dependsOnOriginSeq" = parent."originSeq"
        )
        DELETE FROM "PendingMedia"
         WHERE "batchId" IN (SELECT "batchId" FROM dependents)
      `);
    }

    if (params.cursor) {
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
    }
    return target && localDeletedId !== null
      ? {
          id: localDeletedId.toString(),
          seq: target.seq,
          systemMessage: systemMessage!,
        }
      : null;
  }
}
