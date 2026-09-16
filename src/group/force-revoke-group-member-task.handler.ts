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
import {
  readForcedMemberRevokeTask,
  readMirrorGroupMemberRevokeTask,
  readQueryDeniedGroupMembershipRevocationTask,
} from './group-disband-task.js';
import { GroupDisbandMembershipRevocationService } from './disband/group-disband-membership-revocation.service.js';
import { MirrorGroupDisbandService } from './disband/mirror-group-disband.service.js';
import { GroupAuthoredMembershipIntentService } from './membership-intent/authored/group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from './membership-intent/authored/member-authored-group-membership-intent.service.js';

@Injectable()
export class ForceRevokeGroupMemberTaskHandler
  implements DurableTaskHandler, OnModuleInit, OnModuleDestroy
{
  readonly taskType = DurableTaskType.FORCE_REVOKE_GROUP_MEMBER;
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly disbandMembershipRevocations: GroupDisbandMembershipRevocationService,
    private readonly mirrorDisbands: MirrorGroupDisbandService,
    private readonly groupAuthoredIntents: GroupAuthoredMembershipIntentService,
    private readonly memberAuthoredIntents: MemberAuthoredGroupMembershipIntentService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(task: DurableTask): Promise<void> {
    // The mirror sweep carries no denial coordinates — only its direction mark,
    // which must be tested before the peerDomain probe below.
    if (task.payload.direction === 'MIRROR') {
      await this.mirrorDisbands.revokeMember(
        readMirrorGroupMemberRevokeTask(task),
      );
      return;
    }
    if (task.payload.peerDomain !== undefined) {
      const command = readQueryDeniedGroupMembershipRevocationTask(task);
      if (command.direction === 'GROUP')
        await this.groupAuthoredIntents.executeQueryDeniedRevocation({
          threadId: command.threadId,
          group: command.group,
          member: command.member,
          expectedAuthorizationEpoch: command.expectedAuthorizationEpoch,
        });
      else
        await this.memberAuthoredIntents.executeQueryDeniedRevocation({
          threadId: command.threadId,
          group: command.group,
          memberUserId: command.memberUserId,
          expectedAuthorizationEpoch: command.expectedAuthorizationEpoch,
        });
      return;
    }
    const command = readForcedMemberRevokeTask(task);
    await this.disbandMembershipRevocations.execute({
      threadId: command.threadId,
      memberAddress: command.memberUserId,
    });
  }
}
