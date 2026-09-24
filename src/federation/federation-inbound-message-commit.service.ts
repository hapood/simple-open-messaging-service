import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { MessageDeleteType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { type InboundForwardWireBundle } from '../forward/forward-bundle.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
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
} from '../common/locks/thread-content-lock.js';

export interface ReverseMessagePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  before: number;
  through?: number;
  messageSeqOffset: number;
  prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
}

export interface ForwardMessagePageCommit {
  threadLock?: ThreadContentLock;
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  after: number;
  frozenTargetSeq: number;
  prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
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
  deletions: { messageSeq: number; deletionSeq: number }[];
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
    await requireThreadContentLockInTx(tx, params.threadId, params.threadLock);
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
      const deletion = await this.deletedMessages.applyFederatedInTx(tx, {
        threadLock,
        threadId: route.threadId,
        messageSeq: item.messageSeq,
        sourceDomain: params.response.peerDomain,
        sourceNamespaceId: params.response.peerToken.namespaceId,
        remoteDeletionSeq: item.deletionSeq,
        type: item.type,
        authorityDeletedAt: new Date(item.deletedAt),
        authority: route.authority,
        expectedFederationVersion: route.federationVersion,
      });
      if (deletion) deletions.push(deletion);
      satisfied.push({
        threadId: route.threadId,
        sourceNamespaceId: params.response.peerToken.namespaceId,
        originSeq: item.messageSeq,
      });
    }
    return {
      quoteDependencies: satisfied,
      deletions,
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
