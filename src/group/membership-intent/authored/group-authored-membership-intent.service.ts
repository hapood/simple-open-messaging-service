import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  groupMembershipAcceptanceSql,
  type GroupMembershipAcceptanceInput,
} from '../shared/group-membership-acceptance-sql.js';
import {
  groupAuthoredMembershipAddressLocatorSql,
  groupAuthoredMembershipInvitationAuthorizationSql,
  groupAuthoredMembershipTargetLocatorSql,
  groupAuthoredInvitationLocatorSql,
  type GroupMembershipAuthorizationRow,
} from './group-authored-membership-authorization-sql.js';
import {
  groupMembershipRevocationSql,
  type GroupMembershipRevocationInput,
} from '../shared/group-membership-revocation-sql.js';
import {
  groupAuthoredMembershipRequestSql,
  type GroupAuthoredMembershipRequestInput,
} from './group-authored-membership-request-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from '../shared/group-membership-projection-fanout.js';
import { mintGroupMemberPairInTx } from '../shared/group-member-pair-mint.js';
import { lockGroupMemberIntentRowsInTx } from '../shared/group-member-intent-lock.js';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { GroupRole } from '../../../database/enums.js';
import { BusinessCode } from '../../../common/business-code.js';
import {
  type BusinessRejection,
  rejectBusinessCommand,
} from '../../../common/business-command-result.js';
import { normalizeAccount } from '../../../common/account.js';
import { SERVER_MAX_GROUP_MEMBERS } from '../../shared/group-capacity.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import { relationshipPair } from '../../../database/schema.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationService } from '../../../federation/federation.service.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../../common/relationship-intent-state.js';
import type { GroupRelationshipMutationService } from '../shared/group-relationship-mutation.service.js';

/** One command family: the group's authored intent about one addressed member. */
export type GroupAuthoredMembershipIntentCommand =
  | {
      threadId: number;
      managerUserId: number;
      decision: 'REQUESTED';
      target: { account: string; domain: string };
      note?: string;
    }
  | {
      threadId: number;
      managerUserId: number;
      decision: 'ACCEPTED';
      target: { account: string; domain: string };
      scope: 'APPLICATION' | 'INVITATION';
      note?: never;
    }
  | {
      threadId: number;
      managerUserId: number;
      decision: 'REVOKED';
      target: { account: string; domain: string };
      scope: 'APPLICATION' | 'INVITATION' | 'MEMBER';
      note?: never;
    };

export interface GroupAuthoredMembershipIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationService;
  relationshipMutations: GroupRelationshipMutationService;
}

export type GroupAuthoredMembershipIntentResult =
  | { status: 'APPLIED' }
  | {
      status: 'NO_OP';
      reason: 'ALREADY_MEMBER' | 'ALREADY_REVOKED' | 'ALREADY_SATISFIED';
    }
  | BusinessRejection;

export type QueryDeniedMembershipRevocationResult =
  | { status: 'APPLIED' }
  | { status: 'NO_OP'; reason: 'STALE_OR_ALREADY_REVOKED' };

type Applicant = {
  account: string;
  domain: string;
  namespaceId: number;
};

const validated = Symbol('validated group join decision');

/** Privilege rank — LOWER is more privileged (OWNER outranks ADMIN outranks MEMBER). */
function roleRank(role: GroupRole | null): number {
  switch (role) {
    case GroupRole.OWNER:
      return 0;
    case GroupRole.ADMIN:
      return 1;
    default:
      return 2;
  }
}

/** Strict outrank: the operator may remove the target iff their rank is strictly lower. */
function outranks(
  operator: GroupRole | null,
  target: GroupRole | null,
): boolean {
  return roleRank(operator) < roleRank(target);
}

/** Lexical capability, created only after locks and authorization. Mutable pair state is not cached. */
interface ValidatedDecisionBase {
  readonly [validated]: true;
  readonly tx: DatabaseTransaction;
  readonly params: GroupAuthoredMembershipIntentCommand;
  readonly pairId: bigint;
  readonly threadLock: ThreadContentLock;
  readonly member: Applicant;
  readonly localMemberId: number | null;
  readonly authorization: GroupMembershipAuthorizationRow;
}

type ValidatedDecision = ValidatedDecisionBase &
  (
    | {
        readonly kind: 'acceptance';
        readonly input: GroupMembershipAcceptanceInput;
      }
    | {
        readonly kind: 'revocation';
        readonly input: GroupMembershipRevocationInput;
      }
    | {
        readonly kind: 'request';
        readonly input: GroupAuthoredMembershipRequestInput;
      }
  );

/** Application service for the complete authored-intent command family.
 * The public entry owns the transaction; internal updates consume its validated lock capability.
 * The owner acquires the complete allocator lock set before composing source writes. */
export class GroupAuthoredMembershipIntentService {
  private readonly logger = new Logger(
    GroupAuthoredMembershipIntentService.name,
  );
  constructor(
    private readonly deps: GroupAuthoredMembershipIntentDependencies,
  ) {}

  async execute(
    params: GroupAuthoredMembershipIntentCommand,
  ): Promise<GroupAuthoredMembershipIntentResult> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if ('status' in context) return { outcome: context };
      return {
        outcome: { status: 'APPLIED' as const },
        peers: await this.applyInTx(context, clientUpdates),
      };
    });
    if (peers.peers === undefined) return peers.outcome;
    this.publishWakes(peers.peers, clientUpdates);
    return peers.outcome;
  }

  /** System-authored revocation after the member's authority denied a thread
   * query. This bypasses manager authorization but retains the normal authored
   * mutation locks and fences the captured thread generation at commit time. */
  async executeQueryDeniedRevocation(params: {
    threadId: number;
    group: { account: string; domain: 'local'; namespaceId: 0 };
    member: { account: string; domain: string; namespaceId: number };
    expectedAuthorizationEpoch: number;
  }): Promise<QueryDeniedMembershipRevocationResult> {
    if (params.member.domain === 'local')
      throw new Error('query-denied group revocation requires a remote member');
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      // Entry-scope advisory before the writer's row locks; nested writers
      // never take advisories themselves.
      await lockBusinessAccountsInTx(tx, [
        { account: params.group.account, domain: params.group.domain },
      ]);
      return this.deps.relationshipMutations.writeGroupRelationshipIntentInTx(
        tx,
        params.threadId,
        params.member,
        '',
        'REVOKED',
        clientUpdates,
        undefined,
        {
          expectedAuthorization: {
            epoch: params.expectedAuthorizationEpoch,
            group: params.group,
          },
        },
      );
    });
    this.publishWakes(peers, clientUpdates);
    return peers.size > 0 || clientUpdates.length > 0
      ? { status: 'APPLIED' }
      : { status: 'NO_OP', reason: 'STALE_OR_ALREADY_REVOKED' };
  }

  private publishWakes(
    peers: Map<number, bigint>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): void {
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn(
        'group-authored membership intent client-state wake failed',
        error,
      );
    }
    if (peers.size > 0)
      void this.deps.federation.pushStateFeedNamespaces(peers.keys());
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    if (params.decision === 'REQUESTED')
      return this.lockAndValidateRequestInTx(tx, params);
    return this.lockAndValidateExistingTargetInTx(tx, params);
  }

  /** The address names the current canonical pair and its business lock scopes.
   * Intent, roster, manager authority, and action scope are checked after locks. */
  private async lockAndValidateExistingTargetInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'ACCEPTED' | 'REVOKED' }
    >,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    const targetAccount = normalizeAccount(params.target.account);
    const targetDomain = params.target.domain.trim().toLowerCase();
    const candidate = (
      await tx.execute<{
        pairId: string;
        account: string;
        domain: string;
        namespaceId: number;
        groupAccount: string;
        groupDomain: string;
      }>(
        groupAuthoredMembershipAddressLocatorSql({
          threadId: params.threadId,
          targetAccount,
          targetDomain,
        }),
      )
    ).rows[0];
    if (!candidate)
      return this.reject(
        params.scope === 'MEMBER' ? 'TARGET_NOT_FOUND' : 'INTENT_NOT_FOUND',
        params.scope === 'MEMBER'
          ? BusinessCode.GROUP_TARGET_NOT_MEMBER
          : BusinessCode.NOT_FOUND,
        params.scope === 'MEMBER'
          ? 'target is not an active group member'
          : 'group request not found',
      );
    const member: Applicant = {
      account: candidate.account,
      domain: candidate.domain,
      namespaceId: candidate.namespaceId,
    };
    await lockBusinessAccountsInTx(tx, [
      { account: candidate.groupAccount, domain: candidate.groupDomain },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(
            candidate.groupAccount,
            candidate.groupDomain,
          ),
          completeBusinessAddress(member.account, member.domain),
        ],
      },
    ]);
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.threadId,
      params.threadId,
    );
    const pairId = BigInt(candidate.pairId);
    const [lockedPair] = await tx
      .select()
      .from(relationshipPair)
      .where(eq(relationshipPair.id, pairId))
      .for('no key update');
    if (!lockedPair || lockedPair.threadId !== params.threadId)
      throw new Error('group member pair changed');
    await lockGroupMemberIntentRowsInTx(
      tx,
      {
        account:
          lockedPair.endpointAType === 'GROUP'
            ? lockedPair.endpointAAccount
            : lockedPair.endpointBAccount,
        namespaceId:
          lockedPair.endpointAType === 'GROUP'
            ? lockedPair.endpointANamespaceId
            : lockedPair.endpointBNamespaceId,
      },
      {
        account:
          lockedPair.endpointAType === 'GROUP'
            ? lockedPair.endpointBAccount
            : lockedPair.endpointAAccount,
        namespaceId:
          lockedPair.endpointAType === 'GROUP'
            ? lockedPair.endpointBNamespaceId
            : lockedPair.endpointANamespaceId,
      },
    );
    await this.lockParticipantsInTx(tx, params, member);
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${params.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    const row = await this.readInvitationAuthorizationInTx(
      tx,
      params,
      pairId,
      member,
    );
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('group decision requires an authoritative group');
    if (params.scope === 'MEMBER' && !row.pairActive)
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.GROUP_TARGET_NOT_MEMBER,
        'target is not an active group member',
      );
    if (
      params.scope === 'APPLICATION' &&
      (row.memberIntentStatus === null ||
        (row.memberIntentStatus === 'ACCEPTED' && row.invitationOutstanding))
    )
      return this.reject(
        'INTENT_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'join request not found',
      );
    if (
      params.scope === 'INVITATION' &&
      (row.pairActive ||
        row.groupIntentStatus !== 'REQUESTED' ||
        row.groupIntentExpiresAt === null ||
        new Date(row.groupIntentExpiresAt) <= new Date())
    )
      return this.reject(
        'INTENT_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'invitation not found',
      );
    if (params.decision === 'ACCEPTED') {
      if (row.memberIntentStatus === null)
        return this.reject(
          'INTENT_NOT_FOUND',
          BusinessCode.NOT_FOUND,
          'join request not found',
        );
      return this.validateAcceptanceInTx(tx, params, pairId, threadLock, row);
    }
    return this.validateRevocationInTx(tx, params, pairId, threadLock, row);
  }

  /** The REQUESTED (invitation) entry. The target names the pair, so the group
   * address comes from the group profile and the pair is minted when absent. */
  private async lockAndValidateRequestInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    const targetAccount = normalizeAccount(params.target.account);
    const targetDomain = params.target.domain.trim().toLowerCase();
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        targetNamespaceId: number | null;
      }>(
        groupAuthoredInvitationLocatorSql({
          threadId: params.threadId,
          targetAccount,
          targetDomain,
        }),
      )
    ).rows[0];
    if (!located)
      return this.reject(
        'GROUP_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'group not found',
      );
    if (located.targetNamespaceId === null)
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'invitation target is unavailable',
      );
    const member: Applicant = {
      account: targetAccount,
      domain: targetDomain,
      namespaceId: located.targetNamespaceId,
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
    const currentGroup = (
      await tx.execute<{ dissolvedAt: string | null }>(
        groupAuthoredMembershipTargetLocatorSql({ threadId: params.threadId }),
      )
    ).rows[0];
    if (!currentGroup)
      return this.reject(
        'GROUP_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'group not found',
      );
    if (currentGroup.dissolvedAt)
      return this.reject(
        'GROUP_DISSOLVED',
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    // Mint the canonical pair when the target has none yet. The conflicting DO
    // UPDATE always takes the row lock and rewrites the canonical thread binding,
    // so no separate pair select follows the insert.
    const pairId = await mintGroupMemberPairInTx(tx, {
      threadId: params.threadId,
      groupAccount: located.groupAccount,
      groupNamespaceId: 0,
      memberAccount: member.account,
      profileNamespaceId: member.namespaceId,
    });
    await lockGroupMemberIntentRowsInTx(
      tx,
      { account: located.groupAccount, namespaceId: 0 },
      member,
    );
    await this.lockParticipantsInTx(tx, params, member);
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${params.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    const row = await this.readInvitationAuthorizationInTx(
      tx,
      params,
      pairId,
      member,
    );
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('join decision requires an authoritative group');
    return this.validateRequestInTx(tx, params, pairId, threadLock, row);
  }

  /** Locks the thread participants whose AccountThreadState rows the command
   * touches: the member when hosted locally, and the acting manager. */
  private async lockParticipantsInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
    member: { account: string; domain: string },
  ): Promise<void> {
    await tx.execute(
      sql`SELECT participant.id FROM "AccountThreadState" participant
        JOIN "Account" owner ON owner.id = participant."accountId"
        WHERE participant."threadId" = ${params.threadId}
          AND ((owner.account = ${member.account} AND ${member.domain} = 'local') OR owner.id = ${params.managerUserId})
        ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
      `,
    );
  }

  private async readInvitationAuthorizationInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
    pairId: bigint,
    member: Applicant,
  ): Promise<GroupMembershipAuthorizationRow & { pairId: string }> {
    const result = await tx.execute<
      GroupMembershipAuthorizationRow & { pairId: string }
    >(
      groupAuthoredMembershipInvitationAuthorizationSql({
        threadId: params.threadId,
        pairId,
        managerUserId: params.managerUserId,
        targetAccount: member.account,
        targetDomain: member.domain,
        targetNamespaceId: member.namespaceId,
      }),
    );
    return result.rows[0];
  }

  private validateAcceptanceInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
    pairId: bigint,
    threadLock: ThreadContentLock,
    row: GroupMembershipAuthorizationRow,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    if (row.dissolvedAt)
      return Promise.resolve(
        this.reject(
          'GROUP_DISSOLVED',
          BusinessCode.GROUP_DISSOLVED,
          'group has been dissolved',
        ),
      );
    if (!row.authorized)
      return Promise.resolve(
        this.reject(
          'FORBIDDEN',
          BusinessCode.GROUP_FORBIDDEN,
          'only active group managers may handle requests',
        ),
      );
    // Entry states: a pending application, an outstanding invitation whose
    // invitee already acked, or an already-completed command (silent no-op).
    // Side B REVOKED is equally a no-op; a pair-active member is already satisfied
    // — checked after the application gate, so the loser of a duplicate approval
    // still reports NOT_FOUND instead of masquerading as a satisfied no-op.
    if (row.memberIntentStatus === 'REVOKED')
      return Promise.resolve({ status: 'NO_OP', reason: 'ALREADY_REVOKED' });
    if (row.memberIntentStatus === 'REQUESTED' && !row.applicationPending)
      return Promise.resolve(
        this.reject(
          'INTENT_EXPIRED',
          BusinessCode.INVITE_EXPIRED,
          'join request has expired',
        ),
      );
    if (row.pairActive)
      return Promise.resolve({ status: 'NO_OP', reason: 'ALREADY_MEMBER' });
    if (
      row.memberIntentStatus === 'ACCEPTED' &&
      !row.invitationOutstanding &&
      row.groupIntentStatus !== 'ACCEPTED'
    )
      return Promise.resolve({ status: 'NO_OP', reason: 'ALREADY_SATISFIED' });
    if (
      !Number.isSafeInteger(row.memberProfileRev ?? -1) ||
      (row.memberProfileRev ?? -1) < 0
    )
      throw new Error('active group member has an invalid profile revision');
    // Capacity is a group-side authorization growth gate; a pair already in the
    // capacity set (the group's own outstanding invitation, or a pair-active
    // member) keeps its reserved slot.
    if (
      !row.alreadyAuthorized &&
      row.authorizedCount >= SERVER_MAX_GROUP_MEMBERS
    )
      return Promise.resolve(
        this.reject(
          'GROUP_FULL',
          BusinessCode.GROUP_FULL,
          `group invitations, including pending invitations, have reached the ${SERVER_MAX_GROUP_MEMBERS}-person limit`,
        ),
      );
    if (row.profileNamespaceId === 0 && row.localMemberId === null)
      return Promise.resolve(
        this.reject(
          'TARGET_NOT_FOUND',
          BusinessCode.NOT_FOUND,
          'local applicant is missing',
        ),
      );
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.profileNamespaceId!,
    };
    const memberNote: string = row.memberNote ?? '';
    return this.finalizeValidationInTx(tx, {
      [validated]: true,
      tx,
      params,
      pairId,
      threadLock,
      member,
      localMemberId: row.localMemberId,
      authorization: row,
      kind: 'acceptance',
      input: {
        pairId,
        threadId: params.threadId,
        groupAccount: row.account,
        groupProfileRev: row.profileRev,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        memberAccount: member.account,
        profileNamespaceId: member.namespaceId,
        // An application keeps the applicant's note; completing an invitation
        // preserves the group's own invitation note through the promotion.
        note:
          row.memberIntentStatus === 'REQUESTED'
            ? memberNote
            : (row.groupIntentNote ?? ''),
        acceptedAt: new Date(),
        projectionDirections: ['APPLICATION'],
      },
    });
  }

  private validateRevocationInTx(
    tx: DatabaseTransaction,
    params: Exclude<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
    pairId: bigint,
    threadLock: ThreadContentLock,
    row: GroupMembershipAuthorizationRow,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    if (!row.authorized)
      return Promise.resolve(
        this.reject(
          'FORBIDDEN',
          BusinessCode.GROUP_FORBIDDEN,
          'only active group managers may handle requests',
        ),
      );
    // Rejecting and cancelling stay available on a dissolved group (v1
    // semantics); removing a pair-active member there is the disband fan-out's
    // job, and the future system reverse-task entry bypasses this gate.
    if (row.pairActive && row.dissolvedAt)
      return Promise.resolve(
        this.reject(
          'GROUP_DISSOLVED',
          BusinessCode.GROUP_DISSOLVED,
          'group has been dissolved',
        ),
      );
    // Kicking requires strictly outranking the target: an administrator may
    // only remove members, and no manager may remove the owner or a peer —
    // including themselves.
    if (row.pairActive && !outranks(row.operatorRole, row.memberRole))
      return Promise.resolve(
        this.reject(
          'FORBIDDEN',
          BusinessCode.GROUP_FORBIDDEN,
          'you can only kick members below your role',
        ),
      );
    // A revoke targets either a pair-active member (kick) or a live application
    // (rejection). Everything else is a stale command.
    const cancelsInvitation =
      row.groupIntentStatus === 'REQUESTED' &&
      row.groupIntentExpiresAt !== null &&
      new Date(row.groupIntentExpiresAt) > new Date();
    if (!row.pairActive && !row.applicationPending && !cancelsInvitation)
      return Promise.resolve(
        this.reject(
          row.memberIntentStatus === 'REQUESTED'
            ? 'INTENT_EXPIRED'
            : 'INTENT_NOT_FOUND',
          row.memberIntentStatus === 'REQUESTED'
            ? BusinessCode.INVITE_EXPIRED
            : BusinessCode.NOT_FOUND,
          row.memberIntentStatus === 'REQUESTED'
            ? 'join request has expired'
            : 'join request not found',
        ),
      );
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.profileNamespaceId!,
    };
    return this.finalizeValidationInTx(tx, {
      [validated]: true,
      tx,
      params,
      pairId,
      threadLock,
      member,
      localMemberId: row.localMemberId,
      authorization: row,
      kind: 'revocation',
      input: {
        threadId: params.threadId,
        pairId,
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        memberAccount: member.account,
        profileNamespaceId: member.namespaceId,
        localMemberId: row.localMemberId,
        projectionDirections: row.projectionDirections,
        author: { account: row.account, namespaceId: 0 },
        receiver: {
          account: member.account,
          namespaceId: member.namespaceId,
        },
      },
    });
  }

  /** REQUESTED entry validation. `req + req/ack = ack`: a live application or an
   * outstanding invitation is completed by the ACK path with the authorization
   * row already in hand, so both entry states share one implementation. A
   * pair-active member or a dissolved group is a silent no-op; every other reverse
   * state (none, REVOKED, expired) receives a fresh invitation. */
  private validateRequestInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
    pairId: bigint,
    threadLock: ThreadContentLock,
    row: GroupMembershipAuthorizationRow,
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    if (row.dissolvedAt)
      return Promise.resolve(
        this.reject(
          'GROUP_DISSOLVED',
          BusinessCode.GROUP_DISSOLVED,
          'group has been dissolved',
        ),
      );
    if (!row.authorized)
      return Promise.resolve(
        this.reject(
          'FORBIDDEN',
          BusinessCode.GROUP_FORBIDDEN,
          'only active group managers may handle requests',
        ),
      );
    if (row.pairActive)
      return Promise.resolve({ status: 'NO_OP', reason: 'ALREADY_MEMBER' });
    if (
      (row.memberIntentStatus === 'REQUESTED' && row.applicationPending) ||
      row.invitationOutstanding
    )
      return this.validateAcceptanceInTx(tx, params, pairId, threadLock, row);
    if (row.profileNamespaceId === 0 && row.localMemberId === null)
      return Promise.resolve(
        this.reject(
          'TARGET_NOT_FOUND',
          BusinessCode.NOT_FOUND,
          'invitation target is missing',
        ),
      );
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.profileNamespaceId!,
    };
    return this.finalizeValidationInTx(tx, {
      [validated]: true,
      tx,
      params,
      pairId,
      threadLock,
      member,
      localMemberId: row.localMemberId,
      authorization: row,
      kind: 'request',
      input: {
        threadId: params.threadId,
        pairId,
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        targetAccount: member.account,
        targetDomain: member.domain,
        targetNamespaceId: member.namespaceId,
        localTargetId: row.localMemberId,
        note: (params.note ?? '').slice(0, 255),
        requestedAt,
        expiresAt,
      },
    });
  }

  private reject(
    reason: BusinessRejection['reason'],
    code: BusinessCode,
    message: string,
  ): BusinessRejection {
    return rejectBusinessCommand(reason, code, message);
  }

  /** Shared branch epilogue: outbound namespace allocator locks, the Account row locks the
   * composed statements rely on, and (acceptance only) the synchronization
   * state lock, all in the established lock order. */
  private async finalizeValidationInTx(
    tx: DatabaseTransaction,
    context: ValidatedDecision,
  ): Promise<ValidatedDecision> {
    if (context.member.domain !== 'local')
      await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        {
          namespaceId: context.member.namespaceId,
        },
      ]);
    const accounts = [
      ...context.authorization.managerIds,
      ...(context.localMemberId === null ? [] : [context.localMemberId]),
    ];
    await tx.execute(
      sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(accounts)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
    );
    if (context.kind === 'acceptance' && context.member.domain !== 'local')
      await tx.execute(
        sql`SELECT "threadId" FROM "FederationThreadSyncState" WHERE "threadId" = ${context.params.threadId} AND "namespaceId" = ${context.member.namespaceId} FOR NO KEY UPDATE`,
      );
    return context;
  }

  private async applyInTx(
    context: ValidatedDecision,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    if (context[validated] !== true || context.threadLock.tx !== context.tx)
      throw new Error('invalid group-authored membership intent lock context');
    switch (context.kind) {
      case 'acceptance':
        return this.applyAcceptanceInTx(context, clientUpdates);
      case 'revocation':
        return this.applyRevocationInTx(context, clientUpdates);
      case 'request':
        return this.applyRequestInTx(context, clientUpdates);
    }
  }

  private async applyAcceptanceInTx(
    context: Extract<ValidatedDecision, { kind: 'acceptance' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const { tx } = context;
    const result = await tx.execute<{
      canonicalRosterChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      recipientFeedId: string | null;
      recipientUserId: number | null;
      invalidPeerHead: boolean;
    }>(groupMembershipAcceptanceSql(context.input));
    const row = result.rows[0];
    if (!row) throw new Error('group membership acceptance update disappeared');
    if (row.invalidPeerHead) throw new Error('conflicting peer content head');
    // The composed statement admitted the thread fan-outs; the applicant's own
    // intent feed row is a one-person notification fact and wakes directly.
    if (row.recipientUserId !== null && row.recipientFeedId !== null)
      clientUpdates.push({
        userId: row.recipientUserId,
        feedId: Number(row.recipientFeedId),
      });
    // The ACK feed belongs only to the applicant's peer. Wake it after commit.
    return context.member.domain !== 'local' && row.recipientFeedId !== null
      ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
      : new Map();
  }

  private async applyRevocationInTx(
    context: Extract<ValidatedDecision, { kind: 'revocation' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const { tx } = context;
    const result = await tx.execute<{
      requestId: string;
      status: string;
      intentChanged: boolean;
      pairChanged: boolean;
      departed: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      recipientUserId: number | null;
      recipientFeedId: string | null;
    }>(groupMembershipRevocationSql(context.input));
    const row = result.rows[0];
    if (!row) throw new Error('group membership revocation update disappeared');
    if (row.recipientUserId !== null && row.recipientFeedId !== null)
      clientUpdates.push({
        userId: row.recipientUserId,
        feedId: Number(row.recipientFeedId),
      });
    const peers =
      context.member.domain !== 'local' && row.recipientFeedId !== null
        ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
        : new Map();
    if (row.pairChanged && context.localMemberId !== null) {
      const conclusion =
        await this.deps.relationshipMutations.writeMemberRelationshipIntentInTx(
          tx,
          context.params.threadId,
          context.localMemberId,
          'REVOKED',
          clientUpdates,
        );
      for (const [namespaceId, feedId] of conclusion)
        peers.set(namespaceId, feedId);
    }
    return peers;
  }

  private async applyRequestInTx(
    context: Extract<ValidatedDecision, { kind: 'request' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const { tx } = context;
    const result = await tx.execute<{
      requestId: string;
      status: string;
      note: string;
      intentChanged: boolean;
      projectionChanged: boolean;
      audienceChanged: boolean;
      recipientUserId: number | null;
      recipientFeedId: string | null;
    }>(groupAuthoredMembershipRequestSql(context.input));
    const row = result.rows[0];
    if (!row)
      throw new Error('group-authored membership request update disappeared');
    if (row.recipientUserId !== null && row.recipientFeedId !== null)
      clientUpdates.push({
        userId: row.recipientUserId,
        feedId: Number(row.recipientFeedId),
      });
    // Managers are not woken here: their per-manager notification is the
    // projection fan-out task's job — the executor advances each manager's
    // direction watermarks, which rides the thread feed and wakes them.
    // Decision-time flips (acknowledge/revoke) stay silent entirely.
    // No thread-head admission: an invitation writes no GroupMeta facts. The
    // projection fan-out task is admitted only when manager rows changed.
    if (row.projectionChanged)
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId: context.params.threadId,
        groupAccount: context.authorization.account,
      });
    return context.member.domain !== 'local' && row.recipientFeedId !== null
      ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
      : new Map();
  }
}
