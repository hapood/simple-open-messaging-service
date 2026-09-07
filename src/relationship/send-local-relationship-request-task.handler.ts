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
import { account, account as user } from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { RelationshipService } from './relationship.service.js';

@Injectable()
export class SendLocalRelationshipRequestTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.SEND_LOCAL_RELATIONSHIP_REQUEST;
  private readonly logger = new Logger(
    SendLocalRelationshipRequestTaskHandler.name,
  );
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly relationships: RelationshipService,
    private readonly participantService: AccountThreadStateService,
    private readonly userQuota: UserQuotaService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    const actorUserId = task.actorUserId;
    const { targetUserId, note } = readPayload(task);
    if (actorUserId === null) {
      throw new Error('local relationship request task has no actor');
    }
    if (actorUserId === targetUserId) {
      throw new Error('can not request a relationship with yourself');
    }

    await this.assertUsersRemainEligible(actorUserId, targetUserId);
    if (await this.participantService.areFriends(actorUserId, targetUserId)) {
      return;
    }

    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.relationships.createRelationshipRequest(
      actorUserId,
      targetUserId,
      note,
      async (tx) => {
        await this.userQuota.tick(actorUserId, 'requests', tx);
        clientFeedUpdates.push(
          ...(await this.relationships.writeLocalP2PIntentInTx(
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
    // task outcome after the relationship transaction has committed.
    try {
      this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    } catch (error) {
      this.logger.warn(
        'local relationship request task state-feed notification failed',
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
      .where(
        and(
          inArray(user.id, [actorUserId, targetUserId]),
          eq(user.domain, 'local'),
          eq(user.namespaceId, 0),
        ),
      );
    const actor = identities.find(({ id }) => id === actorUserId);
    const target = identities.find(({ id }) => id === targetUserId);
    if (!actor || actor.availability !== 'AVAILABLE' || actor.disabledAt) {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'task actor is no longer available',
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

function readPayload(task: DurableTask): {
  targetUserId: number;
  note: string;
} {
  if (task.scopeType !== 'USER_PAIR') {
    throw new Error('local relationship request task has the wrong scope type');
  }
  const { targetUserId, note } = task.payload;
  if (!Number.isSafeInteger(targetUserId) || (targetUserId as number) <= 0) {
    throw new Error(
      'local relationship request task has an invalid target user ID',
    );
  }
  if (typeof note !== 'string' || note.length > 255) {
    throw new Error('local relationship request task has an invalid note');
  }
  return { targetUserId: targetUserId as number, note };
}
