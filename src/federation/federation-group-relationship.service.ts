import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  RelationshipIntentService,
  type RelationshipIntentStatus,
} from '../invite/relationship-intent.service.js';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';

/** Applies an authored group intent and synchronizes every projection derived from pair.active. */
@Injectable()
export class FederationGroupRelationshipService {
  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupMembership: FederationGroupMembershipService,
  ) {}

  async writeAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupUserId: number;
      memberUserId: number;
      authorUserId: number;
      hostedLocally: boolean;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
    },
  ) {
    const membership = await this.relationshipIntents.writeAuthoredIntentInTx(
      tx,
      {
        groupUserId: params.groupUserId,
        memberUserId: params.memberUserId,
        authorUserId: params.authorUserId,
        status: params.status,
        note: params.note,
        expiresAt: params.expiresAt,
      },
    );
    const active = params.status !== 'REVOKED' && membership.shouldBeActive;
    const pairChanged = await this.syncActiveInTx(tx, {
      threadId: params.threadId,
      groupUserId: params.groupUserId,
      memberUserId: params.memberUserId,
      active,
      hostedLocally: params.hostedLocally,
    });
    return { ...membership, active, pairChanged };
  }

  async syncActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupUserId: number;
      memberUserId: number;
      active: boolean;
      hostedLocally: boolean;
    },
  ): Promise<boolean> {
    const pairChanged = await this.relationshipIntents.setPairActiveInTx(
      tx,
      params.groupUserId,
      params.memberUserId,
      params.active,
    );
    if (params.hostedLocally)
      await this.groupMembership.syncFromActiveInTx(tx, {
        threadId: params.threadId,
        memberUserId: params.memberUserId,
        active: params.active,
      });
    return pairChanged;
  }

  async deactivateAfterInTx<T>(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupUserId: number;
      memberUserId: number;
      hostedLocally: boolean;
      afterPairDeactivated: () => Promise<T>;
    },
  ): Promise<{ pairChanged: boolean; effect?: T }> {
    const pairChanged = await this.relationshipIntents.setPairActiveInTx(
      tx,
      params.groupUserId,
      params.memberUserId,
      false,
    );
    if (!pairChanged) return { pairChanged: false };
    const effect = await params.afterPairDeactivated();
    if (params.hostedLocally)
      await this.groupMembership.syncFromActiveInTx(tx, {
        threadId: params.threadId,
        memberUserId: params.memberUserId,
        active: false,
      });
    return { pairChanged: true, effect };
  }
}
