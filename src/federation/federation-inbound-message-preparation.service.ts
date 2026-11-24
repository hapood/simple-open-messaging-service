import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { message } from '../database/schema.js';
import type { InboundForwardWireBundle } from '../forward/forward-bundle.service.js';
import {
  FederationInboundMessagePageService,
  type PreparedMessageWrite,
} from './federation-inbound-message-page.service.js';
import { FederationInboundMessageReceiptService } from './federation-inbound-message-receipt.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import type { FederationMessageQueryPage } from './federation-message-feed.service.js';
import type { FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';

/** Completes receipts and filters known coordinates before the message write transaction. */
@Injectable()
export class FederationInboundMessagePreparationService {
  private readonly logger = new Logger(
    FederationInboundMessagePreparationService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly pages: FederationInboundMessagePageService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly receipts: FederationInboundMessageReceiptService,
  ) {}

  async prepare(
    response: FederationThreadResourceResponse<FederationMessageQueryPage>,
    prefetchedForwardClosures: ReadonlyMap<number, InboundForwardWireBundle>,
    authorizationEpoch: number,
    signal: AbortSignal,
  ): Promise<readonly PreparedMessageWrite[]> {
    signal.throwIfAborted();
    const prepared = this.pages.prepare(
      response.peerDomain,
      response.data.messages,
      response.peerToken,
      prefetchedForwardClosures,
    );
    signal.throwIfAborted();
    // Routing and known-coordinate reads share one MVCC snapshot, without write locks.
    const candidates = await this.database.db.transaction(
      async (tx) => {
        const existing =
          prepared.length === 0
            ? []
            : await tx.query.message.findMany({
                where: and(
                  eq(message.threadId, response.threadId),
                  eq(
                    message.publisherNamespaceId,
                    response.peerToken.namespaceId,
                  ),
                  inArray(
                    message.originSeq,
                    prepared.map(({ item }) => item.seq),
                  ),
                ),
                columns: { originSeq: true },
              });
        const known = new Set(existing.map((row) => row.originSeq));
        const routed = [];
        for (const entry of prepared) {
          let route;
          try {
            route = await this.routes.resolveMessage(
              tx,
              entry.item,
              response.peerToken.namespaceId,
              response.peerToken.peerAssignedLocalNamespaceId,
            );
          } catch (error) {
            if (
              !(error instanceof BusinessException) ||
              error.bizCode !== BusinessCode.FEDERATION_MALFORMED
            )
              throw error;
            this.logger.warn(
              `filtered malformed message route ${response.threadId}:${entry.item.seq}`,
            );
            continue;
          }
          if (route.threadId !== response.threadId) {
            this.logger.warn(
              `filtered message for a different thread ${response.threadId}:${entry.item.seq}`,
            );
            continue;
          }
          if (route.authority === 'PEER') {
            if (
              entry.item.originSeq !== null ||
              entry.item.originCreatedAt !== null
            ) {
              this.logger.warn(
                `filtered remote message carrying source coordinates ${response.threadId}:${entry.item.seq}`,
              );
              continue;
            }
            if (known.has(entry.item.seq)) {
              this.logger.warn(
                `ignored existing federated message coordinate ${response.threadId}:${response.peerToken.namespaceId}:${entry.item.seq}`,
              );
              continue;
            }
            known.add(entry.item.seq);
          }
          routed.push({ entry, route });
        }
        return routed;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const messages: PreparedMessageWrite[] = [];
    for (const { entry, route } of candidates) {
      signal.throwIfAborted();
      if (route.authority === 'LOCAL') {
        // Commit before entering the main message transaction; never advance its gap here.
        await this.receipts.process(
          response,
          authorizationEpoch,
          entry,
          route,
          signal,
        );
      } else {
        messages.push({
          ...entry,
          creatorAccount: route.creatorAccount,
          profileNamespaceId: route.profileNamespaceId,
          recipients: route.recipients,
          toAccount: route.toAccount,
        });
      }
    }
    return messages;
  }
}
