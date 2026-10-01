import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { relationshipPair } from '../../database/schema.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../database/database.service.js';
import type { NamespacedAddress } from '../../common/client-identity.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../../user/account-address.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import { lockRelationshipPairsInTx } from '../../common/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../common/locks/business-address.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../common/locks/thread-content-lock.js';
import { lockAccountFeedAllocatorsInTx } from '../../common/locks/account-feed-allocator-lock.js';
import { captureThreadStateUpdatesInTx } from '../../client-state-feed/capture-thread-state-updates.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../client-state-feed/client-state-feed.service.js';
import type { FederationService } from '../../federation/federation.service.js';
import type { PeerStateFeedService } from '../../federation/peer-state-feed.service.js';
import {
  groupMembershipStateSql,
  type GroupMembershipStateRow,
} from '../membership-intent/shared/group-membership-state-sql.js';
import { lockGroupMemberIntentRowsInTx } from '../membership-intent/shared/group-member-intent-lock.js';
import {
  groupDisbandMembershipRevocationLocatorSql,
  groupDisbandMembershipRevocationSql,
  type GroupDisbandMembershipRevocationInput,
} from './group-disband-membership-revocation-sql.js';

/** One command: the disband sweep's per-member departure. The DISBAND_GROUP
 * task commits the terminal group fact plus its single GROUP_DISSOLVED message
 * and its cursor fans out one FORCE_REVOKE_GROUP_MEMBER child per membership
 * pair — active or pending alike; this service is what a child executes. The
 * member arrives as the sweep's task payload — a local Account.id or a
 * wire-level address; the caller is the system, the dissolved group itself is
 * the authority, so there is no manager or role gate. The child is silent:
 * no departure message, watermark, or thread fan-out. */
export interface GroupDisbandMembershipRevocationCommand {
  threadId: number;
  memberAddress: AccountTarget;
}

export interface GroupDisbandMembershipRevocationDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationService;
}

export type GroupDisbandMembershipRevocationResult =
  | { status: 'APPLIED'; transitioned: true }
  | {
      status: 'NO_OP';
      reason: 'GROUP_NOT_FOUND' | 'PAIR_NOT_FOUND' | 'ALREADY_REVOKED';
      transitioned: false;
    };

/** Lexical capability, created only after locks and authorization. */
interface ValidatedRevocation {
  readonly tx: DatabaseTransaction;
  readonly threadLock: ThreadContentLock;
  readonly pairId: bigint;
  readonly localMemberId: number | null;
  readonly input: GroupDisbandMembershipRevocationInput;
}

@Injectable()
export class GroupDisbandMembershipRevocationService {
  private readonly logger = new Logger(
    GroupDisbandMembershipRevocationService.name,
  );

  constructor(
    private readonly deps: GroupDisbandMembershipRevocationDependencies,
  ) {}

  async execute(
    params: GroupDisbandMembershipRevocationCommand,
  ): Promise<GroupDisbandMembershipRevocationResult> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if ('status' in context) return context;
      return {
        status: 'APPLIED' as const,
        transitioned: true as const,
        peers: await this.applyInTx(context, clientUpdates),
      };
    });
    if (!('peers' in peers)) return peers;
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('dissolve revocation client-state wake failed', error);
    }
    if (peers.peers.size === 0)
      return { status: 'APPLIED', transitioned: true };
    // The wake hint is keyed by the publisher namespace; the peer domain is
    // resolved at send time from the namespace binding.
    this.deps.federation.pushStateFeedNamespaces(peers.peers);
    return { status: 'APPLIED', transitioned: true };
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupDisbandMembershipRevocationCommand,
  ): Promise<ValidatedRevocation | GroupDisbandMembershipRevocationResult> {
    // The sweep's payload names the member as a local Account.id or an
    // address; every downstream statement uses the canonical address form.
    const member: NamespacedAddress = await accountAddressInTx(
      tx,
      params.memberAddress,
    );
    // One pre-lock locator: the group's address and, when it exists, the
    // member's pair name the business scopes. It authorizes nothing; every
    // mutable state is re-read after the locks it names. The gates evaluate
    // group existence, dissolution, and then member state.
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
        pairId: string | null;
        localMemberId: number | null;
      }>(
        groupDisbandMembershipRevocationLocatorSql({
          threadId: params.threadId,
          member,
        }),
      )
    ).rows[0];
    if (!located)
      return {
        status: 'NO_OP',
        reason: 'GROUP_NOT_FOUND',
        transitioned: false,
      };
    await lockBusinessAccountsInTx(tx, [
      { account: located.groupAccount, domain: located.groupDomain },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(located.groupAccount, located.groupDomain),
          completeBusinessAddress(member.account, member.domain),
        ],
      },
    ]);
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.threadId,
      params.threadId,
    );
    // The locator above only names advisory scopes. Re-read the dissolution and
    // pair coordinates after both business locks and the group thread row lock.
    const current = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
        pairId: string | null;
        localMemberId: number | null;
      }>(
        groupDisbandMembershipRevocationLocatorSql({
          threadId: params.threadId,
          member,
        }),
      )
    ).rows[0];
    if (
      !current ||
      current.groupAccount !== located.groupAccount ||
      current.groupDomain !== located.groupDomain
    )
      throw new Error('group identity changed while acquiring business locks');
    if (!current.dissolvedAt)
      throw new Error('group member fan-out requires a dissolved group');
    if (!current.pairId) {
      // The full sweep only addresses pairs that exist; a pair gone between
      // cursor and child means there is nothing left to revoke.
      return {
        status: 'NO_OP',
        reason: 'PAIR_NOT_FOUND',
        transitioned: false,
      };
    }
    const pairId = BigInt(current.pairId);
    const [lockedPair] = await tx
      .select()
      .from(relationshipPair)
      .where(eq(relationshipPair.id, pairId))
      .for('no key update');
    if (!lockedPair) throw new Error('disband revocation pair not found');
    if (lockedPair.threadId !== params.threadId)
      throw new Error('disband revocation pair changed');
    const groupEndpoint =
      lockedPair.endpointAType === 'GROUP'
        ? {
            account: lockedPair.endpointAAccount,
            namespaceId: lockedPair.endpointANamespaceId,
          }
        : {
            account: lockedPair.endpointBAccount,
            namespaceId: lockedPair.endpointBNamespaceId,
          };
    const memberEndpoint =
      lockedPair.endpointAType === 'GROUP'
        ? {
            account: lockedPair.endpointBAccount,
            namespaceId: lockedPair.endpointBNamespaceId,
          }
        : {
            account: lockedPair.endpointAAccount,
            namespaceId: lockedPair.endpointANamespaceId,
          };
    await lockGroupMemberIntentRowsInTx(tx, groupEndpoint, memberEndpoint);
    // The membership authorization binds `authorized` to a calling member
    // account; a system caller has none, so the bind is a constant and the
    // column goes unconsumed. Everything else the composed statement needs —
    // the group profile snapshot, both intent states, the manager set, and the
    // member's live projection directions — is the same post-lock read the
    // member-side commands take.
    const row = (
      await tx.execute<GroupMembershipStateRow>(
        groupMembershipStateSql({
          threadId: params.threadId,
          pairId,
          actorUserId: null,
          groupAccount: groupEndpoint.account,
          groupNamespaceId: groupEndpoint.namespaceId,
          memberAccount: member.account,
          profileNamespaceId: member.namespaceId,
        }),
      )
    ).rows[0];
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('disband revocation requires an authoritative group');
    // A side B intent already at REVOKED is the idempotent no-op; a missing
    // intent row still departs.
    if (row.memberIntentStatus === 'REVOKED')
      return {
        status: 'NO_OP',
        reason: 'ALREADY_REVOKED',
        transitioned: false,
      };
    if (row.profileNamespaceId !== 0)
      await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        {
          namespaceId: row.profileNamespaceId,
        },
      ]);
    // This child writes only the departing local member's client feed. Manager
    // request projections allocate no manager-owned feed positions, so locking
    // every current manager would only widen contention during the sweep.
    if (row.localMemberId !== null)
      await lockAccountFeedAllocatorsInTx(tx, [row.localMemberId]);
    return {
      tx,
      threadLock,
      pairId,
      localMemberId: row.localMemberId,
      input: {
        threadId: params.threadId,
        pairId,
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        memberAccount: member.account,
        profileNamespaceId: row.profileNamespaceId,
        localMemberId: row.localMemberId,
        projectionDirections: row.projectionDirections,
      },
    };
  }

  private async applyInTx(
    context: ValidatedRevocation,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Set<number>> {
    const result = await context.tx.execute<{
      intentChanged: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      recipientUserId: number | null;
      recipientFeedId: string | null;
    }>(groupDisbandMembershipRevocationSql(context.input));
    const row = result.rows[0];
    if (!row) throw new Error('disband revocation update disappeared');
    if (row.recipientUserId !== null && row.recipientFeedId !== null)
      clientUpdates.push({
        userId: row.recipientUserId,
        feedId: Number(row.recipientFeedId),
      });
    if (row.pairChanged && context.localMemberId !== null)
      clientUpdates.push(
        ...(await captureThreadStateUpdatesInTx(context.tx, [
          context.localMemberId,
        ])),
      );
    // Only a remote member leaves a peer feed to notify; the publisher
    // namespace is the wake key.
    const peers = new Set<number>();
    if (context.input.profileNamespaceId !== 0)
      peers.add(context.input.profileNamespaceId);
    return peers;
  }
}
