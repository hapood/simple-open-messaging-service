import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { user } from '../database/schema.js';
import { FederationRelationshipCommandService } from '../federation/federation-relationship-command.service.js';
import { FederationService } from '../federation/federation.service.js';
import { InviteService } from './invite.service.js';

type AfterClose = (
  tx: DatabaseTransaction,
  peerUserId: number,
) => Promise<void>;

@Injectable()
export class FriendInviteCommandExecutionService {
  private readonly logger = new Logger(
    FriendInviteCommandExecutionService.name,
  );

  constructor(
    private readonly inviteService: InviteService,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly federationService: FederationService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async accept(inviteId: string, actorUserId: number): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.inviteService.acceptInvite(
      inviteId,
      actorUserId,
      async (tx, peerUserId) => {
        const peer = await tx.query.user.findFirst({
          where: eq(user.id, peerUserId),
          columns: { domain: true },
        });
        if (peer?.domain !== 'local') {
          statePeers = await this.relationshipCommands.writeFriendIntentInTx(
            tx,
            actorUserId,
            peerUserId,
            true,
            '',
            clientFeedUpdates,
            true,
          );
        } else {
          clientFeedUpdates.push(
            ...(await this.inviteService.writeLocalFriendIntentInTx(
              tx,
              actorUserId,
              peerUserId,
              true,
            )),
          );
        }
      },
    );

    this.notifyAfterCommit(
      clientFeedUpdates,
      statePeers,
      'friend invite acceptance',
    );
  }

  reject(inviteId: string, actorUserId: number): Promise<void> {
    return this.closeDirection(actorUserId, (afterClose) =>
      this.inviteService.rejectInvite(inviteId, actorUserId, afterClose),
    );
  }

  revoke(inviteId: string, actorUserId: number): Promise<void> {
    return this.closeDirection(actorUserId, (afterClose) =>
      this.inviteService.revokeInvite(inviteId, actorUserId, afterClose),
    );
  }

  private async closeDirection(
    actorUserId: number,
    mutate: (afterClose: AfterClose) => Promise<void>,
  ): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await mutate(async (tx, peerUserId) => {
      const peer = await tx.query.user.findFirst({
        where: eq(user.id, peerUserId),
        columns: { domain: true },
      });
      if (peer?.domain !== 'local') {
        statePeers = await this.relationshipCommands.writeFriendIntentInTx(
          tx,
          actorUserId,
          peerUserId,
          false,
          '',
          clientFeedUpdates,
        );
      } else {
        clientFeedUpdates.push(
          ...(await this.inviteService.writeLocalFriendIntentInTx(
            tx,
            actorUserId,
            peerUserId,
            false,
          )),
        );
      }
    });

    this.notifyAfterCommit(
      clientFeedUpdates,
      statePeers,
      'friend invite closure',
    );
  }

  private notifyAfterCommit(
    clientFeedUpdates: Array<{ userId: number; feedId: number }>,
    statePeers: Map<string, bigint>,
    operation: string,
  ): void {
    try {
      this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    } catch (error) {
      this.logger.warn(`${operation} state-feed notification failed`, error);
    }
    void this.federationService
      .pushStateFeedDomains(statePeers.keys())
      .catch((error: unknown) =>
        this.logger.warn(`${operation} federation wake failed`, error),
      );
  }
}
