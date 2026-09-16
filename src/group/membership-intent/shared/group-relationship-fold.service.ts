import { initializeRelationshipThreadStateInTx } from '../../../federation/federation-relationship-thread-state.js';
import type { AccountTarget } from '../../../user/account-address.js';
import { Inject, Injectable } from '@nestjs/common';
import { ThreadPreviewService } from '../../../message/thread-preview.service.js';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import { GroupRole } from '../../../database/enums.js';
import {
  RelationshipIntentService,
  type RelationshipIntentStatus,
} from '../../../relationship/relationship-intent.service.js';
import { GroupMembershipProjectionService } from './group-membership-projection.service.js';
import { AuthoritativeMembershipFinalizerService } from './authoritative-membership-finalizer.service.js';
import type { ThreadContentLock } from '../../../common/locks/thread-content-lock.js';

/** Applies an authored group intent and synchronizes every projection derived from pair.active. */
@Injectable()
export class GroupRelationshipFoldService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupMembership: GroupMembershipProjectionService,
    private readonly membershipFinalizer: AuthoritativeMembershipFinalizerService,
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
    const locked = await this.relationshipIntents.lockGroupMutationInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
    });
    return this.writeLockedAuthoredIntentInTx(tx, {
      ...params,
      pairId: locked.id,
      memberDomain: locked.endpointB.domain,
      threadLock: locked.threadLock,
    });
  }

  /** Apply an authored direction using the caller's canonical relationship
   * lock capability; no locator, authorization, or lock acquisition occurs. */
  async writeLockedAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      pairId: bigint;
      memberDomain: string;
      threadLock: ThreadContentLock;
      author: 'GROUP' | 'MEMBER';
      hostedLocally: boolean;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
      initialRole?: typeof GroupRole.OWNER;
      allowOwnerDeactivation?: boolean;
      updateCanonicalRoster?: boolean;
      validatedPairActive?: boolean;
    },
  ) {
    const membership =
      await this.relationshipIntents.writeLockedGroupAuthoredIntentInTx(tx, {
        pairId: params.pairId,
        threadId: params.threadId,
        threadLock: params.threadLock,
        authorSide: params.author === 'GROUP' ? 'A' : 'B',
        status: params.status,
        note: params.note,
        expiresAt: params.expiresAt,
        ...(params.validatedPairActive === undefined
          ? {}
          : { validatedPairActive: params.validatedPairActive }),
      });
    const active = params.status !== 'REVOKED' && membership.shouldBeActive;
    const synchronized = await this.syncLockedActiveInTx(tx, {
      ...params,
      active,
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
    threadFanoutAdmitted: boolean;
  }> {
    const locked = await this.relationshipIntents.lockGroupMutationInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
    });
    return this.syncLockedActiveInTx(tx, {
      ...params,
      pairId: locked.id,
      memberDomain: locked.endpointB.domain,
      threadLock: locked.threadLock,
    });
  }

  private async syncLockedActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      pairId: bigint;
      memberDomain: string;
      threadLock: ThreadContentLock;
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
    threadFanoutAdmitted: boolean;
  }> {
    const pairChanged =
      await this.relationshipIntents.setLockedGroupPairActiveInTx(tx, {
        pairId: params.pairId,
        threadId: params.threadId,
        threadLock: params.threadLock,
        memberDomain: params.memberDomain,
        active: params.active,
      });
    const memberProfileRev =
      params.active && params.hostedLocally
        ? await this.relationshipIntents.readLockedGroupMemberProfileRevInTx(
            tx,
            {
              pairId: params.pairId,
              threadId: params.threadId,
              threadLock: params.threadLock,
            },
          )
        : undefined;
    const membership = await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: params.active,
      pairChanged,
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
      await this.previews.initializeReadWindowsInTx(
        tx,
        params.threadId,
        [params.memberUserId],
        params.threadLock,
      );
      await initializeRelationshipThreadStateInTx(
        tx,
        params.threadId,
        params.pairId,
        params.threadLock,
      );
    }
    const finalized = params.hostedLocally
      ? await this.membershipFinalizer.finalizeInTx(tx, {
          threadId: params.threadId,
          groupId: params.groupId,
          memberUserId: params.memberUserId,
          active: params.active,
          canonicalRosterChanged: membership.canonicalRosterChanged,
          threadLock: params.threadLock,
        })
      : { audienceChanged: false, threadFanoutAdmitted: false };
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
    threadFanoutAdmitted: boolean;
    effect?: T;
  }> {
    const activation = await this.relationshipIntents.setGroupPairActiveInTx(
      tx,
      {
        groupId: params.groupId,
        memberUserId: params.memberUserId,
        threadId: params.threadId,
        active: false,
      },
    );
    const pairChanged = activation.changed;
    if (!pairChanged)
      return {
        pairChanged: false,
        canonicalRosterChanged: false,
        audienceChanged: false,
        threadFanoutAdmitted: false,
      };
    const effect = await params.afterPairDeactivated();
    const membership = await this.groupMembership.syncFromActiveInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: false,
      pairChanged: true,
      hostedLocally: params.hostedLocally,
    });
    const finalized = await this.membershipFinalizer.finalizeInTx(tx, {
      threadId: params.threadId,
      groupId: params.groupId,
      memberUserId: params.memberUserId,
      active: false,
      canonicalRosterChanged: membership.canonicalRosterChanged,
      threadLock: activation.threadLock,
    });
    return { pairChanged: true, ...membership, ...finalized, effect };
  }
}
