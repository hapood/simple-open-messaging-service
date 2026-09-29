import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationService } from '../../../federation/federation.service.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import type { GroupRelationshipMutationService } from '../shared/group-relationship-mutation.service.js';
import { normalizeAccount } from '../../../common/account.js';
import { SERVER_MAX_GROUP_MEMBERS } from '../../shared/group-capacity.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  groupAuthoredMembershipInvitationAuthorizationSql,
  groupAuthoredMembershipTargetLocatorSql,
  type GroupMembershipAuthorizationRow,
} from '../authored/group-authored-membership-authorization-sql.js';
import { memberAuthoredMembershipRequestSql } from '../authored/member-authored-membership-request-sql.js';
import {
  groupMembershipAcceptanceSql,
  type GroupMembershipAcceptanceInput,
} from '../shared/group-membership-acceptance-sql.js';
import {
  groupMembershipRevocationSql,
  type GroupMembershipRevocationInput,
} from '../shared/group-membership-revocation-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from '../shared/group-membership-projection-fanout.js';
import { mintGroupMemberPairInTx } from '../shared/group-member-pair-mint.js';
import { lockGroupMemberIntentRowsInTx } from '../shared/group-member-intent-lock.js';
import {
  InvalidReceivedIntentError,
  validateReceivedIntentBody,
} from './received-membership-body.js';
import { mirrorIntentWriteSql } from './mirror-membership-shared-sql.js';
import type { RelationshipIntentStatus } from '../../../common/relationship-intent-state.js';

/** A member-authored RELATIONSHIP_INTENT body as it arrives on the state feed
 * (times are epoch milliseconds). Positive statuses carry the member's thread
 * heads; REVOKED carries none. */
interface RemoteMemberMembershipIntentBody {
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  profileNamespaceId: number;
  profileRev: number;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  messageEndSeq?: number;
  tombstoneEndSeq?: number;
}

/** One command: apply a received member-authored intent to this server's
 * authoritative group inside the State Feed consumer transaction. */
export interface RemoteMemberMembershipIntentCommand {
  threadId: number;
  member: { account: string; domain: string; namespaceId: number };
  body: RemoteMemberMembershipIntentBody;
}

export interface RemoteMemberMembershipIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: Pick<FederationService, 'pushStateFeedDomains'>;
  relationshipMutations: GroupRelationshipMutationService;
}

/** Routing outcomes, for tests and diagnostics. `noop:*` rows never wrote. */
export type RemoteMemberMembershipRouting =
  | 'recorded-request'
  | 'refreshed-request'
  | 'activated'
  | 'completion'
  | 'mismatch'
  | 'departure'
  | 'rejection'
  | `noop:${string}`;

export interface RemoteMemberMembershipIntentResult {
  routed: RemoteMemberMembershipRouting;
  /** The member's peer feed position, for the consumer's post-commit push. */
  peerFeedId?: bigint;
}

/** The origin-side counterpart of the group intent family: a remote member's
 * authored intent arrives as a group-keyed RELATIONSHIP_INTENT state-feed item
 * and is applied to this server's authoritative group with the same composed
 * statements — the wireIntent snapshot substituted for the authored side-B write
 * (the `authoredSql`/`memberAuthoredSql` seams), and no manager authorization,
 * because the consume rules are the authorization: a recorded application
 * waits for a local manager, while a cross of two live directions completes
 * the membership by system proxy. Relationship truth and the membership system
 * messages stay local: the origin mints GROUP_JOINED/GROUP_LEFT itself. */
export class RemoteMemberMembershipIntentService {
  private readonly logger = new Logger(
    RemoteMemberMembershipIntentService.name,
  );

  constructor(
    private readonly deps: RemoteMemberMembershipIntentDependencies,
  ) {}

  async execute(
    command: RemoteMemberMembershipIntentCommand,
  ): Promise<{ routed: RemoteMemberMembershipRouting }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = new Set<string>();
    const result = await this.deps.database.db.transaction(async (tx) =>
      this.applyInTx(tx, command, clientUpdates, peers),
    );
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('remote member intent client wake failed', error);
    }
    if (peers.size > 0)
      void this.deps.federation
        .pushStateFeedDomains(peers)
        .catch((error: unknown) =>
          this.logger.warn(
            'remote member intent state-feed wake failed',
            error,
          ),
        );
    return { routed: result.routed };
  }

  /** Transactional entry: the caller owns commit and therefore also owns the
   * post-commit client/peer wakes handed back through the sinks. */
  async applyInTx(
    tx: DatabaseTransaction,
    command: RemoteMemberMembershipIntentCommand,
    clientUpdates: PendingClientStateFeedUpdate[],
    peers: Set<string>,
  ): Promise<RemoteMemberMembershipIntentResult> {
    const validated = validateReceivedIntentBody(command.body);
    if (!validated) return { routed: 'noop:expired-request' };
    const intent = {
      status: command.body.status,
      ...validated,
    };
    const memberAccount = normalizeAccount(command.member.account);
    const memberDomain = command.member.domain.trim().toLowerCase();
    const member: {
      account: string;
      domain: string;
      namespaceId: number;
    } = {
      account: memberAccount,
      domain: memberDomain,
      namespaceId: command.member.namespaceId,
    };
    // Pre-lock locator: names the group's business scope and lets a dissolved
    // group decline every positive intent before any write (no pair is minted
    // for it — the authored invitation's early-return precedent).
    const group = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
      }>(
        groupAuthoredMembershipTargetLocatorSql({ threadId: command.threadId }),
      )
    ).rows[0];
    if (!group)
      throw new InvalidReceivedIntentError(
        'group relationship has no local group placeholder',
      );
    if (group.dissolvedAt && intent.status !== 'REVOKED')
      return { routed: 'noop:dissolved' };
    // The group ACCOUNT scope at the authority (local) domain, before the
    // Pair scope, once per transaction.
    await lockBusinessAccountsInTx(tx, [
      { account: group.groupAccount, domain: group.groupDomain },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(group.groupAccount, group.groupDomain),
          completeBusinessAddress(member.account, member.domain),
        ],
      },
    ]);
    // An ACK or REVOKE for a pair this server never minted is inert: there is
    // no invitation or membership to conclude, while the cursor advances.
    const existing = (
      await tx.execute<{
        id: string;
        threadId: number | null;
        active: boolean;
      }>(
        sql`
          SELECT id::text AS id, "threadId", active
          FROM "RelationshipPair"
          WHERE kind = 'GROUP_MEMBER'
            AND "endpointAType" = 'GROUP'
            AND "endpointAAccount" = ${group.groupAccount}
            AND "endpointBType" = 'USER'
            AND "endpointBAccount" = ${member.account}
            AND "endpointBNamespaceId" = ${member.namespaceId}
          LIMIT 1
        `,
      )
    ).rows[0];
    if (!existing && intent.status !== 'REQUESTED')
      return { routed: 'noop:no-anchor' };
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      command.threadId,
      command.threadId,
    );
    const pairId =
      existing === undefined
        ? await mintGroupMemberPairInTx(tx, {
            threadId: command.threadId,
            groupAccount: group.groupAccount,
            groupNamespaceId: 0,
            memberAccount: member.account,
            memberNamespaceId: member.namespaceId,
          })
        : await this.lockExistingPairInTx(tx, existing, command.threadId);
    await lockGroupMemberIntentRowsInTx(
      tx,
      { account: group.groupAccount, namespaceId: 0 },
      member,
    );
    // One statement both creates the group allocator row and takes its row
    // lock, keeping the allocator-before-Account ordering without a second
    // round trip. Every routed branch allocates: an application advances the
    // projection counter, an acceptance writes meta facts, a revocation the
    // departure fact.
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${command.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    // Post-lock state read. The invitation authorization variant names the
    // member by address (their side B row may legitimately not exist); the
    // manager-gated columns are ignored by this applier.
    const row = (
      await tx.execute<GroupMembershipAuthorizationRow & { pairId: string }>(
        groupAuthoredMembershipInvitationAuthorizationSql({
          threadId: command.threadId,
          pairId,
          managerUserId: 0,
          targetAccount: member.account,
          targetDomain: member.domain,
          targetNamespaceId: member.namespaceId,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('remote member authorization disappeared');
    // The member's outbound allocator precedes every client-feed allocation.
    await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
      { peerDomain: member.domain, namespaceId: member.namespaceId },
    ]);
    const accounts = [...row.managerIds];
    if (row.localMemberId !== null) accounts.push(row.localMemberId);
    if (accounts.length > 0)
      await tx.execute(
        sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(accounts)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
      );
    if (intent.status === 'ACCEPTED')
      await tx.execute(
        sql`SELECT "threadId" FROM "FederationThreadSyncState" WHERE "threadId" = ${command.threadId} AND "namespaceId" = ${member.namespaceId} FOR NO KEY UPDATE`,
      );

    const wireIntent = {
      profileNamespaceId: command.body.profileNamespaceId,
      profileRev: command.body.profileRev,
      note: command.body.note ?? '',
      messageEndSeq: command.body.messageEndSeq ?? 0,
      tombstoneEndSeq: command.body.tombstoneEndSeq ?? 0,
    };
    if (intent.status === 'REQUESTED') {
      if (intent.requestedAt === null || intent.expiresAt === null)
        throw new InvalidReceivedIntentError(
          'invalid relationship request timestamps',
        );
      return this.routeRequestInTx(tx, {
        command,
        intent: {
          status: 'REQUESTED',
          requestedAt: intent.requestedAt,
          expiresAt: intent.expiresAt,
        },
        wireIntent,
        pairId,
        threadId: command.threadId,
        threadLock,
        group,
        member,
        row,
        clientUpdates,
        peers,
      });
    }
    if (intent.status === 'ACCEPTED')
      return this.routeAcceptanceInTx(tx, {
        command,
        wireIntent,
        pairId,
        threadId: command.threadId,
        threadLock,
        group,
        member,
        row,
        clientUpdates,
        peers,
      });
    return this.applyRevocationInTx(tx, {
      wireIntent,
      pairId,
      threadId: command.threadId,
      group,
      member,
      row,
      clientUpdates,
      peers,
    });
  }

  /** Re-read the mutable coordinates of the located pair under its row lock:
   * the locator only named advisory scopes. */
  private async lockExistingPairInTx(
    tx: DatabaseTransaction,
    existing: { id: string; threadId: number | null; active: boolean },
    threadId: number,
  ): Promise<bigint> {
    const [locked] = await tx
      .select({
        id: sql<string>`id::text`,
        threadId: sql<number | null>`"threadId"`,
      })
      .from(sql`"RelationshipPair"`)
      .where(sql`id = ${BigInt(existing.id)}`)
      .for('no key update')
      .limit(1);
    if (!locked) throw new Error('membership pair lock disappeared');
    if (locked.threadId !== threadId)
      throw new Error('membership pair changed while acquiring locks');
    return BigInt(locked.id);
  }

  /** The member's application. A live group-side direction (our outstanding
   * invitation, or a retained group acceptance) or their own live direction
   * crosses both-effective — the collapse completes the membership by system
   * proxy. Everything else is recorded for the managers and waits. */
  private async routeRequestInTx(
    tx: DatabaseTransaction,
    context: {
      command: RemoteMemberMembershipIntentCommand;
      intent: { status: 'REQUESTED'; requestedAt: Date; expiresAt: Date };
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      group: { groupAccount: string; groupDomain: string };
      member: { account: string; domain: string; namespaceId: number };
      row: GroupMembershipAuthorizationRow & { pairId: string };
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<string>;
    },
  ): Promise<RemoteMemberMembershipIntentResult> {
    const collapse =
      (context.row.groupIntentStatus === 'REQUESTED' &&
        context.row.groupIntentExpiresAt !== null &&
        new Date(context.row.groupIntentExpiresAt).getTime() > Date.now()) ||
      context.row.groupIntentStatus === 'ACCEPTED' ||
      context.row.memberIntentEffective === true;
    if (collapse && !this.capacityFull(context.row))
      return this.activateInTx(tx, context);
    // Capacity-full applications stay applications, and a fresh or refreshed
    // application is recorded for the managers: the projection fan-out task
    // carries the per-manager wake. The remote applicant has no local feed
    // row and no wake of their own.
    const result = await tx.execute<{
      intentChanged: boolean;
      projectionChanged: boolean;
    }>(
      memberAuthoredMembershipRequestSql({
        threadId: context.command.threadId,
        pairId: context.pairId,
        groupAccount: context.group.groupAccount,
        groupName: context.row.name,
        groupAvatar: context.row.avatar,
        groupDescription: context.row.description,
        groupProfileRev: context.row.profileRev,
        localDomain: 'local',
        memberAccount: context.member.account,
        memberDomain: context.member.domain,
        memberNamespaceId: context.member.namespaceId,
        localMemberId: null,
        note: context.wireIntent.note,
        requestedAt: context.intent.requestedAt,
        expiresAt: context.intent.expiresAt,
        authoredSql: this.memberWireWriteSql(
          'REQUESTED',
          context.wireIntent,
          context.intent.requestedAt,
          context.intent.expiresAt,
          {
            member: context.member,
            group: { account: context.group.groupAccount, namespaceId: 0 },
          },
        ),
      }),
    );
    const row = result.rows[0];
    if (!row) throw new Error('remote member application update disappeared');
    if (row.projectionChanged)
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId: context.command.threadId,
        groupAccount: context.group.groupAccount,
      });
    return {
      routed:
        context.row.memberIntentStatus === null
          ? 'recorded-request'
          : 'refreshed-request',
    };
  }

  /** The member's ACK. Against a live group-side invitation (or a completed
   * group acceptance) it completes the membership; otherwise the acknowledgment
   * cannot be honored — it is recorded and repaired with the transition-gated
   * system group REVOKED write-back, never thrown, so the stream advances. */
  private async routeAcceptanceInTx(
    tx: DatabaseTransaction,
    context: {
      command: RemoteMemberMembershipIntentCommand;
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      group: { groupAccount: string; groupDomain: string };
      member: { account: string; domain: string; namespaceId: number };
      row: GroupMembershipAuthorizationRow & { pairId: string };
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<string>;
    },
  ): Promise<RemoteMemberMembershipIntentResult> {
    const live =
      (context.row.groupIntentStatus === 'REQUESTED' &&
        context.row.groupIntentExpiresAt !== null &&
        new Date(context.row.groupIntentExpiresAt).getTime() > Date.now()) ||
      context.row.groupIntentStatus === 'ACCEPTED';
    if (
      !context.row.pairActive &&
      context.row.groupIntentStatus === 'REVOKED'
    ) {
      // Retain the member's late ACK without reauthoring the group's revoke.
      await this.recordMismatchInTx(tx, {
        command: context.command,
        wireIntent: context.wireIntent,
        member: context.member,
        group: context.group,
      });
      return { routed: 'noop:dropped-ack' };
    }
    // A pair-active member's replayed ACK honors the live group direction: the
    // acceptance statement below is a no-op for them (no Meta coordinate, no
    // message). Treating membership itself as unhonorable here used to conclude
    // the group's own ACCEPTED as REVOKED and kick the member.
    if (!live || this.capacityFull(context.row)) {
      const changed = await this.recordMismatchInTx(tx, {
        command: context.command,
        wireIntent: context.wireIntent,
        member: context.member,
        group: context.group,
      });
      if (!changed) return { routed: 'noop:mismatch-replayed' };
      await this.concludeGroupDirectionInTx(tx, context);
      return { routed: 'mismatch' };
    }
    return this.activateInTx(tx, context);
  }

  /** The membership completes: the member's side is persisted from the wireIntent
   * snapshot, the group's side is authored by system proxy, and the composed
   * statement minting the roster fact, the GROUP_JOINED message, the fan-out
   * admissions, and the member's synchronization state runs with the local
   * authority this server holds over its own group. */
  private async activateInTx(
    tx: DatabaseTransaction,
    context: {
      command: RemoteMemberMembershipIntentCommand;
      intent?: { status: 'REQUESTED'; requestedAt: Date; expiresAt: Date };
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      group: { groupAccount: string; groupDomain: string };
      member: { account: string; domain: string; namespaceId: number };
      row: GroupMembershipAuthorizationRow & { pairId: string };
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<string>;
    },
  ): Promise<RemoteMemberMembershipIntentResult> {
    const { command, wireIntent, pairId, threadId, member } = context;
    const input: GroupMembershipAcceptanceInput = {
      pairId,
      threadId,
      groupAccount: context.group.groupAccount,
      groupProfileRev: context.row.profileRev,
      groupName: context.row.name,
      groupAvatar: context.row.avatar,
      groupDescription: context.row.description,
      localDomain: 'local',
      memberAccount: member.account,
      memberDomain: member.domain,
      memberNamespaceId: member.namespaceId,
      // The group's own invitation note survives the completion, exactly like
      // the authored collapse.
      note: context.row.groupIntentNote ?? '',
      acceptedAt: new Date(),
      projectionDirections: context.row.projectionDirections,
      memberAck: true,
      memberAuthoredSql: this.memberWireWriteSql(
        'ACCEPTED',
        wireIntent,
        command.body.requestedAt === null
          ? null
          : new Date(command.body.requestedAt),
        null,
        {
          member,
          group: { account: context.group.groupAccount, namespaceId: 0 },
        },
      ),
    };
    const result = await tx.execute<{
      canonicalRosterChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      recipientFeedId: string | null;
      recipientUserId: number | null;
      invalidPeerHead: boolean;
    }>(groupMembershipAcceptanceSql(input));
    const row = result.rows[0];
    if (!row) throw new Error('remote member acceptance update disappeared');
    if (row.invalidPeerHead) throw new Error('conflicting peer content head');
    const peers = context.peers;
    if (row.recipientFeedId !== null) peers.add(member.domain);
    return {
      routed:
        context.row.groupIntentStatus === 'REQUESTED'
          ? 'activated'
          : 'completion',
      peerFeedId:
        row.recipientFeedId === null ? undefined : BigInt(row.recipientFeedId),
    };
  }

  /** The member's REVOKE: a leave, an invitation decline, or an application
   * withdrawal. The composed statement mirrors side B from the wireIntent snapshot
   * and gates departure effects on the pair's active transition. A still-positive
   * group-owned side A is concluded by its separate authored writer. */
  private async applyRevocationInTx(
    tx: DatabaseTransaction,
    context: {
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      group: { groupAccount: string; groupDomain: string };
      member: { account: string; domain: string; namespaceId: number };
      row: GroupMembershipAuthorizationRow & { pairId: string };
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<string>;
    },
  ): Promise<RemoteMemberMembershipIntentResult> {
    const { wireIntent, pairId, threadId, member } = context;
    const input: GroupMembershipRevocationInput = {
      threadId,
      pairId,
      groupAccount: context.group.groupAccount,
      groupName: context.row.name,
      groupAvatar: context.row.avatar,
      groupDescription: context.row.description,
      groupProfileRev: context.row.profileRev,
      localDomain: 'local',
      memberAccount: member.account,
      memberDomain: member.domain,
      memberNamespaceId: member.namespaceId,
      localMemberId: null,
      projectionDirections: context.row.projectionDirections,
      author: {
        account: member.account,
        namespaceId: member.namespaceId,
      },
      receiver: { account: context.group.groupAccount, namespaceId: 0 },
      authoredSql: this.memberWireWriteSql('REVOKED', wireIntent, null, null, {
        member,
        group: { account: context.group.groupAccount, namespaceId: 0 },
      }),
    };
    const result = await tx.execute<{
      intentChanged: boolean;
      pairChanged: boolean;
      departed: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      recipientFeedId: string | null;
    }>(groupMembershipRevocationSql(input));
    const row = result.rows[0];
    if (!row) throw new Error('remote member revocation update disappeared');
    const peers = context.peers;
    if (row.recipientFeedId !== null) peers.add(member.domain);
    const groupDirectionEffective =
      context.row.groupIntentStatus === 'ACCEPTED' ||
      (context.row.groupIntentStatus === 'REQUESTED' &&
        context.row.groupIntentExpiresAt !== null &&
        new Date(context.row.groupIntentExpiresAt).getTime() > Date.now());
    if (row.pairChanged || (row.intentChanged && groupDirectionEffective)) {
      // The member's revoke concludes a still-positive group direction even
      // when the pair was only pending; departure effects require pairChanged.
      await this.concludeGroupDirectionInTx(tx, context);
    }
    return {
      routed: row.pairChanged ? 'departure' : 'rejection',
      peerFeedId:
        row.recipientFeedId === null ? undefined : BigInt(row.recipientFeedId),
    };
  }

  private async concludeGroupDirectionInTx(
    tx: DatabaseTransaction,
    context: {
      threadId: number;
      member: { account: string; domain: string; namespaceId: number };
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<string>;
    },
  ): Promise<void> {
    const allocated =
      await this.deps.relationshipMutations.writeGroupRelationshipIntentInTx(
        tx,
        context.threadId,
        context.member,
        '',
        'REVOKED',
        context.clientUpdates,
      );
    for (const peerDomain of allocated.keys()) context.peers.add(peerDomain);
  }

  /** An ACK this group cannot honor: persist the member's snapshot and repair
   * with the system REVOKED write-back, enqueued only on a real transition so
   * replayed items never enqueue twice. */
  private async recordMismatchInTx(
    tx: DatabaseTransaction,
    context: {
      command: RemoteMemberMembershipIntentCommand;
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      member: { account: string; domain: string; namespaceId: number };
      group: { groupAccount: string; groupDomain: string };
    },
  ): Promise<boolean> {
    const result = await tx.execute(
      this.memberWireWriteSql(
        'ACCEPTED',
        context.wireIntent,
        context.command.body.requestedAt === null
          ? null
          : new Date(context.command.body.requestedAt),
        null,
        {
          member: context.member,
          group: { account: context.group.groupAccount, namespaceId: 0 },
        },
      ),
    );
    return result.rows.length > 0;
  }

  /** The wireIntent snapshot writer for the member's authored direction: the
   * data coordinates are bound parameters taken from the item body, never
   * derived locally, while the address is the pair's member→group direction. */
  private memberWireWriteSql(
    status: RelationshipIntentStatus,
    wireIntent: {
      profileNamespaceId: number;
      profileRev: number;
      note: string;
      messageEndSeq: number;
      tombstoneEndSeq: number;
    },
    requestedAt: Date | null,
    expiresAt: Date | null,
    endpoints: {
      member: { account: string; namespaceId: number };
      group: { account: string; namespaceId: number };
    },
  ) {
    return mirrorIntentWriteSql({
      author: endpoints.member,
      receiver: endpoints.group,
      status,
      note: wireIntent.note,
      requestedAt,
      expiresAt,
      profileNamespaceId: wireIntent.profileNamespaceId,
      profileRev: wireIntent.profileRev,
      messageEndSeq: wireIntent.messageEndSeq,
      tombstoneEndSeq: wireIntent.tombstoneEndSeq,
    });
  }

  /** The capacity gate: activation growth only; a pair already inside the
   * capacity set keeps its reserved slot. */
  private capacityFull(row: GroupMembershipAuthorizationRow): boolean {
    return (
      !row.alreadyAuthorized && row.authorizedCount >= SERVER_MAX_GROUP_MEMBERS
    );
  }
}
