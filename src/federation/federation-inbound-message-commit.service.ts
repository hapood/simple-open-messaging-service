import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { MessageDeleteType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { type ForwardWireBundle } from '../forward/forward-bundle.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { ClientThreadContentHeadWriter } from '../message/client-message-feed.service.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import {
  FederationInboundMessagePageService,
  type FederationMessagePageEffect,
} from './federation-inbound-message-page.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import type { FederationMessageQueryPage } from './federation-message-feed.service.js';
import type { FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import type { FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../relationship/thread-content-lock.js';

export interface ReverseMessagePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  before: number;
  through?: number;
  messageSeqOffset: number;
  prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
}

export interface ForwardMessagePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  after: number;
  frozenTargetSeq: number;
  prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
}

export interface ForwardTombstonePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
  frozenTargetSeq: number;
}

interface SatisfiedQuoteDependency {
  threadId: number;
  sourceNamespaceId: number;
  originSeq: number;
}

export interface ForwardTombstonePageEffect {
  quoteDependencies: SatisfiedQuoteDependency[];
  recipientUserIds: number[];
  relayDeletion?: boolean;
}

/** Commits fetched message and tombstone pages inside caller-owned cursor transactions. */
@Injectable()
export class FederationInboundMessageCommitService {
  constructor(
    private readonly database: DatabaseService,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly pages: FederationInboundMessagePageService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly deletedMessages: DeletedMessageService,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
  ) {}

  async applyReverseInTransaction(
    tx: DatabaseTransaction,
    params: ReverseMessagePageCommit,
  ): Promise<FederationMessagePageEffect[]> {
    await this.threadAccess.assertResourceResponseWritable(tx, params.response);
    const threadLock = await requireThreadContentLockInTx(
      tx,
      params.response.threadId,
      params.threadLock,
    );
    return this.pages.apply(
      tx,
      params.response.peerDomain,
      params.response.data.messages,
      params.response.peerToken,
      {
        threadLock,
        prefetchedForwardClosures: params.prefetchedForwardClosures,
        sequencePolicy: {
          kind: 'MAP_ORIGIN',
          beforeSeq: params.before,
          messageSeqOffset: params.messageSeqOffset,
          ...(params.through === undefined
            ? {}
            : { throughSeq: params.through }),
        },
        expectedThreadId: params.response.threadId,
        historical: true,
      },
    );
  }

  async applyForwardInTransaction(
    tx: DatabaseTransaction,
    params: ForwardMessagePageCommit,
  ): Promise<FederationMessagePageEffect[]> {
    await this.threadAccess.assertResourceResponseWritable(tx, params.response);
    const threadLock = await requireThreadContentLockInTx(
      tx,
      params.response.threadId,
      params.threadLock,
    );
    return this.pages.apply(
      tx,
      params.response.peerDomain,
      params.response.data.messages,
      params.response.peerToken,
      {
        threadLock,
        prefetchedForwardClosures: params.prefetchedForwardClosures,
        expectedThreadId: params.response.threadId,
      },
    );
  }

  async finalizeReverseWindowInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      beforeSeq: number;
      throughSeq: number;
      threadLock?: ThreadContentLock;
    },
  ): Promise<void> {
    const threadLock = await requireThreadContentLockInTx(
      tx,
      params.threadId,
      params.threadLock,
    );
    const staged = await tx.query.message.findMany({
      where: and(
        eq(tables.message.threadId, params.threadId),
        eq(tables.message.sourceNamespaceId, params.namespaceId),
        eq(tables.message.localState, 'STUB'),
        sql`${tables.message.originSeq} >= ${params.throughSeq}`,
        sql`${tables.message.originSeq} < ${params.beforeSeq}`,
      ),
      orderBy: asc(tables.message.seq),
    });
    let tombstoneEndSeq: number | null = null;
    for (const item of staged) {
      if (item.originSeq === null)
        throw new Error('reverse STUB has no publisher sequence');
      if (item.creatorAccount === null || item.creatorDomain === null)
        throw new Error('reverse STUB has no federated author');
      if (!item.isDeleted) continue;
      const pending = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, params.threadId),
          eq(
            tables.federatedMessageTombstone.sourceNamespaceId,
            params.namespaceId,
          ),
          eq(tables.federatedMessageTombstone.messageSeq, item.originSeq),
        ),
        columns: { type: true },
      });
      let deletionSeq: number;
      if (pending) {
        const deletion = await DeletedMessageService.ensureFactInTx(tx, {
          threadLock,
          threadId: params.threadId,
          messageSeq: item.seq,
          type: pending.type,
          sourceNamespaceId: params.namespaceId,
          updatedAt: new Date(),
        });
        deletionSeq = deletion.deletionSeq;
        await tx
          .delete(tables.federatedMessageTombstone)
          .where(
            and(
              eq(tables.federatedMessageTombstone.threadId, params.threadId),
              eq(
                tables.federatedMessageTombstone.sourceNamespaceId,
                params.namespaceId,
              ),
              eq(tables.federatedMessageTombstone.messageSeq, item.originSeq),
            ),
          );
      } else {
        const existing = await tx.query.deletedMessage.findFirst({
          where: and(
            eq(tables.deletedMessage.threadId, params.threadId),
            eq(tables.deletedMessage.messageSeq, item.seq),
          ),
          columns: { deletionSeq: true },
        });
        if (!existing)
          throw new Error('deleted reverse STUB has no tombstone fact');
        deletionSeq = existing.deletionSeq;
      }
      tombstoneEndSeq = Math.max(tombstoneEndSeq ?? deletionSeq, deletionSeq);
    }
    if (tombstoneEndSeq !== null)
      await ClientThreadContentHeadWriter.publishTombstone(
        tx,
        params.threadId,
        tombstoneEndSeq,
      );
    await tx.execute(sql`
      UPDATE "Message" staged
      SET "localState" = 'READY', "updatedAt" = CURRENT_TIMESTAMP
      WHERE staged."threadId" = ${params.threadId}
        AND staged."sourceNamespaceId" = ${params.namespaceId}
        AND staged."localState" = 'STUB'
        AND staged."originSeq" >= ${params.throughSeq}
        AND staged."originSeq" < ${params.beforeSeq}
        AND NOT EXISTS (
          SELECT 1 FROM "PendingMedia" pending
          WHERE pending."messageId" = staged.id
        )
    `);
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
    const satisfied: SatisfiedQuoteDependency[] = [];
    const recipientUserIds = new Set<number>();
    let relayDeletion = false;
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
        params.response.peerDomain,
        params.response.peerToken.namespaceId,
        item.messageSeq,
      );
      if (route.threadId !== params.response.threadId)
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'tombstone query returned an item for a different thread',
          HttpStatus.BAD_REQUEST,
        );
      for (const userId of route.recipients) recipientUserIds.add(userId);
      const authorityDomain =
        route.groupOriginDomain ?? params.response.peerDomain;
      if (
        route.memberSubmission
          ? item.type !== MessageDeleteType.USER_RETRACTION
          : authorityDomain !== params.response.peerDomain
      )
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          route.memberSubmission
            ? 'group members may only submit author retractions'
            : 'group tombstone is not from the group origin',
          HttpStatus.BAD_REQUEST,
        );
      const deletion = await this.deletedMessages.applyFederatedInTx(tx, {
        threadLock,
        threadId: route.threadId,
        messageSeq: item.messageSeq,
        sourceDomain: params.response.peerDomain,
        sourceNamespaceId: params.response.peerToken.namespaceId,
        remoteDeletionSeq: item.deletionSeq,
        type: item.type,
        authorityDeletedAt: new Date(item.deletedAt),
        allowPending: !route.memberSubmission,
        publishAsAuthority: route.memberSubmission,
        expectedFederationVersion: route.federationVersion,
      });
      if (route.memberSubmission && deletion) relayDeletion = true;
      satisfied.push({
        threadId: route.threadId,
        sourceNamespaceId: params.response.peerToken.namespaceId,
        originSeq: item.messageSeq,
      });
    }
    return {
      quoteDependencies: satisfied,
      recipientUserIds: [...recipientUserIds],
      relayDeletion,
    };
  }

  async publishSatisfiedQuoteDependencies(
    dependencies: readonly SatisfiedQuoteDependency[],
  ): Promise<void> {
    for (const dependency of dependencies) {
      const waiting = await this.database.db
        .select({ batchId: tables.pendingMedia.batchId })
        .from(tables.pendingMedia)
        .innerJoin(
          tables.message,
          eq(tables.message.id, tables.pendingMedia.messageId),
        )
        .where(
          and(
            eq(tables.pendingMedia.direction, 'INBOUND'),
            eq(tables.message.threadId, dependency.threadId),
            eq(tables.pendingMedia.namespaceId, dependency.sourceNamespaceId),
            eq(tables.pendingMedia.dependsOnOriginSeq, dependency.originSeq),
          ),
        );
      for (const row of waiting)
        await this.inboundMediaBatches.promotePendingMessage(row.batchId);
    }
  }
}
