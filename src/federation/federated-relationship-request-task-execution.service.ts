import { Injectable, Logger } from '@nestjs/common';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationRelationshipMutationService } from './federation-relationship-mutation.service.js';
import { FederationService } from './federation.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';

@Injectable()
export class FederatedRelationshipRequestTaskExecutionService {
  private readonly logger = new Logger(
    FederatedRelationshipRequestTaskExecutionService.name,
  );

  constructor(
    private readonly relationshipService: RelationshipService,
    private readonly relationships: FederationRelationshipMutationService,
    private readonly federation: FederationService,
    private readonly userQuota: UserQuotaService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async send(params: {
    actorUserId: number;
    account: string;
    domain: string;
    note: string;
    displayName: string;
    avatar?: string;
  }): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.relationshipService.createFederatedRelationshipRequest(
      params.actorUserId,
      params.account,
      params.domain,
      params.note,
      { displayName: params.displayName, avatar: params.avatar },
      async (tx, state) => {
        await this.userQuota.tick(params.actorUserId, 'requests', tx);
        statePeers =
          await this.relationships.writeAddressedRelationshipRequestInTx(
            tx,
            params.actorUserId,
            {
              account: params.account,
              domain: params.domain,
              namespaceId: state.namespaceId,
            },
            state,
            clientFeedUpdates,
          );
      },
    );
    this.notifyAfterCommit(clientFeedUpdates, statePeers, 'friend request');
  }

  async accept(params: {
    actorUserId: number;
    account: string;
    domain: string;
  }): Promise<void> {
    const statePeers = await this.federation.acceptAddressedFriendRequest(
      params.actorUserId,
      { account: params.account, domain: params.domain },
    );
    this.wakePeers(statePeers, 'friend request acceptance');
  }

  async revoke(params: {
    actorUserId: number;
    account: string;
    domain: string;
  }): Promise<void> {
    const relationship =
      await this.relationshipService.federatedRelationshipStatus(
        params.actorUserId,
        params.account,
        params.domain,
      );
    const statePeers =
      relationship === 'INCOMING_PENDING'
        ? await this.federation.revokeAddressedIncomingRelationship(
            params.actorUserId,
            { account: params.account, domain: params.domain },
          )
        : await this.federation.revokeAddressedOutgoingRequest(
            params.actorUserId,
            { account: params.account, domain: params.domain },
          );
    this.wakePeers(statePeers, 'friend request revocation');
  }

  private notifyAfterCommit(
    updates: Array<{ userId: number; feedId: number }>,
    statePeers: Map<string, bigint>,
    operation: string,
  ): void {
    try {
      this.clientStateFeed.notifyFeedUpdates(updates);
    } catch (error) {
      this.logger.warn(`${operation} state-feed notification failed`, error);
    }
    this.wakePeers(statePeers, operation);
  }

  private wakePeers(statePeers: Map<string, bigint>, operation: string): void {
    void this.federation
      .pushStateFeedDomains(statePeers.keys())
      .catch((error: unknown) =>
        this.logger.warn(`${operation} federation wake failed`, error),
      );
  }
}
