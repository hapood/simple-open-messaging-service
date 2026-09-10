import { Inject } from '@nestjs/common';
import { FederationReverseRevokeService } from '../federation/federation-reverse-revoke.service.js';
import { relationshipTaskAuthorUserId } from './relationship-task-author.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FEDERATION_STATE_FEED_PUSH } from '../federation/federation-state-feed.events.js';
import { FederatedRelationshipRequestTaskExecutionService } from '../federation/federated-relationship-request-task-execution.service.js';
import { FederatedGroupTaskExecutionService } from '../federation/federated-group-task-execution.service.js';
import { RelationshipRequestTaskExecutionService } from './relationship-request-task-execution.service.js';
import { RelationshipService } from './relationship.service.js';
import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { DatabaseService } from '../database/database.service.js';
import { messageThread } from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupService } from '../group/group.service.js';

/** User-authored revocations share admission; each domain retains its own
 * transactional revocation, boundary publication, and owner checks. */
@Injectable()
export class RevokeUserRelationshipTaskHandler
  implements OnModuleInit, OnModuleDestroy
{
  @Inject(FederationReverseRevokeService)
  private readonly reverseRevokes!: FederationReverseRevokeService;

  readonly taskType = DurableTaskType.REVOKE_USER_RELATIONSHIP;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly database: DatabaseService,
    private readonly participants: AccountThreadStateService,
    private readonly groups: GroupService,
    private readonly relationships: RelationshipService,
    private readonly localRequests: RelationshipRequestTaskExecutionService,
    private readonly remoteRequests: FederatedRelationshipRequestTaskExecutionService,
    private readonly groupRequests: FederatedGroupTaskExecutionService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    if (task.payload.operation === 'RESPOND_TO_REVOKE')
      return this.reverseRevokes.execute(task);
    if (task.kind !== 'MUTATION' || task.actorUserId === null)
      throw new Error('Invalid user relationship revocation');
    const intentAuthorUserId = relationshipTaskAuthorUserId(task);
    const {
      threadId,
      peerUserId,
      account,
      domain,
      expectedAuthorizationEpoch,
    } = task.payload;
    if (
      typeof peerUserId === 'number' &&
      Number.isSafeInteger(peerUserId) &&
      peerUserId > 0 &&
      task.scopeType === 'USER_PAIR'
    ) {
      const [state] = await this.relationships.friendRelationshipStatuses(
        intentAuthorUserId,
        [peerUserId],
      );
      if (state?.status === 'INCOMING_PENDING')
        await this.localRequests.reject(peerUserId, intentAuthorUserId);
      else await this.localRequests.revoke(peerUserId, intentAuthorUserId);
      return;
    }
    if (typeof account === 'string' && typeof domain === 'string') {
      const target = { actorUserId: intentAuthorUserId, account, domain };
      if (account.startsWith('!') && task.scopeType === 'GROUP')
        await this.groupRequests.revoke(target);
      else if (!account.startsWith('!') && task.scopeType === 'USER_PAIR')
        await this.remoteRequests.revoke(target);
      else throw new Error('User relationship revocation scope mismatch');
      return;
    }
    if (
      typeof threadId !== 'number' ||
      !Number.isSafeInteger(threadId) ||
      threadId <= 0
    )
      throw new Error('Invalid user relationship revocation target');
    if (
      expectedAuthorizationEpoch !== undefined &&
      (typeof expectedAuthorizationEpoch !== 'number' ||
        !Number.isSafeInteger(expectedAuthorizationEpoch) ||
        expectedAuthorizationEpoch < 0)
    )
      throw new Error('Invalid revocation authorization epoch');
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { type: true },
    });
    if (!thread) return;
    if (thread.type === 'P2P' && task.scopeType === 'USER_PAIR') {
      const ended = await this.participants.endP2P(
        threadId,
        intentAuthorUserId,
        expectedAuthorizationEpoch as number | undefined,
        task.actorUserId!,
      );
      for (const peerDomain of ended.statePeers)
        this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
    } else if (thread.type === 'GROUP' && task.scopeType === 'GROUP') {
      await this.groups.leaveGroup({ userId: intentAuthorUserId, threadId });
    } else throw new Error('User relationship revocation scope mismatch');
  }
}
