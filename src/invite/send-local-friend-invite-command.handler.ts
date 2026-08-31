import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../database/database.service.js';
import { account, user } from '../database/schema.js';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type {
  DomainCommand,
  DomainCommandHandler,
} from '../domain-command/domain-command.types.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { InviteService } from './invite.service.js';

@Injectable()
export class SendLocalFriendInviteCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  readonly commandType = DomainCommandType.SEND_LOCAL_FRIEND_INVITE;
  private readonly logger = new Logger(
    SendLocalFriendInviteCommandHandler.name,
  );
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly dispatcher: DomainCommandDispatcherService,
    private readonly inviteService: InviteService,
    private readonly participantService: ThreadParticipantService,
    private readonly userQuota: UserQuotaService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(command: DomainCommand): Promise<void> {
    const actorUserId = command.actorUserId;
    const { targetUserId, note } = readPayload(command);
    if (actorUserId === null) {
      throw new Error('local friend command has no actor');
    }
    if (actorUserId === targetUserId) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not invite yourself',
      );
    }

    await this.assertUsersRemainEligible(actorUserId, targetUserId);
    if (await this.participantService.areFriends(actorUserId, targetUserId)) {
      return;
    }

    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.inviteService.createFriendInvite(
      actorUserId,
      targetUserId,
      note,
      true,
      undefined,
      async (tx, created) => {
        if (created) await this.userQuota.tick(actorUserId, 'requests', tx);
        clientFeedUpdates.push(
          ...(await this.inviteService.writeLocalFriendIntentInTx(
            tx,
            actorUserId,
            targetUserId,
            true,
            note,
          )),
        );
      },
    );

    // SSE is a post-commit convergence hint. A notification failure must not change the durable
    // command outcome after the relationship transaction has committed.
    try {
      this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    } catch (error) {
      this.logger.warn(
        'local friend command state-feed notification failed',
        error,
      );
    }
  }

  private async assertUsersRemainEligible(
    actorUserId: number,
    targetUserId: number,
  ): Promise<void> {
    const identities = await this.database.db
      .select({
        id: user.id,
        availability: user.availability,
        disabledAt: account.disabledAt,
      })
      .from(user)
      .innerJoin(account, eq(account.id, user.id))
      .where(
        and(
          inArray(user.id, [actorUserId, targetUserId]),
          eq(user.domain, 'local'),
          eq(user.sourceDomain, 'local'),
        ),
      );
    const actor = identities.find(({ id }) => id === actorUserId);
    const target = identities.find(({ id }) => id === targetUserId);
    if (!actor || actor.availability !== 'AVAILABLE' || actor.disabledAt) {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'command actor is no longer available',
      );
    }
    if (!target || target.availability !== 'AVAILABLE' || target.disabledAt) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'user does not exist',
      );
    }
  }
}

function readPayload(command: DomainCommand): {
  targetUserId: number;
  note: string;
} {
  if (command.aggregateType !== 'USER_PAIR') {
    throw new Error('local friend command has the wrong aggregate type');
  }
  const { targetUserId, note } = command.payload;
  if (!Number.isSafeInteger(targetUserId) || (targetUserId as number) <= 0) {
    throw new Error('local friend command has an invalid target user ID');
  }
  if (typeof note !== 'string' || note.length > 255) {
    throw new Error('local friend command has an invalid note');
  }
  return { targetUserId: targetUserId as number, note };
}
