import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import type { S2SAddress } from './federation-address.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

/** Routes durable message and tombstone wake-ups to directly interested peers. */
@Injectable()
export class FederationOutboundMessageSignalService {
  private readonly logger = new Logger(
    FederationOutboundMessageSignalService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    private readonly events: EventEmitter2,
  ) {}

  async notifyGroupLeave(threadId: number): Promise<void> {
    try {
      const [thread] = await this.database.db
        .select({ domain: tables.group.domain })
        .from(tables.messageThread)
        .innerJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      const originDomain = thread?.domain;
      if (!originDomain || originDomain === 'local') return;
      this.events.emit(FEDERATION_STATE_FEED_PUSH, {
        peerDomain: originDomain,
      });
    } catch (error) {
      this.logger.debug(
        `notifyGroupLeave(${threadId}) failed: ${(error as Error).message}`,
      );
    }
  }

  async signalMessage(
    threadId: number,
    authorAddress: S2SAddress,
    latestSeq: number,
    fetchedFromDomain?: string,
  ): Promise<void> {
    try {
      const [thread, peerAudiences, authorAuthorization] = await Promise.all([
        this.database.db
          .select({
            type: tables.messageThread.type,
            groupDomain: tables.group.domain,
          })
          .from(tables.messageThread)
          .leftJoin(
            tables.group,
            eq(tables.group.id, tables.messageThread.groupId),
          )
          .where(eq(tables.messageThread.id, threadId))
          .limit(1)
          .then((rows) => rows[0]),
        this.database.db
          .select({ domain: tables.threadAudience.targetDomain })
          .from(tables.threadAudience)
          .where(
            and(
              eq(tables.threadAudience.threadId, threadId),
              isNull(tables.threadAudience.localUserId),
            ),
          ),
        this.database.db.execute<{ authorized: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1
            FROM "RelationshipPair" pair
            WHERE pair."threadId" = ${threadId}
              AND pair.active = true
              AND pair.kind IN ('P2P', 'GROUP_MEMBER')
              AND ((pair."endpointAType" = 'USER'
                    AND pair."endpointAAccount" = ${authorAddress.account}
                    AND pair."endpointADomain" = ${authorAddress.domain})
                OR (pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = ${authorAddress.account}
                    AND pair."endpointBDomain" = ${authorAddress.domain}))
          ) AS authorized
        `),
      ]);
      if (!thread || !authorAuthorization.rows[0]?.authorized) return;
      if (fetchedFromDomain)
        void this.offerAndPush(fetchedFromDomain, threadId, latestSeq).catch(
          (error) =>
            this.logger.debug(
              `delivery receipt HWM push ${fetchedFromDomain} failed: ${(error as Error).message}`,
            ),
        );

      const destinations = new Set<string>();
      if (thread.type === 'P2P') {
        for (const audience of peerAudiences)
          if (audience.domain !== authorAddress.domain)
            destinations.add(audience.domain);
      } else if (thread.groupDomain === 'local') {
        for (const audience of peerAudiences) destinations.add(audience.domain);
      } else if (thread.groupDomain) {
        destinations.add(thread.groupDomain);
      }
      if (fetchedFromDomain) destinations.delete(fetchedFromDomain);
      for (const domain of destinations)
        void this.offerAndPush(domain, threadId, latestSeq).catch((error) =>
          this.logger.debug(
            `discovery HWM push ${domain} failed: ${(error as Error).message}`,
          ),
        );
    } catch (error) {
      this.logger.debug(
        `signalOutbound(${threadId}) failed: ${(error as Error).message}`,
      );
    }
  }

  async signalDeletion(threadId: number): Promise<void> {
    const [thread, audiences] = await Promise.all([
      this.database.db
        .select({
          type: tables.messageThread.type,
          groupDomain: tables.group.domain,
        })
        .from(tables.messageThread)
        .leftJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1)
        .then((rows) => rows[0]),
      this.database.db
        .selectDistinct({ domain: tables.threadAudience.targetDomain })
        .from(tables.threadAudience)
        .where(
          and(
            eq(tables.threadAudience.threadId, threadId),
            isNull(tables.threadAudience.localUserId),
          ),
        ),
    ]);
    if (!thread) return;
    const peers = new Set<string>(
      thread.type === 'GROUP' &&
        thread.groupDomain !== null &&
        thread.groupDomain !== 'local'
        ? [thread.groupDomain]
        : audiences.map(({ domain }) => domain),
    );
    await Promise.all(
      [...peers].map(async (domain) => {
        await this.threadContentHeads.offerCommitted(domain, threadId);
        this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain: domain });
      }),
    );
  }

  private async offerAndPush(
    peerDomain: string,
    threadId: number,
    messageSeq: number,
  ): Promise<void> {
    await this.threadContentHeads.offerCommitted(
      peerDomain,
      threadId,
      messageSeq,
    );
    this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }
}
