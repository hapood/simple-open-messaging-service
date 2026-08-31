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
      groupId: number;
      memberUserId: number;
      author: 'GROUP' | 'MEMBER';
      hostedLocally: boolean;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
      allowOwnerDeactivation?: boolean;
    },
  ) {
    const membership =
      await this.relationshipIntents.writeGroupAuthoredIntentInTx(tx, {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        author: params.author,
        status: params.status,
        note: params.note,
        expiresAt: params.expiresAt,
      });
    const active = params.status !== 'REVOKED' && membership.shouldBeActive;
    const pairChanged = await this.syncActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active,
      hostedLocally: params.hostedLocally,
      ...(params.allowOwnerDeactivation
        ? { allowOwnerDeactivation: true }
        : {}),
    });
    return { ...membership, active, pairChanged };
  }

  async syncActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: number;
      active: boolean;
      hostedLocally: boolean;
      allowOwnerDeactivation?: boolean;
    },
  ): Promise<boolean> {
    const pairChanged = await this.relationshipIntents.setGroupPairActiveInTx(
      tx,
      {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        active: params.active,
      },
    );
    await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      memberUserId: params.memberUserId,
      active: params.active,
      hostedLocally: params.hostedLocally,
      ...(params.allowOwnerDeactivation
        ? { allowOwnerDeactivation: true }
        : {}),
    });
    return pairChanged;
  }

  async deactivateAfterInTx<T>(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: number;
      hostedLocally: boolean;
      afterPairDeactivated: () => Promise<T>;
    },
  ): Promise<{ pairChanged: boolean; effect?: T }> {
    const pairChanged = await this.relationshipIntents.setGroupPairActiveInTx(
      tx,
      {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        active: false,
      },
    );
    if (!pairChanged) return { pairChanged: false };
    const effect = await params.afterPairDeactivated();
    await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      memberUserId: params.memberUserId,
      active: false,
      hostedLocally: params.hostedLocally,
    });
    return { pairChanged: true, effect };
  }
}
