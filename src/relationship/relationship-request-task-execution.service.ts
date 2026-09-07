import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account as user } from '../database/schema.js';
import { FederationRelationshipMutationService } from '../federation/federation-relationship-mutation.service.js';
import { FederationService } from '../federation/federation.service.js';
import { RelationshipService } from './relationship.service.js';

type AfterClose = (
  tx: DatabaseTransaction,
  peerUserId: number,
) => Promise<void>;

@Injectable()
export class RelationshipRequestTaskExecutionService {
  private readonly logger = new Logger(
    RelationshipRequestTaskExecutionService.name,
  );

  constructor(
    private readonly relationships: RelationshipService,
    private readonly relationshipMutations: FederationRelationshipMutationService,
    private readonly federationService: FederationService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async accept(peerUserId: number, actorUserId: number): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.relationships.acceptRelationshipRequest(
      peerUserId,
      actorUserId,
      async (tx, peerUserId) => {
        const peer = await tx.query.account.findFirst({
          where: eq(user.id, peerUserId),
          columns: { domain: true },
        });
        if (peer?.domain !== 'local') {
          statePeers = await this.relationshipMutations.writeP2PIntentInTx(
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
            ...(await this.relationships.writeLocalP2PIntentInTx(
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
      'relationship request acceptance',
    );
  }

  reject(peerUserId: number, actorUserId: number): Promise<void> {
    return this.closeDirection(actorUserId, (afterClose) =>
      this.relationships.rejectRelationshipRequest(
        peerUserId,
        actorUserId,
        afterClose,
      ),
    );
  }

  revoke(peerUserId: number, actorUserId: number): Promise<void> {
    return this.closeDirection(actorUserId, (afterClose) =>
      this.relationships.revokeRelationshipRequest(
        peerUserId,
        actorUserId,
        afterClose,
      ),
    );
  }

  private async closeDirection(
    actorUserId: number,
    mutate: (afterClose: AfterClose) => Promise<void>,
  ): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await mutate(async (tx, peerUserId) => {
      const peer = await tx.query.account.findFirst({
        where: eq(user.id, peerUserId),
        columns: { domain: true },
      });
      if (peer?.domain !== 'local') {
        statePeers = await this.relationshipMutations.writeP2PIntentInTx(
          tx,
          actorUserId,
          peerUserId,
          false,
          '',
          clientFeedUpdates,
        );
      } else {
        clientFeedUpdates.push(
          ...(await this.relationships.writeLocalP2PIntentInTx(
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
      'relationship request closure',
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
