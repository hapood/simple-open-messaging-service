import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import type { AccountSubjectAddress } from '../../../user/account-address.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  groupMembershipAcceptanceIntentWrites,
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
  groupMembershipRevocationIntentWrite,
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
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { validateRequestDecisionInTx } from '../../../relationship/request/validate-request-decision-in-tx.js';
import type { RequestDecision } from '../../../../shared/relationship-request.js';
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
import type { FederationStateFeedPusher } from '../../../federation/federation-state-feed.events.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../../common/relationship-intent-state.js';
import type { GroupRelationshipMutationService } from '../shared/group-relationship-mutation.service.js';

/** One command family: the group's authored intent about one addressed member. */
export type GroupAuthoredMembershipIntentCommand =
  | {
      threadId: number;
      managerUserId: number;
      decision: 'REQUESTED';
      snapshot: RequestSnapshot;
      target: { account: string; namespaceId: number };
      note?: string;
    }
  | {
      threadId: number;
      managerUserId: number;
      decision: 'ACCEPTED';
      target: { account: string; namespaceId: number };
      scope: 'APPLICATION' | 'INVITATION';
      note?: never;
    }
  | {
      threadId: number;
      managerUserId: number;
      decision: 'REVOKED';
      target: { account: string; namespaceId: number };
      scope: 'APPLICATION' | 'INVITATION' | 'MEMBER';
      note?: never;
    };

export type GroupAuthoredMembershipIntentResult =
  | { status: 'APPLIED' }
  | {
      status: 'NO_OP';
      reason: 'ALREADY_MEMBER' | 'ALREADY_REVOKED' | 'ALREADY_SATISFIED';
    }
  | { status: 'STALE_REQUEST' }
  | { status: 'EXPIRED' }
  | BusinessRejection;

export interface GroupAuthoredMembershipIntentOptions {
  /** Exact-round gate for manager-side HTTP decisions: the command may only
   * settle the named open round. Validated under the membership locks held
   * here, so a replaced or concluded round cannot be decided by a stale id. */
  requestDecision?: { requestId: bigint; decision: RequestDecision };
}

export type QueryDeniedMembershipRevocationResult =
  | { status: 'APPLIED' }
  | { status: 'NO_OP'; reason: 'STALE_OR_ALREADY_REVOKED' };

type Applicant = {
  account: string;
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
        readonly action: 'KICK' | 'REJECT' | 'WITHDRAW';
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
    private readonly database: DatabaseService,
    private readonly clientFeed: ClientStateFeedService,
    private readonly peerFeed: PeerStateFeedService,
    private readonly federation: FederationStateFeedPusher,
    private readonly relationshipMutations: GroupRelationshipMutationService,
  ) {}

  async execute(
    params: GroupAuthoredMembershipIntentCommand,
    options?: GroupAuthoredMembershipIntentOptions,
  ): Promise<GroupAuthoredMembershipIntentResult> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(
        tx,
        params,
        options?.requestDecision,
      );
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
    group: { account: string; namespaceId: 0 };
    member: AccountSubjectAddress;
    expectedAuthorizationEpoch: number;
  }): Promise<QueryDeniedMembershipRevocationResult> {
    if (params.member.namespaceId === 0)
      throw new Error('query-denied group revocation requires a remote member');
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.database.db.transaction(async (tx) => {
      // Entry-scope advisory before the writer's row locks; nested writers
      // never take advisories themselves.
      await lockBusinessAccountsInTx(tx, [
        {
          account: params.group.account,
          profileNamespaceId: params.group.namespaceId,
        },
      ]);
      return this.relationshipMutations.writeGroupRelationshipIntentInTx(
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
        this.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn(
        'group-authored membership intent client-state wake failed',
        error,
      );
    }
    if (peers.size > 0)
      void this.federation.pushStateFeedNamespaces(peers.keys());
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
    requestDecision?: { requestId: bigint; decision: RequestDecision },
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    if (
      requestDecision &&
      (params.decision === 'REQUESTED' ||
        params.scope === 'MEMBER' ||
        (params.scope === 'APPLICATION'
          ? !['ACCEPT', 'REJECT'].includes(requestDecision.decision)
          : requestDecision.decision !== 'WITHDRAW') ||
        params.decision !==
          (requestDecision.decision === 'ACCEPT' ? 'ACCEPTED' : 'REVOKED'))
    )
      return { status: 'STALE_REQUEST' };
    if (params.decision === 'REQUESTED')
      return this.lockAndValidateRequestInTx(tx, params);
    return this.lockAndValidateExistingTargetInTx(tx, params, requestDecision);
  }

  /** The address names the current canonical pair and its business lock scopes.
   * Intent, roster, manager authority, and action scope are checked after locks. */
  private async lockAndValidateExistingTargetInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'ACCEPTED' | 'REVOKED' }
    >,
    requestDecision?: { requestId: bigint; decision: RequestDecision },
  ): Promise<ValidatedDecision | GroupAuthoredMembershipIntentResult> {
    const targetAccount = normalizeAccount(params.target.account);
    const candidate = (
      await tx.execute<{
        pairId: string;
        account: string;
        namespaceId: number;
        groupAccount: string;
      }>(
        groupAuthoredMembershipAddressLocatorSql({
          threadId: params.threadId,
          targetAccount,
          targetNamespaceId: params.target.namespaceId,
        }),
      )
    ).rows[0];
    if (!candidate && requestDecision) return { status: 'STALE_REQUEST' };
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
      namespaceId: candidate.namespaceId,
    };
    await lockBusinessAccountsInTx(tx, [
      { account: candidate.groupAccount, profileNamespaceId: 0 },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(candidate.groupAccount, 0),
          completeBusinessAddress(member.account, member.namespaceId),
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
    if (!row || row.namespaceId !== 0)
      throw new Error('group decision requires an authoritative group');
    if (!row.authorized)
      return this.reject(
        'FORBIDDEN',
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    if (requestDecision && params.scope !== 'MEMBER') {
      const group = { account: row.account, namespaceId: 0 };
      const application = params.scope === 'APPLICATION';
      const gate = await validateRequestDecisionInTx(tx, {
        flow: {
          kind: application ? 'GROUP_APPLICATION' : 'GROUP_INVITATION',
          author: application ? member : group,
          receiver: application ? group : member,
        },
        requestId: requestDecision.requestId,
        pairActive: row.pairActive,
        asOf: new Date(),
      });
      if (gate) return gate;
    }
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
    const located = (
      await tx.execute<{
        groupAccount: string;
        targetNamespaceId: number | null;
      }>(
        groupAuthoredInvitationLocatorSql({
          threadId: params.threadId,
          targetAccount,
          targetNamespaceId: params.target.namespaceId,
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
      namespaceId: located.targetNamespaceId,
    };
    await lockBusinessAccountsInTx(tx, [
      { account: located.groupAccount, profileNamespaceId: 0 },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(located.groupAccount, 0),
          completeBusinessAddress(member.account, member.namespaceId),
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
    if (!row || row.namespaceId !== 0)
      throw new Error('join decision requires an authoritative group');
    return this.validateRequestInTx(tx, params, pairId, threadLock, row);
  }

  /** Locks the thread participants whose AccountThreadState rows the command
   * touches: the member when hosted locally, and the acting manager. */
  private async lockParticipantsInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
    member: Applicant,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT participant.id FROM "AccountThreadState" participant
        JOIN "Account" owner ON owner.id = participant."accountId"
        WHERE participant."threadId" = ${params.threadId}
          AND ((owner.account = ${member.account} AND owner."namespaceId" = ${member.namespaceId}) OR owner.id = ${params.managerUserId})
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
    // Side B REVOKED is equally a no-op; a pair-active member is already
    // satisfied — after the application gate, so a pending direction under an
    // active pair (a crossed invitation the invitee acked) still reports the
    // expiry rather than masquerading as a satisfied no-op. A duplicate
    // approval instead finds the folded ACCEPTED direction and reports
    // ALREADY_MEMBER, matching the P2P acceptance parity.
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
        memberAccount: member.account,
        profileNamespaceId: member.namespaceId,
        // An application keeps the applicant's note; completing an invitation
        // preserves the group's own invitation note through the promotion.
        note:
          row.memberIntentStatus === 'REQUESTED'
            ? memberNote
            : (row.groupIntentNote ?? ''),
        acceptedAt: new Date(),
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
      namespaceId: row.profileNamespaceId!,
    };
    const action = row.pairActive
      ? ('KICK' as const)
      : params.scope === 'APPLICATION'
        ? ('REJECT' as const)
        : ('WITHDRAW' as const);

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
      action,
      input: {
        threadId: params.threadId,
        pairId,
        groupAccount: row.account,
        groupProfileRev: row.profileRev,
        memberAccount: member.account,
        profileNamespaceId: member.namespaceId,
        localMemberId: row.localMemberId,
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
        groupProfileRev: row.profileRev,
        targetAccount: member.account,
        snapshot: params.snapshot,
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
    if (context.member.namespaceId !== 0)
      await this.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
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
    if (context.kind === 'acceptance' && context.member.namespaceId !== 0)
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
    for (const write of groupMembershipAcceptanceIntentWrites(context.input))
      await tx.execute(write);
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
    // Participant updates ride the thread feed, not the retired client intent feed.
    if (context.localMemberId !== null)
      clientUpdates.push(
        ...(await captureThreadStateUpdatesInTx(tx, [context.localMemberId])),
      );
    // The manager's ACK concludes the pending application round, or is a
    // group-side no-op after the invitee already completed the invitation.
    await this.relationshipMutations.writeGroupRequestEffectsInTx(
      tx,
      context.params.threadId,
      context.member,
      'ACCEPTED',
      context.authorization.memberIntentStatus === 'REQUESTED'
        ? 'APPLICATION'
        : 'INVITATION',
    );
    // The ACK feed belongs only to the applicant's peer. Wake it after commit.
    return context.member.namespaceId !== 0 && row.recipientFeedId !== null
      ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
      : new Map();
  }

  private async applyRevocationInTx(
    context: Extract<ValidatedDecision, { kind: 'revocation' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const { tx } = context;
    await tx.execute(groupMembershipRevocationIntentWrite(context.input));
    const result = await tx.execute<{
      requestId: string;
      status: string;
      pairChanged: boolean;
      departed: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      recipientUserId: number | null;
      recipientFeedId: string | null;
    }>(groupMembershipRevocationSql(context.input));
    const row = result.rows[0];
    if (!row) throw new Error('group membership revocation update disappeared');
    // Explicit manager-side terminal actions:
    // - REJECT: rejects a pending application (request -> REJECTED)
    // - WITHDRAW: cancels the group's own live invitation (request -> WITHDRAWN)
    // - KICK: removes a rostered member (completed request stays ACCEPTED)
    if (context.action === 'REJECT') {
      await this.relationshipMutations.writeGroupRequestEffectsInTx(
        tx,
        context.params.threadId,
        context.member,
        'REJECTED',
        'APPLICATION',
      );
    } else if (context.action === 'WITHDRAW') {
      await this.relationshipMutations.writeGroupRequestEffectsInTx(
        tx,
        context.params.threadId,
        context.member,
        'WITHDRAWN',
        'INVITATION',
      );
    }

    const peers =
      context.member.namespaceId !== 0 && row.recipientFeedId !== null
        ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
        : new Map();
    if (context.action === 'REJECT' && context.localMemberId !== null) {
      // The pair and both directions are already locked. Conclude the local
      // requester without re-entering the group mutation/lock orchestration.
      await tx.execute(
        authoredIntentWriteSql({
          author: context.member,
          receiver: { account: context.authorization.account, namespaceId: 0 },
          threadId: context.params.threadId,
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        }),
      );
    }
    if (row.pairChanged && context.localMemberId !== null) {
      const conclusion =
        await this.relationshipMutations.writeMemberRelationshipIntentInTx(
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

    // Managers are not woken here: their per-manager notification is the
    // projection fan-out task's job — the executor advances each manager's
    // direction watermarks, which rides the thread feed and wakes them.
    // Decision-time flips (acknowledge/revoke) stay silent entirely.
    // No thread-head admission: an invitation writes no GroupMeta membership
    // facts. The invitation opens its permanent round (publishing the local
    // invitee's incoming head) and admits the projection fan-out task only
    // when a new round was actually created.
    const effects =
      await this.relationshipMutations.writeGroupRequestEffectsInTx(
        tx,
        context.params.threadId,
        context.member,
        'REQUESTED',
        'INVITATION',
        true,
        context.input.snapshot,
      );
    clientUpdates.push(...effects.clientUpdates);
    if (effects.created)
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId: context.params.threadId,
        groupAccount: context.authorization.account,
      });
    return context.member.namespaceId !== 0 && row.recipientFeedId !== null
      ? new Map([[context.member.namespaceId, BigInt(row.recipientFeedId)]])
      : new Map();
  }
}
