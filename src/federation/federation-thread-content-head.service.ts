import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { deletedMessage, message, threadAudience } from '../database/schema.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { loadFederationConfig } from './federation.config.js';

interface ThreadContentProjection {
  account: string;
  peerAccount?: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
}

@Injectable()
export class FederationThreadContentHeadService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly stateFeed: PeerStateFeedService,
  ) {}

  async offerCommitted(
    peerDomain: string,
    threadId: number,
    expectedMessageSeq?: number,
  ): Promise<void> {
    await this.database.db.transaction((tx) =>
      this.refreshInTx(tx, peerDomain, threadId, false, expectedMessageSeq),
    );
  }

  async fill(peerDomain: string): Promise<void> {
    const audiences = await this.database.db
      .select({ threadId: threadAudience.threadId })
      .from(threadAudience)
      .where(
        and(
          eq(threadAudience.targetDomain, peerDomain),
          isNull(threadAudience.localUserId),
        ),
      );
    for (const audience of audiences)
      await this.offerCommitted(peerDomain, audience.threadId);
  }

  async refreshInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    threadId: number,
    forceReindex = false,
    expectedMessageSeq?: number,
  ): Promise<void> {
    const projection = await this.readProjectionInTx(tx, peerDomain, threadId);
    if (!projection) {
      if (expectedMessageSeq !== undefined)
        throw new Error(
          `thread ${threadId} message ${expectedMessageSeq} is not queryable by ${peerDomain}`,
        );
      return;
    }
    if (
      expectedMessageSeq !== undefined &&
      projection.messageEndSeq < expectedMessageSeq
    )
      throw new Error(
        `thread ${threadId} projection ended before committed message ${expectedMessageSeq}`,
      );
    await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        account: projection.account,
        domain: this.localDomain,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: projection.peerAccount ?? '',
        subjectDomain: projection.peerAccount ? peerDomain : 'local',
        forceReindex,
        body: {
          messageEndSeq: projection.messageEndSeq,
          tombstoneEndSeq: projection.tombstoneEndSeq,
        },
      },
    ]);
  }

  private async readProjectionInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    threadId: number,
  ): Promise<ThreadContentProjection | null> {
    const result = await tx.execute<{
      messageAccessAfterSeq: number;
      threadType: 'P2P' | 'GROUP';
      groupAccount: string | null;
      account: string | null;
      peerAccount: string | null;
    }>(sql`
      SELECT audience."messageAccessAfterSeq",
             thread.type AS "threadType",
             group_state.account AS "groupAccount",
             CASE
               WHEN pair."endpointADomain" = 'local' THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = 'local' THEN pair."endpointBAccount"
             END AS account,
             CASE
               WHEN pair."endpointADomain" = ${peerDomain} THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = ${peerDomain} THEN pair."endpointBAccount"
             END AS "peerAccount"
      FROM "ThreadAudience" audience
      JOIN "MessageThread" thread ON thread.id = audience."threadId"
      LEFT JOIN "Group" group_state ON group_state.id = thread."groupId"
      LEFT JOIN "RelationshipPair" pair
        ON pair."threadId" = thread.id
       AND pair.kind = 'P2P'
       AND pair.active = true
      WHERE audience."targetDomain" = ${peerDomain}
        AND audience."localUserId" IS NULL
        AND audience."threadId" = ${threadId}
        AND thread."federationTruncated" = false
      LIMIT 1
      FOR SHARE OF audience, thread
    `);
    const route = result.rows[0];
    if (!route) return null;
    const [messageEnd] = await tx
      .select({ value: sql<number>`MAX(${message.seq})` })
      .from(message)
      .where(
        and(
          eq(message.threadId, threadId),
          sql`${message.seq} > ${route.messageAccessAfterSeq}`,
          sql`${message.contentType} <> 'SYSTEM'`,
        ),
      );
    if (messageEnd?.value === null || messageEnd?.value === undefined)
      return null;
    const [deletionEnd] = await tx
      .select({
        value: sql<number>`COALESCE(MAX(${deletedMessage.deletionSeq}), 0)`,
      })
      .from(deletedMessage)
      .innerJoin(
        message,
        and(
          eq(message.threadId, deletedMessage.threadId),
          eq(message.seq, deletedMessage.messageSeq),
        ),
      )
      .where(
        and(
          eq(deletedMessage.threadId, threadId),
          isNull(deletedMessage.federationSourceDomain),
          sql`${message.seq} > ${route.messageAccessAfterSeq}`,
        ),
      );
    if (route.threadType === 'GROUP') {
      if (!route.groupAccount)
        throw new Error(`group thread ${threadId} has no group address`);
      return {
        account: route.groupAccount,
        messageEndSeq: messageEnd.value,
        tombstoneEndSeq: deletionEnd?.value ?? 0,
      };
    }
    if (!route.account || !route.peerAccount)
      throw new Error(
        `P2P thread ${threadId} has no address for ${peerDomain}`,
      );
    return {
      account: route.account,
      peerAccount: route.peerAccount,
      messageEndSeq: messageEnd.value,
      tombstoneEndSeq: deletionEnd?.value ?? 0,
    };
  }
}
