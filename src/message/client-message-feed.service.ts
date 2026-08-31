import { and, asc, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import {
  account,
  clientStateFeed,
  deletedMessage,
  message,
  messageThread,
  threadParticipant,
  threadMember,
  user,
} from '../database/schema.js';
import { planFeedRecipientIds } from './message-delivery-plan.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';

type ClientThreadPreview = {
  seq: number;
  text: string;
  senderId: string | null;
};

type ClientThreadContentHead = {
  threadId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  preview: ClientThreadPreview;
};

/** Transactional writer for THREAD_CONTENT_HEAD in the one device-facing ClientStateFeed.
 *
 * The allocator row is the commit-order lock for one user. Participant ids are always visited in ascending
 * order so two messages delivered to overlapping groups cannot acquire the same allocator rows in opposite
 * order. All callers must invoke these methods inside the transaction that creates the source fact. */
export class ClientThreadContentHeadWriter {
  static async publishMessage(
    tx: DatabaseTransaction,
    threadId: number,
    messageEndSeq: number,
  ): Promise<void> {
    const userIds = await this.activeUserIds(tx, threadId);
    for (const userId of userIds) {
      await this.publishMessageForUser(tx, userId, threadId, messageEndSeq);
    }
  }

  /** Publish to an already-authorized, transactionally captured local recipient set. Boundary SYSTEM
   *  events use this so a relationship can close in the same transaction without a post-close auth query. */
  static async publishMessageToUsers(
    tx: DatabaseTransaction,
    threadId: number,
    messageEndSeq: number,
    userIds: readonly number[],
  ): Promise<void> {
    for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
      await this.publishMessageForUser(tx, userId, threadId, messageEndSeq);
    }
  }

  private static async publishMessageForUser(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
    messageEndSeq: number,
  ): Promise<void> {
    await this.lockOwner(tx, userId);
    const current = await this.readHead(tx, userId, threadId);
    if (current && current.messageEndSeq >= messageEndSeq) return;
    const source = await tx.query.message.findFirst({
      where: and(
        eq(message.threadId, threadId),
        eq(message.seq, messageEndSeq),
      ),
      columns: {
        seq: true,
        contentType: true,
        content: true,
        creatorAccount: true,
        creatorDomain: true,
        creatorNamespaceId: true,
        federationSourceDomain: true,
        isDeleted: true,
      },
    });
    if (!source)
      throw new Error(`missing message ${threadId}:${messageEndSeq}`);
    await this.publishHeadForUser(tx, userId, threadId, {
      threadId,
      messageEndSeq,
      tombstoneEndSeq: current?.tombstoneEndSeq ?? 0,
      preview: source.isDeleted
        ? this.emptyPreview(source.seq)
        : {
            seq: source.seq,
            text: deriveMessagePreview(source.contentType, source.content),
            senderId:
              source.creatorAccount === null || source.creatorDomain === null
                ? null
                : JSON.stringify([
                    source.creatorNamespaceId,
                    source.federationSourceDomain ?? 'local',
                    source.creatorDomain,
                    source.creatorAccount,
                  ]),
          },
    });
  }

  static async publishTombstone(
    tx: DatabaseTransaction,
    threadId: number,
    tombstoneEndSeq: number,
    opts?: { clearPreviewMessageSeq?: number },
  ): Promise<void> {
    const userIds = await this.activeUserIds(tx, threadId);
    for (const userId of userIds) {
      await this.lockOwner(tx, userId);
      const current = await this.readHead(tx, userId, threadId);
      if (current && current.tombstoneEndSeq >= tombstoneEndSeq) continue;
      const thread = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { curSeq: true },
      });
      if (!thread || thread.curSeq < 1)
        throw new Error(`missing message head for thread ${threadId}`);
      const deletion = await tx.query.deletedMessage.findFirst({
        where: and(
          eq(deletedMessage.threadId, threadId),
          eq(deletedMessage.deletionSeq, tombstoneEndSeq),
        ),
        columns: { messageSeq: true },
      });
      if (!deletion)
        throw new Error(`missing tombstone ${threadId}:${tombstoneEndSeq}`);
      await this.publishHeadForUser(tx, userId, threadId, {
        threadId,
        messageEndSeq: current?.messageEndSeq ?? thread.curSeq,
        tombstoneEndSeq,
        preview:
          opts?.clearPreviewMessageSeq !== undefined
            ? this.emptyPreview(opts.clearPreviewMessageSeq)
            : current?.preview.seq === deletion.messageSeq
              ? this.emptyPreview(deletion.messageSeq)
              : (current?.preview ?? this.emptyPreview(thread.curSeq)),
      });
    }
  }

  private static async publishHeadForUser(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
    head: ClientThreadContentHead,
  ): Promise<void> {
    const [owner] = await tx
      .update(account)
      .set({
        stateFeedAllocatedThrough: sql`${account.stateFeedAllocatedThrough} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(account.id, userId))
      .returning({ feedId: account.stateFeedAllocatedThrough });
    if (!owner) throw new Error(`missing client state owner ${userId}`);
    const compactionKey = this.compactionKey(threadId);
    await tx
      .insert(clientStateFeed)
      .values({
        userId,
        compactionKey,
        account: '',
        domain: 'local',
        namespaceId: 0,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: '',
        subjectDomain: 'local',
        feedId: owner.feedId,
        body: head,
      })
      .onConflictDoUpdate({
        target: [clientStateFeed.userId, clientStateFeed.compactionKey],
        set: { feedId: owner.feedId, body: head, updatedAt: new Date() },
      });
  }

  private static async readHead(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
  ): Promise<ClientThreadContentHead | undefined> {
    const row = await tx.query.clientStateFeed.findFirst({
      where: and(
        eq(clientStateFeed.userId, userId),
        eq(clientStateFeed.compactionKey, this.compactionKey(threadId)),
      ),
      columns: { body: true },
    });
    return row?.body as ClientThreadContentHead | undefined;
  }

  private static compactionKey(threadId: number): string {
    return JSON.stringify(['THREAD_CONTENT_HEAD', threadId]);
  }

  private static emptyPreview(seq: number): ClientThreadPreview {
    return { seq, text: '', senderId: null };
  }

  private static async activeUserIds(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<number[]> {
    const rows = await tx
      .select({ userId: threadParticipant.accountId })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.accountId))
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          eq(user.domain, 'local'),
          eq(user.availability, 'AVAILABLE'),
        ),
      )
      .orderBy(asc(threadParticipant.accountId));
    const authorized = await Promise.all(
      rows.map((row) => isThreadMutuallyAuthorized(tx, row.userId, threadId)),
    );
    return planFeedRecipientIds(
      rows.map((row, index) => ({
        userId: row.userId,
        isLocal: true,
        isDeleted: false,
        authorized: authorized[index],
      })),
    );
  }

  private static async lockOwner(
    tx: DatabaseTransaction,
    userId: number,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT 1 FROM "Account" WHERE id = ${userId} FOR UPDATE`,
    );
  }
}
