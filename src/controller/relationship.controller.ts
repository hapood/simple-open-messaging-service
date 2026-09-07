import {
  Controller,
  Post,
  Body,
  Request,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserService } from '../user/user.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { FederationService } from '../federation/federation.service.js';
import { ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  AcceptRelationshipDto,
  ReadRelationshipRequestsDto,
  RequestRelationshipDto,
  RevokeRelationshipDto,
} from '../dto/relationship.dto.js';
import { normalizeAccount } from '../common/account.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskAcceptedDto } from '../dto/durable-task.dto.js';

/**
 * Relationship endpoints for user and group membership intents. Federated request submission is local-only;
 * address resolution completes peer recognition and checks Health before this controller admits its
 * DurableTask.
 */
@ApiTags('relationship')
@Controller('relationship')
export class RelationshipController {
  constructor(
    private readonly userService: UserService,
    private readonly relationships: RelationshipService,
    private readonly participantService: AccountThreadStateService,
    private readonly federationService: FederationService,
    private readonly durableTasks: DurableTaskQueueService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('requests/read')
  @ApiOperation({
    summary: 'Advance the account-wide relationship-request read watermark',
  })
  async markRelationshipRequestsRead(
    @Request() req: FastifyRequest,
    @Body() dto: ReadRelationshipRequestsDto,
  ) {
    return {
      readThroughFeedId:
        await this.clientStateFeed.markRelationshipRequestsRead(
          req.user.userId,
          dto.readThroughFeedId,
        ),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  @ApiOperation({
    summary:
      'Revoke a user relationship/request or a pending federated group-join request by Address',
  })
  @ApiResultResponse(DurableTaskAcceptedDto)
  async revokeRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: RevokeRelationshipDto,
  ): Promise<DurableTaskAcceptedDto> {
    const me = req.user.userId;
    const account = normalizeAccount(dto.account);
    const domain = dto.domain.trim().toLowerCase();
    if (account.startsWith('!')) {
      const address =
        await this.federationService.resolveGroupJoinRequestCommandScope(me, {
          account,
          domain,
        });
      const { taskId } = await this.durableTasks.enqueueTask({
        scope: { type: 'GROUP', address },
        taskType: DurableTaskType.REVOKE_FEDERATED_GROUP_JOIN,
        actorUserId: me,
        payload: address,
      });
      return { taskId: taskId.toString(), status: 'PENDING' };
    }
    const remoteContext =
      domain === 'local'
        ? undefined
        : await this.relationships.federatedRelationshipContext(
            me,
            account,
            domain,
          );
    const [actor, localTarget] = await Promise.all([
      this.userService.findUniqueUser({ id: me }),
      domain === 'local'
        ? this.userService.findUniqueUser({
            account_domain: { account, domain },
            namespaceId: 0,
          })
        : Promise.resolve(null),
    ]);
    if (!actor) throw new Error('authenticated user profile is missing');
    if (localTarget?.id === me) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not revoke relationship with self',
      );
    }
    if (localTarget) {
      const [relationship] =
        await this.relationships.friendRelationshipStatuses(me, [
          localTarget.id,
        ]);
      if (
        relationship.status === 'OUTGOING_PENDING' ||
        relationship.status === 'INCOMING_PENDING'
      ) {
        const { taskId } = await this.durableTasks.enqueueTask({
          scope: {
            type: 'USER_PAIR',
            endpoints: [
              { account: actor.account, domain: actor.domain },
              { account: localTarget.account, domain: localTarget.domain },
            ],
          },
          taskType:
            relationship.status === 'OUTGOING_PENDING'
              ? DurableTaskType.REVOKE_RELATIONSHIP_REQUEST
              : DurableTaskType.REJECT_RELATIONSHIP_REQUEST,
          actorUserId: me,
          payload: { peerUserId: localTarget.id },
        });
        return { taskId: taskId.toString(), status: 'PENDING' };
      }
      if (relationship?.status !== 'FRIEND') {
        throw new BusinessException(
          BusinessCode.FRIEND_NOT_FOUND,
          `relationship with [${account}@${domain}] does not exist`,
        );
      }
    }
    if (remoteContext) {
      const relationship = remoteContext.status;
      if (
        relationship === 'INCOMING_PENDING' ||
        relationship === 'OUTGOING_PENDING'
      ) {
        const { taskId } = await this.durableTasks.enqueueTask({
          scope: {
            type: 'USER_PAIR',
            endpoints: [
              { account: actor.account, domain: actor.domain },
              { account, domain },
            ],
          },
          taskType: DurableTaskType.REVOKE_ADDRESSED_RELATIONSHIP_REQUEST,
          actorUserId: me,
          payload: { account, domain },
        });
        return { taskId: taskId.toString(), status: 'PENDING' };
      }
      if (relationship !== 'FRIEND') {
        throw new BusinessException(
          BusinessCode.FRIEND_NOT_FOUND,
          `relationship with [${account}@${domain}] does not exist`,
        );
      }
    }
    const target =
      localTarget ??
      (remoteContext?.namespaceId
        ? { account, domain, namespaceId: remoteContext.namespaceId }
        : null);
    if (!target) {
      throw new BusinessException(
        BusinessCode.FRIEND_NOT_FOUND,
        `relationship with [${account}@${domain}] does not exist`,
      );
    }
    const threadId = await this.participantService.findP2PThreadBetween(
      me,
      localTarget?.id ?? target,
    );
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.FRIEND_NOT_FOUND,
        `relationship with [${account}@${domain}] does not exist`,
      );
    }
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: actor.account, domain: actor.domain },
          { account: target.account, domain: target.domain },
        ],
      },
      taskType: DurableTaskType.END_FRIENDSHIP,
      actorUserId: me,
      payload: { threadId },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('request')
  @ApiOperation({
    summary: 'Request a user or group relationship by Address',
  })
  @ApiResultResponse(DurableTaskAcceptedDto)
  async requestRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: RequestRelationshipDto,
  ): Promise<DurableTaskAcceptedDto> {
    const me = req.user.userId;
    const account = dto.account.trim().toLowerCase();
    const domain = dto.domain.trim().toLowerCase();
    if (account.startsWith('!')) {
      if (domain === 'local' || domain === this.federationService.ourDomain) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'a local group relationship requires an existing group invitation',
        );
      }
      const { taskId } = await this.durableTasks.enqueueTask({
        scope: { type: 'GROUP', address: { account, domain } },
        taskType: DurableTaskType.REQUEST_FEDERATED_GROUP_JOIN,
        actorUserId: me,
        payload: {
          account,
          domain,
          note: dto.note ?? '',
          displayName: dto.displayName!,
          ...(dto.avatar ? { avatar: dto.avatar } : {}),
        },
      });
      return { taskId: taskId.toString(), status: 'PENDING' };
    }
    if (domain !== 'local') {
      return this.enqueueFederatedRelationshipRequest(me, {
        account,
        domain,
        note: dto.note ?? '',
        displayName: dto.displayName!,
        avatar: dto.avatar,
      });
    }
    const [actor, target] = await Promise.all([
      this.userService.findUniqueUser({ id: me }),
      this.userService.findUniqueUser({
        account_domain: { account, domain: 'local' },
        namespaceId: 0,
      }),
    ]);
    if (!actor || actor.availability !== 'AVAILABLE') {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    }
    if (target && me === target.id) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not request a relationship with yourself',
      );
    }
    if (!target || target.availability !== 'AVAILABLE') {
      // Errors are localized client-side by their numeric code (see ApiResult.messageKey) — they carry no
      // messageKey — so this throws and flows through the global AllExceptionsFilter like every other error.
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'user does not exist',
      );
    }
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: actor.account, domain: actor.domain },
          { account: target.account, domain: target.domain },
        ],
      },
      taskType: DurableTaskType.SEND_LOCAL_RELATIONSHIP_REQUEST,
      actorUserId: me,
      payload: {
        targetUserId: target.id,
        note: dto.note ?? '',
      },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
  }

  private async enqueueFederatedRelationshipRequest(
    actorUserId: number,
    dto: {
      account: string;
      domain: string;
      note: string;
      displayName: string;
      avatar?: string;
    },
  ): Promise<DurableTaskAcceptedDto> {
    const { account, domain } = dto;
    if (domain === this.federationService.ourDomain)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        "local targets must use domain 'local'",
      );
    const actor = await this.userService.findUniqueUser({ id: actorUserId });
    if (!actor || actor.availability !== 'AVAILABLE') {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    }
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: actor.account, domain: actor.domain },
          { account, domain },
        ],
      },
      taskType: DurableTaskType.SEND_FEDERATED_RELATIONSHIP_REQUEST,
      actorUserId,
      payload: {
        account,
        domain,
        note: dto.note,
        displayName: dto.displayName,
        ...(dto.avatar ? { avatar: dto.avatar } : {}),
      },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('accept')
  @ApiOperation({
    summary:
      'Accept a relationship request by intent id or Address (friend → P2P thread; group → join as MEMBER)',
  })
  async acceptRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: AcceptRelationshipDto,
  ) {
    const me = req.user.userId;
    const account = normalizeAccount(dto.account);
    const domain = dto.domain.trim().toLowerCase();
    if (account.startsWith('!')) {
      const scope =
        await this.federationService.resolveAddressedGroupInvitationCommandScope(
          me,
          { account, domain },
        );
      const { taskId } = await this.durableTasks.enqueueTask({
        scope: { type: 'GROUP', address: scope },
        taskType: DurableTaskType.ACCEPT_ADDRESSED_GROUP_INVITATION,
        actorUserId: me,
        payload: scope,
      });
      return { taskId: taskId.toString(), status: 'PENDING' as const };
    }
    const scope = await this.relationships.resolveP2PRequestCommandScope(
      me,
      account,
      domain,
      'INCOMING',
    );
    if (scope.peerUserId !== null) {
      const { taskId } = await this.durableTasks.enqueueTask({
        scope: {
          type: 'USER_PAIR',
          endpoints: [scope.local, scope.remote],
        },
        taskType: DurableTaskType.ACCEPT_RELATIONSHIP_REQUEST,
        actorUserId: me,
        payload: { peerUserId: scope.peerUserId },
      });
      return { taskId: taskId.toString(), status: 'PENDING' as const };
    }
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: { type: 'USER_PAIR', endpoints: [scope.local, scope.remote] },
      taskType: DurableTaskType.ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST,
      actorUserId: me,
      payload: scope.remote,
    });
    return { taskId: taskId.toString(), status: 'PENDING' as const };
  }
}
