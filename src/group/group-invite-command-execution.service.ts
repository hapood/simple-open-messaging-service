import { Injectable, Logger } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationRelationshipCommandService } from '../federation/federation-relationship-command.service.js';
import { FederationService } from '../federation/federation.service.js';
import { InviteService } from '../invite/invite.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { GroupService } from './group.service.js';

@Injectable()
export class GroupInviteCommandExecutionService {
  private readonly logger = new Logger(GroupInviteCommandExecutionService.name);

  constructor(
    private readonly invites: InviteService,
    private readonly participants: ThreadParticipantService,
    private readonly relationships: FederationRelationshipCommandService,
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
    await this.invites.createGroupInvite(
      inviterUserId,
      threadId,
      memberUserId,
      '',
      async (tx) => {
        await this.groups.assertGroupManagerInTx(tx, threadId, inviterUserId);
        statePeers = await this.relationships.writeGroupRelationshipIntentInTx(
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
