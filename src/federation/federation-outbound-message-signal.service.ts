import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import type { S2SAddress } from './federation-address.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';

/** Routes durable message and tombstone wake-ups to directly interested peers. */
@Injectable()
export class FederationOutboundMessageSignalService {
  private readonly logger = new Logger(
    FederationOutboundMessageSignalService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    private readonly statePull: FederationStatePullService,
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
      await this.statePull.pushDiscoveryHwm(originDomain);
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
      const [thread, participants] = await Promise.all([
        this.database.db
          .select({ groupDomain: tables.group.domain })
          .from(tables.messageThread)
          .leftJoin(
            tables.group,
            eq(tables.group.id, tables.messageThread.groupId),
          )
          .where(eq(tables.messageThread.id, threadId))
          .limit(1)
          .then((rows) => rows[0]),
        this.database.db
          .select({
            userId: tables.threadMember.userId,
            user: {
              account: tables.user.account,
              domain: tables.user.domain,
            },
          })
          .from(tables.threadMember)
          .innerJoin(
            tables.user,
            eq(tables.user.id, tables.threadMember.userId),
          )
          .where(eq(tables.threadMember.threadId, threadId)),
      ]);
      if (!thread) return;
      const authorization = await Promise.all(
        participants.map((participant) =>
          isThreadMutuallyAuthorized(
            this.database.db,
            participant.userId,
            threadId,
          ),
        ),
      );
      const active = participants.filter((_, index) => authorization[index]);
      if (
        !active.some(
          ({ user }) =>
            user.account === authorAddress.account &&
            user.domain === authorAddress.domain,
        )
      )
        return;
      if (fetchedFromDomain)
        void this.offerAndPush(fetchedFromDomain, threadId, latestSeq).catch(
          (error) =>
            this.logger.debug(
              `delivery receipt HWM push ${fetchedFromDomain} failed: ${(error as Error).message}`,
            ),
        );

      const destinations = new Set<string>();
      if (!thread.groupDomain) {
        for (const { user } of active) {
          if (
            (user.account === authorAddress.account &&
              user.domain === authorAddress.domain) ||
            user.domain === 'local' ||
            user.domain === fetchedFromDomain
          )
            continue;
          destinations.add(user.domain);
        }
      } else if (thread.groupDomain === 'local') {
        for (const { user } of active)
          if (user.domain !== 'local') destinations.add(user.domain);
      } else {
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
    const peers = await this.database.db
      .selectDistinct({ domain: tables.threadAudience.targetDomain })
      .from(tables.threadAudience)
      .where(
        and(
          eq(tables.threadAudience.threadId, threadId),
          isNull(tables.threadAudience.localUserId),
        ),
      );
    await Promise.all(
      peers.map(async ({ domain }) => {
        await this.threadContentHeads.offerCommitted(domain, threadId);
        await this.statePull.pushDiscoveryHwm(domain);
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
    await this.statePull.pushDiscoveryHwm(peerDomain);
  }
}
