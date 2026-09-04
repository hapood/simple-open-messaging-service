import { Injectable } from '@nestjs/common';
import { FederationService } from './federation.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';

@Injectable()
export class FederatedGroupTaskExecutionService {
  constructor(
    private readonly federation: FederationService,
    private readonly userQuota: UserQuotaService,
  ) {}

  async request(params: {
    actorUserId: number;
    account: string;
    domain: string;
    note: string;
    displayName: string;
    avatar?: string;
  }): Promise<void> {
    await this.federation.requestFederatedGroupJoin(
      params.actorUserId,
      { account: params.account, domain: params.domain },
      params.note,
      { displayName: params.displayName, avatar: params.avatar },
      (tx) => this.userQuota.tick(params.actorUserId, 'requests', tx),
    );
  }

  revoke(params: {
    actorUserId: number;
    account: string;
    domain: string;
  }): Promise<void> {
    return this.federation.revokeGroupJoinRequest(params.actorUserId, {
      account: params.account,
      domain: params.domain,
    });
  }

  async accept(params: {
    actorUserId: number;
    account: string;
    domain: string;
  }): Promise<void> {
    await this.federation.acceptAddressedGroupInvitation(params.actorUserId, {
      account: params.account,
      domain: params.domain,
    });
  }
}
