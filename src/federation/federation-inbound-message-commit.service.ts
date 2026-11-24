import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { MessageDeleteType } from '../database/enums.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { enqueueMessageFanoutsInTx } from '../message/thread-fanout-task.js';
import {
  FederationInboundMessagePageService,
  type PreparedMessageWrite,
  type MessagePageWriteContext,
  type FederationMessagePageEffect,
} from './federation-inbound-message-page.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import type { FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import type { FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';

export interface MessagePageCommit extends MessagePageWriteContext {
  messages: readonly PreparedMessageWrite[];
  peerToken: FederationThreadResourceResponse<unknown>['peerToken'];
}

export interface ForwardTombstonePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
  frozenTargetSeq: number;
}

export interface ForwardTombstonePageEffect {
  deletions: { messageSeq: number; deletionSeq: number }[];
}

/** Commits fetched message and tombstone pages inside caller-owned cursor transactions. */
@Injectable()
export class FederationInboundMessageCommitService {
  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly pages: FederationInboundMessagePageService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly deletedMessages: DeletedMessageService,
  ) {}

  async commitMessagePageInTx(
    tx: DatabaseTransaction,
    params: MessagePageCommit,
  ): Promise<FederationMessagePageEffect[]> {
    const { threadId } = params.threadLock;
    const threadLock = await requireThreadContentLockInTx(
      tx,
      threadId,
      params.threadLock,
    );
    const { left, right } = params.processedInterval;
    if (
      !Number.isSafeInteger(left) ||
      !Number.isSafeInteger(right) ||
      left < 0 ||
      right < left
    )
      throw new Error('invalid processed message interval');
    for (const prepared of params.messages) {
      if (prepared.item.seq <= left || prepared.item.seq > right)
        throw new Error('prepared message is outside the processed interval');
    }
    const head = await tx.execute<{ seq: number }>(sql`
      SELECT COALESCE(MAX(seq), 0)::integer AS seq FROM "Message"
      WHERE "threadId" = ${threadId}
    `);
    const previousSeq = head.rows[0]?.seq ?? 0;
    const effects = await this.pages.applyPrepared(
      tx,
      params.messages,
      params.peerToken,
      params,
    );
    if (effects.length === 0) return effects;
    const writtenSeqs = effects.map((effect) =>
      effect.kind === 'pending' ? effect.seq : effect.message.seq,
    );
    // Finalize only this page's new rows. Media publication has its own barrier.
    const finalized = await tx.execute<{ seq: number }>(sql`
      UPDATE "Message" staged
      SET "localState" = 'READY', "updatedAt" = CURRENT_TIMESTAMP
      WHERE staged."threadId" = ${threadId}
        AND staged."publisherNamespaceId" = ${params.peerToken.namespaceId}
        AND staged.seq IN (${sql.join(
          writtenSeqs.map((seq) => sql`${seq}`),
          sql`, `,
        )})
        AND staged."localState" = 'STUB'
        AND NOT EXISTS (
          SELECT 1 FROM "PendingMedia" pending
          WHERE pending."messageId" = staged.id
        )
      RETURNING staged.seq
    `);
    const readySeqs = new Set(finalized.rows.map((row) => row.seq));
    for (const effect of effects) {
      if (effect.kind === 'message' && readySeqs.has(effect.message.seq))
        effect.message.localState = 'READY';
    }
    await tx.execute(sql`
      UPDATE "MessageThread"
      SET "curSeq" = GREATEST("curSeq", ${Math.max(...writtenSeqs)})
      WHERE id = ${threadId}
    `);
    const next = await tx.execute<{ seq: number; tombstoneEndSeq: number }>(sql`
      SELECT COALESCE(MAX(message.seq), 0)::integer AS seq, thread."tombstoneEndSeq"
      FROM "MessageThread" thread
      LEFT JOIN "Message" message ON message."threadId" = thread.id
      WHERE thread.id = ${threadId}
      GROUP BY thread.id, thread."tombstoneEndSeq"
    `);
    if (next.rows[0] && next.rows[0].seq > previousSeq) {
      await enqueueMessageFanoutsInTx(tx, threadLock, {
        threadId,
        messageEndSeq: next.rows[0].seq,
        tombstoneEndSeq: next.rows[0].tombstoneEndSeq,
      });
    }
    return effects;
  }

  async applyTombstonesInTransaction(
    tx: DatabaseTransaction,
    params: ForwardTombstonePageCommit,
  ): Promise<ForwardTombstonePageEffect> {
    await this.threadAccess.assertResourceResponseWritable(tx, params.response);
    const threadLock = await requireThreadContentLockInTx(
      tx,
      params.response.threadId,
      params.threadLock,
    );
    const deletions: { messageSeq: number; deletionSeq: number }[] = [];
    for (const item of params.response.data.tombstones) {
      if (
        !Number.isSafeInteger(item.deletionSeq) ||
        item.deletionSeq < 1 ||
        !Number.isSafeInteger(item.messageSeq) ||
        item.messageSeq < 1 ||
        !Number.isSafeInteger(item.deletedAt) ||
        item.deletedAt < 0 ||
        ![
          MessageDeleteType.USER_RETRACTION,
          MessageDeleteType.MODERATION_REMOVAL,
        ].includes(item.type)
      )
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'peer returned an invalid thread tombstone',
          HttpStatus.BAD_REQUEST,
        );
      const route = await this.routes.resolveTombstone(
        tx,
        item.thread,
        params.response.peerToken.namespaceId,
        params.response.peerToken.peerAssignedLocalNamespaceId,
        item.messageSeq,
      );
      if (route.threadId !== params.response.threadId)
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'tombstone query returned an item for a different thread',
          HttpStatus.BAD_REQUEST,
        );
      const deletion = await this.deletedMessages.applyFederatedInTx(tx, {
        threadLock,
        threadId: route.threadId,
        messageSeq: item.messageSeq,
        publisherNamespaceId: params.response.peerToken.namespaceId,
        remoteDeletionSeq: item.deletionSeq,
        type: item.type,
        authorityDeletedAt: new Date(item.deletedAt),
        authority: route.authority,
      });
      if (deletion) deletions.push(deletion);
    }
    return {
      deletions,
    };
  }
}
