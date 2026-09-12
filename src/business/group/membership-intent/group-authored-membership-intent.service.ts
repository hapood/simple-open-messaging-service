import { lockRelationshipPairsInTx } from '../../shared/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../shared/locks/business-address.js';
import { lockBusinessAccountsInTx } from '../../shared/locks/account-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../shared/locks/thread-content-lock.js';
import {
  groupMembershipAcceptanceSql,
  type GroupMembershipAcceptanceInput,
} from './group-membership-acceptance-sql.js';
import {
  groupAuthoredMembershipAuthorizationSql,
  groupAuthoredMembershipInvitationAuthorizationSql,
  groupAuthoredMembershipTargetLocatorSql,
  groupAuthoredMembershipLocatorSql,
} from './group-authored-membership-authorization-sql.js';
import {
  groupMembershipRevocationSql,
  type GroupMembershipRevocationInput,
} from './group-membership-revocation-sql.js';
import {
  groupAuthoredMembershipRequestSql,
  type GroupAuthoredMembershipRequestInput,
} from './group-authored-membership-request-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from './group-membership-projection-fanout.js';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { GroupRole } from '../../../database/enums.js';
import { BusinessCode } from '../../../common/business-code.js';
import { BusinessException } from '../../../common/business.exception.js';
import { normalizeAccount } from '../../../common/account.js';
import { SERVER_MAX_GROUP_MEMBERS } from '../../../group/group-capacity.js';
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
import { loadFederationConfig } from '../../../federation/federation.config.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../shared/relationship-intent-state.js';

/** One command family: the group's authored intent about one membership pair.
 * ACK and REVOKE arrive with the member-authored intent (`requestId`) that
 * names the pair; REQUESTED (an invitation) arrives with the target address
 * because no intent may exist yet. */
export type GroupAuthoredMembershipIntentCommand =
  | {
      threadId: number;
      managerUserId: number;
      decision: 'REQUESTED';
      target: { account: string; domain: string; namespaceId: number };
      requestId?: never;
      note?: string;
    }
  | {
      threadId: number;
      managerUserId: number;
      decision: 'ACCEPTED' | 'REVOKED';
      requestId: bigint;
      target?: never;
      note?: never;
    };

export interface GroupAuthoredMembershipIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationService;
}

type Applicant = {
  account: string;
  domain: string;
  namespaceId: number;
};

/** Row shape shared by both authorization statements. The invitation variant
 * adds `pairId`; identity columns are echoed from the command's target. */
type AuthorizationRow = {
  account: string;
  domain: string;
  namespaceId: number;
  name: string;
  avatar: string;
  description: string;
  profileRev: number;
  createdAt: string;
  updatedAt: string;
  dissolvedAt: string | null;
  memberAccount: string | null;
  memberDomain: string | null;
  memberNamespaceId: number | null;
  memberNote: string | null;
  memberIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  memberProfileRev: number | null;
  /** The member's canonical roster role, or null when not rostered. */
  memberRole: GroupRole | null;
  /** The acting manager's canonical roster role (OWNER or ADMIN when authorized). */
  operatorRole: GroupRole | null;
  /** Pairs holding an ACCEPTED or unexpired group invitation — the capacity set. */
  authorizedCount: number;
  /** Whether the member's own pair is already part of the capacity set. */
  alreadyAuthorized: boolean;
  memberIntentEffective: boolean | null;
  groupIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  groupIntentNote: string | null;
  groupIntentExpiresAt: string | null;
  applicationPending: boolean | null;
  invitationOutstanding: boolean | null;
  isMember: boolean | null;
  localMemberId: number | null;
  authorized: boolean;
  managerIds: number[];
  projectionDirections: Array<'APPLICATION' | 'INVITATION'>;
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
  readonly authorization: AuthorizationRow;
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
  private readonly config = loadFederationConfig();

  constructor(
    private readonly deps: GroupAuthoredMembershipIntentDependencies,
  ) {}

  async execute(params: GroupAuthoredMembershipIntentCommand): Promise<void> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if (!context) return undefined;
      return this.applyInTx(context, clientUpdates);
    });
    if (!peers) return;
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn(
        'group-authored membership intent client-state wake failed',
        error,
      );
    }
    if (peers.size === 0) return;
    void this.deps.federation
      .pushStateFeedDomains(peers.keys())
      .catch((error: unknown) =>
        this.logger.warn(
          'group-authored membership intent state-feed wake failed',
          error,
        ),
      );
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupAuthoredMembershipIntentCommand,
  ): Promise<ValidatedDecision | undefined> {
    if (params.decision === 'REQUESTED')
      return this.lockAndValidateRequestInTx(tx, params);
    // One pre-lock locator: the request's pair yields the group (endpointA) and
    // applicant (endpointB) addresses that name both business scopes. It authorizes
    // nothing and carries no state gate; every mutable state is re-read after the
    // locks it names.
    const candidate = (
      await tx.execute<{
        account: string;
        domain: string;
        namespaceId: number;
        pairId: string;
        groupAccount: string;
        groupDomain: string;
      }>(
        groupAuthoredMembershipLocatorSql({
          threadId: params.threadId,
          requestId: params.requestId,
        }),
      )
    ).rows[0];
    if (!candidate)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'join request not found',
      );
    await lockBusinessAccountsInTx(tx, [
      { account: candidate.groupAccount, domain: candidate.groupDomain },
    ]);
    // Both endpoint identities are already in hand: the pair scope key uses complete
    // lowercased addresses and no canonicalization lookup precedes the lock.
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'GROUP_MEMBER',
        addresses: [
          completeBusinessAddress(
            candidate.groupAccount,
            candidate.groupDomain,
          ),
          completeBusinessAddress(candidate.account, candidate.domain),
        ],
      },
    ]);
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.threadId,
      params.threadId,
    );
    // A pending request already owns a canonical pair; no insert or threadId rewrite is needed.
    const pairId = BigInt(candidate.pairId);
    const [lockedPair] = await tx
      .select()
      .from(relationshipPair)
      .where(eq(relationshipPair.id, pairId))
      .for('no key update');
    if (!lockedPair)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'join request pair not found',
      );
    if (lockedPair.threadId !== params.threadId)
      throw new Error('join request pair changed');
    await tx.execute(
      sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId} ORDER BY "authorSide" FOR NO KEY UPDATE`,
    );
    await this.lockParticipantsInTx(tx, params, {
      account: candidate.account,
      domain: candidate.domain,
    });
    // One statement both creates the group allocator row and takes its row lock
    // (the conflicting row is locked by the DO UPDATE self-assignment), keeping
    // the allocator-before-Account ordering without a second round trip. All
    // commands allocate: acceptance writes meta facts, revocation writes the
    // departure fact, a request allocates the invitation projection counter.
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${params.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    const row = await this.readAuthorizationInTx(tx, params);
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('join decision requires an authoritative group');
    if (!row.memberAccount)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'join request not found',
      );
    if (params.decision === 'ACCEPTED') {
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
  ): Promise<ValidatedDecision | undefined> {
    const target = params.target;
    const targetDomain = target.domain.trim().toLowerCase();
    const targetNamespaceId = targetDomain === 'local' ? 0 : target.namespaceId;
    if (!Number.isSafeInteger(targetNamespaceId) || targetNamespaceId < 0)
      throw new Error('invitation target namespace is invalid');
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
      }>(groupAuthoredMembershipTargetLocatorSql({ threadId: params.threadId }))
    ).rows[0];
    if (!located)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    // A dissolved group's invitation is a silent no-op before any write, so no
    // pair row is minted for it — matching the legacy invite's early return.
    if (located.dissolvedAt) return undefined;
    const member: Applicant = {
      account: normalizeAccount(target.account),
      domain: targetDomain,
      namespaceId: targetNamespaceId,
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
    // Mint the canonical pair when the target has none yet. The conflicting DO
    // UPDATE always takes the row lock and mirrors the legacy threadId rewrite,
    // so no separate pair select follows the insert.
    const minted = await tx.execute<{ id: string }>(sql`
      INSERT INTO "RelationshipPair"
        (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
         "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId")
      VALUES ('GROUP_MEMBER', 'GROUP', ${located.groupAccount}, ${located.groupDomain}, ${member.namespaceId},
        'USER', ${member.account}, ${member.domain}, ${member.namespaceId}, ${params.threadId})
      ON CONFLICT ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
        "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
      DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
      RETURNING id
    `);
    const pairId = BigInt(minted.rows[0]!.id);
    await tx.execute(
      sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId} ORDER BY "authorSide" FOR NO KEY UPDATE`,
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

  private async readAuthorizationInTx(
    tx: DatabaseTransaction,
    params: Exclude<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
  ): Promise<AuthorizationRow> {
    const result = await tx.execute<AuthorizationRow>(
      groupAuthoredMembershipAuthorizationSql({
        threadId: params.threadId,
        requestId: params.requestId,
        managerUserId: params.managerUserId,
      }),
    );
    return result.rows[0];
  }

  private async readInvitationAuthorizationInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
    pairId: bigint,
    member: Applicant,
  ): Promise<AuthorizationRow & { pairId: string }> {
    const result = await tx.execute<AuthorizationRow & { pairId: string }>(
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
    row: AuthorizationRow,
  ): Promise<ValidatedDecision | undefined> {
    if (row.dissolvedAt) return Promise.resolve(undefined);
    if (!row.authorized)
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    // Entry states: a pending application, an outstanding invitation whose
    // invitee already acked, or an already-completed command (silent no-op).
    // Side B REVOKED is equally a no-op; a rostered member is already satisfied
    // — checked after the application gate, so the loser of a duplicate approval
    // still reports NOT_FOUND instead of masquerading as a satisfied no-op.
    if (row.memberIntentStatus === 'REVOKED') return Promise.resolve(undefined);
    if (row.memberIntentStatus === 'REQUESTED' && !row.applicationPending)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'join request not found',
      );
    if (row.isMember) return Promise.resolve(undefined);
    if (
      row.memberIntentStatus === 'ACCEPTED' &&
      !row.invitationOutstanding &&
      row.groupIntentStatus !== 'ACCEPTED'
    )
      return Promise.resolve(undefined);
    if (
      !Number.isSafeInteger(row.memberProfileRev ?? -1) ||
      (row.memberProfileRev ?? -1) < 0
    )
      throw new Error('active group member has an invalid profile revision');
    // Capacity is a group-side authorization growth gate; a pair already in the
    // capacity set (the group's own outstanding invitation, or a rostered
    // member) keeps its reserved slot.
    if (
      !row.alreadyAuthorized &&
      row.authorizedCount >= SERVER_MAX_GROUP_MEMBERS
    )
      throw new BusinessException(
        BusinessCode.GROUP_FULL,
        `group invitations, including pending invitations, have reached the ${SERVER_MAX_GROUP_MEMBERS}-person limit`,
      );
    if (row.memberDomain === 'local' && row.localMemberId === null)
      throw new Error('local applicant is missing');
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.memberNamespaceId!,
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
        localDomain: this.config.domain,
        memberAccount: member.account,
        memberDomain: member.domain,
        memberNamespaceId: member.namespaceId,
        // An application keeps the applicant's note; completing an invitation
        // preserves the group's own invitation note through the promotion.
        note:
          row.memberIntentStatus === 'REQUESTED'
            ? memberNote
            : (row.groupIntentNote ?? ''),
        acceptedAt: new Date(),
        managerIds: row.managerIds,
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
    row: AuthorizationRow,
  ): Promise<ValidatedDecision | undefined> {
    if (!row.authorized)
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    // Rejecting and cancelling stay available on a dissolved group (v1
    // semantics); removing a rostered member there is the disband fan-out's
    // job, and the future system reverse-task entry bypasses this gate.
    if (row.isMember && row.dissolvedAt)
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'group membership authority is unavailable',
      );
    // Kicking requires strictly outranking the target: an administrator may
    // only remove members, and no manager may remove the owner or a peer —
    // including themselves.
    if (row.isMember && !outranks(row.operatorRole, row.memberRole))
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'you can only kick members below your role',
      );
    // A revoke targets either a rostered member (kick) or a live application
    // (rejection). Everything else is a stale command.
    const cancelsInvitation =
      row.memberIntentStatus === 'ACCEPTED' && row.invitationOutstanding;
    if (!row.isMember && !row.applicationPending && !cancelsInvitation)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'join request not found',
      );
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.memberNamespaceId!,
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
        localDomain: this.config.domain,
        memberAccount: member.account,
        memberDomain: member.domain,
        memberNamespaceId: member.namespaceId,
        localMemberId: row.localMemberId,
        managerIds: row.managerIds,
        projectionDirections: row.projectionDirections,
        authorSide: 'A',
      },
    });
  }

  /** REQUESTED entry validation. `req + req/ack = ack`: a live application or an
   * outstanding invitation is completed by the ACK path with the authorization
   * row already in hand, so both entry states share one implementation. A
   * rostered member or a dissolved group is a silent no-op; every other reverse
   * state (none, REVOKED, expired) receives a fresh invitation. */
  private validateRequestInTx(
    tx: DatabaseTransaction,
    params: Extract<
      GroupAuthoredMembershipIntentCommand,
      { decision: 'REQUESTED' }
    >,
    pairId: bigint,
    threadLock: ThreadContentLock,
    row: AuthorizationRow,
  ): Promise<ValidatedDecision | undefined> {
    if (row.dissolvedAt) return Promise.resolve(undefined);
    if (!row.authorized)
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    if (row.isMember) return Promise.resolve(undefined);
    if (
      (row.memberIntentStatus === 'REQUESTED' && row.applicationPending) ||
      row.invitationOutstanding
    )
      return this.validateAcceptanceInTx(tx, params, pairId, threadLock, row);
    if (row.memberDomain === 'local' && row.localMemberId === null)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'invitation target is missing',
      );
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
    const member: Applicant = {
      account: row.memberAccount!,
      domain: row.memberDomain!,
      namespaceId: row.memberNamespaceId!,
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
        localDomain: this.config.domain,
        targetAccount: member.account,
        targetDomain: member.domain,
        targetNamespaceId: member.namespaceId,
        localTargetId: row.localMemberId,
        managerIds: row.managerIds,
        note: (params.note ?? '').slice(0, 255),
        requestedAt,
        expiresAt,
      },
    });
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
          peerDomain: context.member.domain,
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
  ): Promise<Map<string, bigint>> {
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
  ): Promise<Map<string, bigint>> {
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
      ? new Map([[context.member.domain, BigInt(row.recipientFeedId)]])
      : new Map();
  }

  private async applyRevocationInTx(
    context: Extract<ValidatedDecision, { kind: 'revocation' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
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
    // The REVOKED signal belongs only to the member's peer. Wake it after commit.
    return context.member.domain !== 'local' && row.recipientFeedId !== null
      ? new Map([[context.member.domain, BigInt(row.recipientFeedId)]])
      : new Map();
  }

  private async applyRequestInTx(
    context: Extract<ValidatedDecision, { kind: 'request' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
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
    // No meta-head admission: an invitation writes no GroupMeta facts. The
    // projection fan-out task is admitted only when manager rows changed.
    if (row.projectionChanged)
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId: context.params.threadId,
        groupAccount: context.authorization.account,
      });
    return context.member.domain !== 'local' && row.recipientFeedId !== null
      ? new Map([[context.member.domain, BigInt(row.recipientFeedId)]])
      : new Map();
  }
}
