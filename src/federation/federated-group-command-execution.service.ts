import { Injectable, Logger } from '@nestjs/common';
import { FederationService } from './federation.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';

@Injectable()
export class FederatedGroupCommandExecutionService {
  private readonly logger = new Logger(
    FederatedGroupCommandExecutionService.name,
  );

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
    await this.federation.ensurePeerTrusted(params.domain);
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
    const peers = await this.federation.acceptAddressedFriendRequest(
      params.actorUserId,
      { account: params.account, domain: params.domain },
    );
    void this.federation
      .pushStateFeedDomains(peers.keys())
      .catch((error: unknown) =>
        this.logger.warn('group invitation federation wake failed', error),
      );
  }
}
