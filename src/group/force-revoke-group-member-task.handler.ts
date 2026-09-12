import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type {
  DurableTask,
  DurableTaskHandler,
} from '../durable-task/durable-task.types.js';
import { readForcedMemberRevokeTask } from './group-disband-task.js';
import { GroupDisbandMembershipRevocationService } from '../business/group/disband/group-disband-membership-revocation.service.js';
import { FederationThreadQueryDenialService } from '../federation/federation-thread-query-denial.service.js';

@Injectable()
export class ForceRevokeGroupMemberTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FORCE_REVOKE_GROUP_MEMBER;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly disbandMembershipRevocations: GroupDisbandMembershipRevocationService,
    private readonly denial: FederationThreadQueryDenialService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    if (task.payload.peerDomain !== undefined) {
      await this.denial.revokeForbiddenMember(task);
      return;
    }
    const command = readForcedMemberRevokeTask(task);
    await this.disbandMembershipRevocations.execute({
      threadId: command.threadId,
      memberAddress: command.memberUserId,
    });
  }
}
