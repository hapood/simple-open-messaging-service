import { initializeRelationshipThreadStateInTx } from './federation-relationship-thread-state.js';
import type { AccountTarget } from '../user/account-address.js';
import { Inject, Injectable } from '@nestjs/common';
import { ThreadPreviewService } from '../message/thread-preview.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import {
  RelationshipIntentService,
  type RelationshipIntentStatus,
} from '../relationship/relationship-intent.service.js';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';
import { AuthoritativeGroupMembershipFinalizer } from './authoritative-group-membership-finalizer.service.js';

/** Applies an authored group intent and synchronizes every projection derived from pair.active. */
@Injectable()
export class FederationGroupRelationshipService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupMembership: FederationGroupMembershipService,
    private readonly membershipFinalizer: AuthoritativeGroupMembershipFinalizer,
  ) {}

  async writeAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      author: 'GROUP' | 'MEMBER';
      hostedLocally: boolean;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
      initialRole?: typeof GroupRole.OWNER;
      allowOwnerDeactivation?: boolean;
      updateCanonicalRoster?: boolean;
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
    const synchronized = await this.syncActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active,
      hostedLocally: params.hostedLocally,
      ...(params.initialRole ? { initialRole: params.initialRole } : {}),
      ...(params.allowOwnerDeactivation
        ? { allowOwnerDeactivation: true }
        : {}),
      ...(params.updateCanonicalRoster === false
        ? { updateCanonicalRoster: false }
        : {}),
    });
    return { ...membership, active, ...synchronized };
  }

  async syncActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      active: boolean;
      hostedLocally: boolean;
      initialRole?: typeof GroupRole.OWNER;
      allowOwnerDeactivation?: boolean;
      updateCanonicalRoster?: boolean;
    },
  ): Promise<{
    pairChanged: boolean;
    canonicalRosterChanged: boolean;
    audienceChanged: boolean;
    fanoutTaskCreated: boolean;
  }> {
    const pairChanged = await this.relationshipIntents.setGroupPairActiveInTx(
      tx,
      {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        active: params.active,
      },
    );
    const memberProfileRev =
      params.active && params.hostedLocally
        ? await this.relationshipIntents.readGroupMemberProfileRevInTx(tx, {
            threadId: params.threadId,
            groupId: params.groupId,
            memberUserId: params.memberUserId,
          })
        : undefined;
    const membership = await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: params.active,
      hostedLocally: params.hostedLocally,
      ...(params.initialRole ? { initialRole: params.initialRole } : {}),
      ...(memberProfileRev === undefined ? {} : { memberProfileRev }),
      ...(params.allowOwnerDeactivation
        ? { allowOwnerDeactivation: true }
        : {}),
      ...(params.updateCanonicalRoster === false
        ? { updateCanonicalRoster: false }
        : {}),
    });
    if (pairChanged && params.active) {
      await this.previews.initializeReadWindowsInTx(tx, params.threadId, [
        params.memberUserId,
      ]);
      const pair = await this.relationshipIntents.lockGroupMutationInTx(
        tx,
        params,
      );
      await initializeRelationshipThreadStateInTx(
        tx,
        params.threadId,
        pair.id,
        pair.threadLock,
      );
    }
    const finalized = await this.membershipFinalizer.finalizeInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: params.active,
      canonicalRosterChanged: membership.canonicalRosterChanged,
    });
    return { pairChanged, ...membership, ...finalized };
  }

  async deactivateAfterInTx<T>(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      hostedLocally: boolean;
      afterPairDeactivated: () => Promise<T>;
    },
  ): Promise<{
    pairChanged: boolean;
    canonicalRosterChanged: boolean;
    audienceChanged: boolean;
    fanoutTaskCreated: boolean;
    effect?: T;
  }> {
    const pairChanged = await this.relationshipIntents.setGroupPairActiveInTx(
      tx,
      {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        active: false,
      },
    );
    if (!pairChanged)
      return {
        pairChanged: false,
        canonicalRosterChanged: false,
        audienceChanged: false,
        fanoutTaskCreated: false,
      };
    const effect = await params.afterPairDeactivated();
    const membership = await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: false,
      hostedLocally: params.hostedLocally,
    });
    const finalized = await this.membershipFinalizer.finalizeInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: false,
      canonicalRosterChanged: membership.canonicalRosterChanged,
    });
    return { pairChanged: true, ...membership, ...finalized, effect };
  }
}
