import { Injectable, Logger } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationRelationshipMutationService } from '../federation/federation-relationship-mutation.service.js';
import { FederationService } from '../federation/federation.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { GroupService } from './group.service.js';

@Injectable()
export class GroupInviteTaskExecutionService {
  private readonly logger = new Logger(GroupInviteTaskExecutionService.name);

  constructor(
    private readonly relationships: RelationshipService,
    private readonly participants: AccountThreadStateService,
    private readonly federationRelationships: FederationRelationshipMutationService,
    private readonly federation: FederationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groups: GroupService,
  ) {}

  async inviteMember(
    inviterUserId: number,
    threadId: number,
    memberUserId: number,
  ): Promise<void> {
    if (
      (await this.participants.findP2PThreadBetween(
        inviterUserId,
        memberUserId,
      )) === null
    ) {
      throw new BusinessException(
        BusinessCode.FRIEND_NOT_FOUND,
        'invite target is no longer a friend',
      );
    }
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.relationships.createGroupInvite(
      inviterUserId,
      threadId,
      memberUserId,
      '',
      async (tx) => {
        await this.groups.assertGroupManagerInTx(tx, threadId, inviterUserId);
        statePeers =
          await this.federationRelationships.writeGroupRelationshipIntentInTx(
            tx,
            threadId,
            memberUserId,
            '',
            'REQUESTED',
            clientFeedUpdates,
          );
      },
    );
    try {
      this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    } catch (error) {
      this.logger.warn('group invite client-state wake failed', error);
    }
    void this.federation
      .pushStateFeedDomains(statePeers.keys())
      .catch((error: unknown) =>
        this.logger.warn('group invite state-feed wake failed', error),
      );
  }
}
