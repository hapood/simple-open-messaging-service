import { Injectable, Logger } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import type { PreparedInboundItem } from './federation-inbound-message-page.service.js';
import {
  FederationInboundMessageRouteService,
  type FederationInboundMessageRoute,
} from './federation-inbound-message-route.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import type { FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

/** Confirms returning local messages independently of message-page materialization. */
@Injectable()
export class FederationInboundMessageReceiptService {
  private readonly logger = new Logger(
    FederationInboundMessageReceiptService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly deletedMessages: DeletedMessageService,
  ) {}

  async process(
    response: FederationThreadResourceResponse<unknown>,
    authorizationEpoch: number,
    prepared: PreparedInboundItem,
    route: FederationInboundMessageRoute,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const { item, wireDigest, sourceTime } = prepared;
    const { threadId, peerToken } = response;
    if (route.threadId !== threadId || route.authority !== 'LOCAL')
      throw new Error('processing receipt requires a local-author route');
    if (item.originSeq === null || item.originCreatedAt === null) {
      this.logger.warn(
        `ignored receipt without source coordinates ${threadId}:${item.seq}`,
      );
      return;
    }
    // Immutable payload comparison is deliberately outside the write transaction.
    const original = await this.database.db.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.seq, item.originSeq),
        eq(tables.message.publisherNamespaceId, 0),
        eq(tables.message.creatorAccount, route.creatorAccount),
        eq(tables.message.profileNamespaceId, route.profileNamespaceId),
      ),
    });
    if (!original) {
      this.logger.warn(
        `processing receipt has no matching published message ${threadId}:${item.originSeq}`,
      );
      return;
    }
    if (
      original.createdAt.getTime() !== item.originCreatedAt ||
      original.contentType !== item.contentType ||
      original.profileRev !== item.profileRev
    ) {
      this.logger.warn(
        `ignored receipt with conflicting source envelope ${threadId}:${item.originSeq}`,
      );
      return;
    }
    if (original.payloadDigest !== wireDigest)
      this.logger.warn(
        `processing receipt payload digest differs ${threadId}:${item.originSeq}`,
      );

    signal.throwIfAborted();
    await this.database.db.transaction(async (tx) => {
      signal.throwIfAborted();
      const threadLock =
        await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
          tx,
          threadId,
          authorizationEpoch,
        );
      await this.threadAccess.assertResourceResponseWritable(tx, response);
      const currentRoute = await this.routes.resolveMessage(
        tx,
        item,
        peerToken.namespaceId,
        peerToken.peerAssignedLocalNamespaceId,
      );
      if (
        currentRoute.threadId !== threadId ||
        currentRoute.authority !== 'LOCAL' ||
        currentRoute.creatorAccount !== route.creatorAccount ||
        currentRoute.profileNamespaceId !== route.profileNamespaceId
      )
        throw new Error('processing receipt route changed');
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: { type: true, authorityNamespaceId: true },
      });
      if (
        !thread ||
        (thread.type === 'GROUP' &&
          thread.authorityNamespaceId !== peerToken.namespaceId)
      )
        throw new Error(
          'processing receipt source is not the timeline authority',
        );
      const current = await tx.query.message.findFirst({
        where: and(
          eq(tables.message.id, original.id),
          eq(tables.message.threadId, threadId),
          eq(tables.message.seq, original.seq),
          eq(tables.message.publisherNamespaceId, 0),
          eq(tables.message.creatorAccount, route.creatorAccount),
          eq(tables.message.profileNamespaceId, route.profileNamespaceId),
          eq(tables.message.createdAt, original.createdAt),
        ),
      });
      if (!current)
        throw new Error('processing receipt source message changed');
      // Repeated receipts may confirm the same coordinate, never rewrite it.
      const confirmed = await tx
        .update(tables.message)
        .set({
          originSeq: item.seq,
          originServerTime: sourceTime,
        })
        .where(
          and(
            eq(tables.message.id, current.id),
            or(
              sql`${tables.message.originSeq} IS NULL`,
              and(
                eq(tables.message.originSeq, item.seq),
                sql`${tables.message.originServerTime} IS NOT DISTINCT FROM ${sourceTime}`,
              ),
            ),
          ),
        )
        .returning({ id: tables.message.id });
      if (confirmed.length !== 1)
        throw new Error(
          'processing receipt conflicts with the retained coordinate',
        );
      await this.deletedMessages.applyPendingReceiptInTx(tx, {
        threadId,
        peerSeq: item.seq,
        namespaceId: peerToken.namespaceId,
        authority: thread.type === 'P2P' ? 'P2P_HOME' : 'GROUP_ORIGIN',
        threadLock,
        resolvedMessage: current,
      });
      signal.throwIfAborted();
    });
  }
}
