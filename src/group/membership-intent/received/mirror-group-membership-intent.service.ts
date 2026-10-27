import { and, eq, sql } from 'drizzle-orm';
import { relationshipIntentPromotionSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import * as tables from '../../../database/schema.js';
import { Logger } from '@nestjs/common';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationStateFeedPusher } from '../../../federation/federation-state-feed.events.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import type { GroupRelationshipMutationService } from '../shared/group-relationship-mutation.service.js';
import { initializeRelationshipThreadStateInTx } from '../../../federation/federation-relationship-thread-state.js';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { groupStateFields, readGroupState } from '../../shared/group-state.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import { ensureMirrorGroupShellInTx } from '../../shared/ensure-mirror-group-shell-in-tx.js';
import {
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';
import { mintGroupMemberPairInTx } from '../shared/group-member-pair-mint.js';
import { mirrorGroupDirection } from './mirror-membership-shared-sql.js';
import {
  mirrorMembershipStateSql,
  type MirrorMembershipStateRow,
} from './mirror-membership-state-sql.js';
import { mirrorMembershipRequestIntentWrite } from './mirror-membership-request-sql.js';
import {
  mirrorMembershipActivationIntentWrite,
  mirrorMembershipActivationSql,
} from './mirror-membership-acceptance-sql.js';
import {
  mirrorMembershipRevocationIntentWrite,
  mirrorMembershipRevocationSql,
} from './mirror-membership-revocation-sql.js';
import { writeMirrorLocalGroupLeftInTx } from '../shared/mirror-local-group-left.js';
import {
  InvalidReceivedIntentError,
  validateReceivedIntentBody,
} from './received-membership-body.js';

/** A group-authored RELATIONSHIP_INTENT body as it arrives on the state feed
 * (times are epoch milliseconds). Positive statuses carry the origin's thread
 * heads; REVOKED carries none. */
interface MirrorGroupMembershipIntentBody {
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  profileNamespaceId: number;
  profileRev: number;
  note: string;
  statusChangedAt: number;
  expiresAt: number | null;
  messageEndSeq?: number;
  tombstoneEndSeq?: number;
}

/** One command: apply a received group-authored intent to the local mirror
 * inside the State Feed consumer transaction. */
export interface MirrorGroupMembershipIntentCommand {
  group: { account: string; namespaceId: number };
  /** The item's subject — the local member this group intent addresses. */
  memberAccount: string;
  body: MirrorGroupMembershipIntentBody;
}

/** Routing outcomes, for tests and diagnostics. `noop:*` rows never change
 * local authored directions or relationship effects; a dropped ACK may still
 * retain the peer-authored snapshot. */
export type MirrorMembershipRouting =
  | 'activated'
  | 'completion'
  | 'confirmed'
  | 'recorded-request'
  | 'mismatch'
  | 'kick'
  | 'dangling-conclusion'
  | 'application-rejected'
  | 'rejected'
  | 'recorded-revocation'
  | `noop:${string}`;

/** How long a routing decision waited for its locks is irrelevant to the
 * outcome: every input lands on a routing row, and business divergence is
 * expressed as record + write-back, never as a throw. Only an invalid item or
 * a missing local subject raises (permanent, for the future consumer to map). */
class InvalidMirrorItemError extends InvalidReceivedIntentError {}

interface ActivationContext {
  threadId: number;
  command: MirrorGroupMembershipIntentCommand;
  presentation: MirrorGroupPresentationInput;
  memberId: number;
  pairId: bigint;
  threadLock: ThreadContentLock;
  persistStatus: 'REQUESTED' | 'ACCEPTED';
  promote: boolean;
  intent: {
    profileNamespaceId: number;
    profileRev: number;
    note: string;
    statusChangedAt: Date;
    expiresAt: Date | null;
    messageEndSeq: number;
    tombstoneEndSeq: number;
  };
  clientUpdates: PendingClientStateFeedUpdate[];
  peers: Set<number>;
  routed: MirrorMembershipRouting;
}

export class MirrorGroupMembershipIntentService {
  private readonly logger = new Logger(MirrorGroupMembershipIntentService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clientFeed: ClientStateFeedService,
    private readonly peerFeed: PeerStateFeedService,
    private readonly federation: FederationStateFeedPusher,
    private readonly memberMutations: GroupRelationshipMutationService,
  ) {}

  async execute(
    command: MirrorGroupMembershipIntentCommand,
  ): Promise<{ routed: MirrorMembershipRouting }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = new Set<number>();
    const applied = await this.database.db.transaction(async (tx) =>
      this.applyInTx(tx, command, clientUpdates, peers),
    );
    const routed = applied.routed;
    if (routed.startsWith('noop:')) return { routed };
    try {
      if (clientUpdates.length > 0)
        this.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('mirror intent client-state wake failed', error);
    }
    if (peers.size > 0)
      void this.federation.pushStateFeedNamespaces(peers.keys());
    return { routed };
  }

  /** Wire body validation is shared by all received-intent appliers through
   * validateReceivedIntentBody. */

  async applyInTx(
    tx: DatabaseTransaction,
    command: MirrorGroupMembershipIntentCommand,
    clientUpdates: PendingClientStateFeedUpdate[],
    peers: Set<number>,
  ): Promise<{ routed: MirrorMembershipRouting; threadId?: number }> {
    const intent = validateReceivedIntentBody(command.body);
    if (!intent) return { routed: 'noop:expired-request' };
    const group = command.group;
    const memberAccount = command.memberAccount;
    const [member] = await tx
      .select({ id: tables.account.id })
      .from(tables.account)
      .where(
        and(
          eq(tables.account.account, memberAccount),
          eq(tables.account.namespaceId, 0),
          eq(tables.account.availability, 'AVAILABLE'),
        ),
      )
      .limit(1);
    if (!member)
      throw new InvalidMirrorItemError('mirror member does not exist');

    // Lock order: the group ACCOUNT scope at the authority namespace, before
    // the Pair scope, once per transaction (the shell mint's inner acquisition is
    // re-entrant).
    let threadId: number;
    const shell = await readGroupState(
      tx,
      and(
        eq(groupStateFields.account, group.account),
        eq(groupStateFields.namespaceId, group.namespaceId),
      ),
    );
    if (shell) {
      threadId = shell.id;
      await lockBusinessAccountsInTx(tx, [
        { account: group.account, profileNamespaceId: group.namespaceId },
      ]);
    } else {
      if (command.body.status !== 'REQUESTED')
        return { routed: 'noop:no-mirror-anchor' };
      threadId = (
        await ensureMirrorGroupShellInTx(tx, {
          account: group.account,
          namespaceId: group.namespaceId,
        })
      ).threadId;
    }

    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(group.account, group.namespaceId),
          completeBusinessAddress(memberAccount, 0),
        ],
      },
    ]);
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      threadId,
      threadId,
    );
    // The locator only named advisory scopes; re-read every mutable coordinate
    // under the thread row lock before routing.
    const stateInput = {
      threadId,
      groupAccount: group.account,
      groupNamespaceId: group.namespaceId,
      memberAccount,
    };
    const state = await this.readStateInTx(tx, stateInput);
    const lockedPairId = state.pairId === null ? null : BigInt(state.pairId);
    if (lockedPairId !== null) {
      const [pair] = await tx
        .select({ threadId: tables.relationshipPair.threadId })
        .from(tables.relationshipPair)
        .where(eq(tables.relationshipPair.id, lockedPairId))
        .for('no key update');
      if (!pair || pair.threadId !== threadId)
        throw new Error('mirror pair changed while acquiring locks');
      await tx.execute(
        sql`SELECT "authorAccount" FROM "RelationshipIntent" pair_intent
          WHERE (pair_intent."authorAccount", pair_intent."authorNamespaceId",
                 pair_intent."receiverAccount", pair_intent."receiverNamespaceId") IN (
            (${memberAccount}, 0, ${group.account}, ${group.namespaceId}),
            (${group.account}, ${group.namespaceId}, ${memberAccount}, 0)
          )
          ORDER BY pair_intent."authorAccount", pair_intent."receiverAccount"
          FOR NO KEY UPDATE`,
      );
    }
    const fresh = await this.readStateInTx(tx, stateInput);
    if (fresh.localMemberId !== null)
      await tx.execute(
        sql`SELECT participant.id FROM "AccountThreadState" participant
          WHERE participant."threadId" = ${threadId}
            AND participant."accountId" = ${fresh.localMemberId}
          ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant`,
      );
    await this.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
      { namespaceId: group.namespaceId },
    ]);
    const presentation: MirrorGroupPresentationInput = {
      groupAccount: group.account,
      groupNamespaceId: group.namespaceId,
    };
    const effective = (
      status: MirrorMembershipStateRow['memberIntentStatus'],
      expiresAt: string | null,
    ): boolean =>
      status === 'ACCEPTED' ||
      (status === 'REQUESTED' &&
        expiresAt !== null &&
        new Date(expiresAt) > new Date());

    const memberId = member.id;
    const wireIntent = {
      profileNamespaceId: command.body.profileNamespaceId,
      profileRev: command.body.profileRev,
      note: command.body.note ?? '',
      statusChangedAt: intent.statusChangedAt,
      expiresAt: intent.expiresAt,
      messageEndSeq: command.body.messageEndSeq ?? 0,
      tombstoneEndSeq: command.body.tombstoneEndSeq ?? 0,
    };
    // A dissolved mirror is local bookkeeping for lost read access, not a
    // terminal group: positive origin facts keep applying, and the activation
    // statement clears the dissolved flag when membership actually re-forms.
    // Only a dissolved LOCAL group is unreachable for positive facts, and that
    // gate lives in the local authored commands.
    if (command.body.status === 'REQUESTED') {
      if (fresh.pairActive) return { routed: 'noop:already-member' };
      if (effective(fresh.memberIntentStatus, fresh.memberIntentExpiresAt)) {
        // Collapse: a live application or a dangling acceptance meets the
        // invitation — both sides effective, the membership completes.
        return this.activateInTx(tx, {
          threadId,
          command,
          presentation,
          memberId,
          pairId:
            lockedPairId ??
            (await this.mintPair(tx, threadId, group, memberAccount)),
          threadLock,
          persistStatus: 'REQUESTED',
          promote: fresh.memberIntentStatus === 'REQUESTED',
          intent: wireIntent,
          clientUpdates,
          peers,
          routed:
            fresh.memberIntentStatus === 'REQUESTED'
              ? 'activated'
              : 'completion',
        });
      }
      if (lockedPairId === null)
        await this.mintPair(tx, threadId, group, memberAccount);
      await tx.execute(
        mirrorMembershipRequestIntentWrite({
          threadId,
          presentation,
          memberAccount,
          localMemberId: memberId,
          intent: {
            profileNamespaceId: wireIntent.profileNamespaceId,
            profileRev: wireIntent.profileRev,
            note: wireIntent.note,
            statusChangedAt: intent.statusChangedAt,
            expiresAt: intent.expiresAt!,
            messageEndSeq: wireIntent.messageEndSeq,
            tombstoneEndSeq: wireIntent.tombstoneEndSeq,
          },
        }),
      );
      // The mirrored invitation opens its round here with the local member as
      // receiver: their incoming head is published and woken after commit. The
      // remote-author round carries no author-side snapshot — the member's
      // incoming view resolves the group through the wire author-profile
      // coordinates. A mirrored remote-authority thread has no local manager
      // watermarks to advance.
      const effects = await this.memberMutations.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        { account: memberAccount, namespaceId: 0 },
        'REQUESTED',
        'INVITATION',
      );
      clientUpdates.push(...effects.clientUpdates);
      return { routed: 'recorded-request' };
    }

    if (command.body.status === 'ACCEPTED') {
      if (lockedPairId === null) return { routed: 'noop:no-mirror-anchor' };
      if (!fresh.pairActive && fresh.memberIntentStatus === 'REVOKED') {
        // A late group ACK is retained as the group's received direction, but
        // cannot revive the member's withdrawn direction or publish it again.
        await tx.execute(
          mirrorIntentWriteSql({
            ...mirrorGroupDirection(
              {
                groupAccount: group.account,
                groupNamespaceId: group.namespaceId,
              },
              memberAccount,
            ),
            status: 'ACCEPTED',
            note: wireIntent.note,
            statusChangedAt: wireIntent.statusChangedAt,
            expiresAt: null,
            profileNamespaceId: wireIntent.profileNamespaceId,
            profileRev: wireIntent.profileRev,
            messageEndSeq: wireIntent.messageEndSeq,
            tombstoneEndSeq: wireIntent.tombstoneEndSeq,
          }),
        );
        return { routed: 'noop:dropped-ack' };
      }
      if (fresh.pairActive) {
        // Activation may precede the origin's final ACK. Persist that later
        // group-side confirmation without replaying the join transition.
        const confirmed = await tx.execute(
          mirrorIntentWriteSql({
            ...mirrorGroupDirection(
              {
                groupAccount: group.account,
                groupNamespaceId: group.namespaceId,
              },
              memberAccount,
            ),
            status: 'ACCEPTED',
            note: wireIntent.note,
            statusChangedAt: wireIntent.statusChangedAt,
            expiresAt: null,
            profileNamespaceId: wireIntent.profileNamespaceId,
            profileRev: wireIntent.profileRev,
            messageEndSeq: wireIntent.messageEndSeq,
            tombstoneEndSeq: wireIntent.tombstoneEndSeq,
          }),
        );
        if (!confirmed.rows[0]) return { routed: 'noop:already-member' };
        return { routed: 'confirmed', threadId };
      }
      const memberLive = effective(
        fresh.memberIntentStatus,
        fresh.memberIntentExpiresAt,
      );
      return this.activateInTx(tx, {
        threadId,
        command,
        presentation,
        memberId,
        pairId: lockedPairId,
        threadLock,
        persistStatus: 'ACCEPTED',
        promote: memberLive && fresh.memberIntentStatus === 'REQUESTED',
        intent: wireIntent,
        clientUpdates,
        peers,
        routed: memberLive
          ? fresh.memberIntentStatus === 'ACCEPTED'
            ? 'completion'
            : 'activated'
          : 'mismatch',
      });
    }

    // REVOKED
    if (lockedPairId === null) return { routed: 'noop:no-mirror-anchor' };
    const requestStatus =
      fresh.memberIntentStatus === 'REQUESTED'
        ? ('REJECTED' as const)
        : fresh.groupIntentStatus === 'REQUESTED'
          ? ('WITHDRAWN' as const)
          : undefined;
    const requestDirection =
      fresh.memberIntentStatus === 'REQUESTED'
        ? ('OUTGOING' as const)
        : fresh.groupIntentStatus === 'REQUESTED'
          ? ('INCOMING' as const)
          : undefined;
    if (
      !fresh.pairActive &&
      fresh.groupIntentStatus === 'REVOKED' &&
      !effective(fresh.memberIntentStatus, fresh.memberIntentExpiresAt)
    )
      return { routed: 'noop:already-revoked' };
    const wireWrite = await tx.execute<{ status: string }>(
      mirrorMembershipRevocationIntentWrite({
        statusChangedAt: intent.statusChangedAt,
        threadId,
        pairId: lockedPairId,
        presentation,
        memberAccount,
        localMemberId: memberId,
        requestStatus,
        requestDirection,
      }),
    );
    // The guarded RETURNING reports whether this delivery moved the mirrored
    // group direction; a replayed item leaves it untouched.
    const intentChanged = wireWrite.rows.length > 0;
    const result = await tx.execute<{
      pairChanged: boolean;
      epochChanged: boolean;
    }>(
      mirrorMembershipRevocationSql({
        threadId,
        pairId: lockedPairId,
        presentation,
        memberAccount,
        localMemberId: memberId,
      }),
    );
    if (requestStatus && requestDirection) {
      await this.memberMutations.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        { account: memberAccount, namespaceId: 0 },
        requestStatus,
        requestDirection === 'OUTGOING' ? 'APPLICATION' : 'INVITATION',
      );
    }
    const row = result.rows[0]!;
    if (row.pairChanged) {
      await writeMirrorLocalGroupLeftInTx(tx, {
        threadId,
        localMemberId: memberId,
        memberAccount,
        authorityNamespaceId: group.namespaceId,
        threadLock,
      });
      peers.add(group.namespaceId);
      await this.concludeMemberDirectionInTx(
        tx,
        threadId,
        memberId,
        clientUpdates,
        peers,
        requestStatus,
        requestDirection,
      );
      return { routed: 'kick' };
    }
    if (
      !fresh.pairActive &&
      effective(fresh.memberIntentStatus, fresh.memberIntentExpiresAt) &&
      (intentChanged || fresh.groupIntentStatus === 'REVOKED')
    ) {
      // A group revoke concludes the member's pending request or dangling
      // acceptance. The reverse task authors side B REVOKED; an inactive pair
      // has no departure boundary.
      await this.concludeMemberDirectionInTx(
        tx,
        threadId,
        memberId,
        clientUpdates,
        peers,
        requestStatus,
        requestDirection,
      );
      return {
        routed:
          fresh.memberIntentStatus === 'REQUESTED'
            ? 'application-rejected'
            : 'dangling-conclusion',
      };
    }
    return { routed: 'rejected' };
  }

  /** The activation family: persist side A, derive side B, and when the
   * conjunction crosses both-effective, activate. The sync state and the
   * ack-back are the two own-side consequences of a confirmed membership; the
   * mismatch path records the received intent and repairs with the
   * transition-gated system REVOKED write-back instead of throwing. */
  private async activateInTx(
    tx: DatabaseTransaction,
    context: ActivationContext,
  ): Promise<{ routed: MirrorMembershipRouting; threadId?: number }> {
    const { command, presentation, memberId } = context;
    const group = command.group;
    const sideAWrite = await tx.execute<{ status: string }>(
      mirrorMembershipActivationIntentWrite({
        threadId: context.threadId,
        pairId: context.pairId,
        presentation,
        memberAccount: command.memberAccount,
        localMemberId: memberId,
        intent: context.intent,
        persistStatus: context.persistStatus,
      }),
    );
    // The guarded RETURNING reports whether this delivery moved the mirrored
    // group direction; a replayed item leaves it untouched.
    const intentChanged = sideAWrite.rows.length > 0;
    if (context.promote)
      await tx.execute(
        relationshipIntentPromotionSql({
          author: { account: command.memberAccount, namespaceId: 0 },
          receiver: {
            account: group.account,
            namespaceId: group.namespaceId,
          },
        }),
      );
    const activation = await tx.execute<{
      pairChanged: boolean;
      activated: boolean;
    }>(
      mirrorMembershipActivationSql({
        threadId: context.threadId,
        pairId: context.pairId,
        presentation,
        memberAccount: command.memberAccount,
        localMemberId: memberId,
        intent: context.intent,
        persistStatus: context.persistStatus,
      }),
    );
    const row = activation.rows[0]!;
    if (!row.activated) {
      if (intentChanged) {
        // Mismatch: the received ACK cannot be honored. Record it, repair with
        // the system REVOKED write-back, never throw — the stream must advance.
        await this.concludeMemberDirectionInTx(
          tx,
          context.threadId,
          memberId,
          context.clientUpdates,
          context.peers,
        );
        return { routed: 'mismatch' };
      }
      return { routed: `noop:${context.routed}` };
    }
    if (row.pairChanged) {
      context.clientUpdates.push(
        ...(await captureThreadStateUpdatesInTx(tx, [memberId])),
      );
    }
    await initializeRelationshipThreadStateInTx(
      tx,
      context.threadId,
      context.pairId,
      context.threadLock,
    );
    const confirmed =
      await this.memberMutations.writeMemberRelationshipIntentInTx(
        tx,
        context.threadId,
        memberId,
        'ACCEPTED',
        context.clientUpdates,
      );
    for (const domain of confirmed.keys()) context.peers.add(domain);
    context.peers.add(group.namespaceId);
    await this.memberMutations.writeGroupRequestEffectsInTx(
      tx,
      context.threadId,
      { account: command.memberAccount, namespaceId: 0 },
      'ACCEPTED',
      context.promote ? 'APPLICATION' : 'INVITATION',
    );
    return { routed: context.routed, threadId: context.threadId };
  }

  private async concludeMemberDirectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    clientUpdates: PendingClientStateFeedUpdate[],
    peers: Set<number>,
    requestStatus?: 'WITHDRAWN' | 'REJECTED',
    requestDirection?: 'INCOMING' | 'OUTGOING',
  ): Promise<void> {
    const allocated =
      await this.memberMutations.writeMemberRelationshipIntentInTx(
        tx,
        threadId,
        memberUserId,
        'REVOKED',
        clientUpdates,
        '',
        {
          clientRequestStatus: requestStatus,
          clientRequestDirection: requestDirection,
        },
      );
    for (const peerDomain of allocated.keys()) peers.add(peerDomain);
  }

  private mintPair(
    tx: DatabaseTransaction,
    threadId: number,
    group: MirrorGroupMembershipIntentCommand['group'],
    memberAccount: string,
  ): Promise<bigint> {
    return mintGroupMemberPairInTx(tx, {
      threadId,
      groupAccount: group.account,
      groupNamespaceId: group.namespaceId,
      memberAccount,
      profileNamespaceId: 0,
    });
  }

  private async readStateInTx(
    tx: DatabaseTransaction,
    input: {
      threadId: number;
      groupAccount: string;
      groupNamespaceId: number;
      memberAccount: string;
    },
  ): Promise<MirrorMembershipStateRow> {
    const result = await tx.execute<MirrorMembershipStateRow>(
      mirrorMembershipStateSql(input),
    );
    const row = result.rows[0];
    if (!row) throw new Error('mirror group thread disappeared');
    return row;
  }
}
