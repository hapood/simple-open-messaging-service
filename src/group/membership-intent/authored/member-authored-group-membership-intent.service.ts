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
import { memberAuthoredMembershipLocatorSql } from './member-authored-membership-locator-sql.js';
import { mintGroupMemberPairInTx } from '../shared/group-member-pair-mint.js';
import { lockGroupMemberIntentRowsInTx } from '../shared/group-member-intent-lock.js';
import {
  groupMembershipStateSql,
  type GroupMembershipStateRow,
} from '../shared/group-membership-state-sql.js';
import {
  memberAuthoredMembershipRequestSql,
  type MemberAuthoredMembershipRequestInput,
} from './member-authored-membership-request-sql.js';
import {
  groupMembershipRevocationSql,
  type GroupMembershipRevocationInput,
} from '../shared/group-membership-revocation-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from '../shared/group-membership-projection-fanout.js';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../../common/business-code.js';
import {
  type BusinessRejection,
  rejectBusinessCommand,
} from '../../../common/business-command-result.js';
import { SERVER_MAX_GROUP_MEMBERS } from '../../shared/group-capacity.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../../common/relationship-intent-state.js';
import type { QueryDeniedMembershipRevocationResult } from './group-authored-membership-intent.service.js';
import type { GroupRelationshipMutationService } from '../shared/group-relationship-mutation.service.js';
import type { FederationService } from '../../../federation/federation.service.js';
import { normalizeAccount } from '../../../common/account.js';
import { groupStateSql } from '../../shared/group-state.js';
import type { FederatedPendingProfileSnapshot } from '../../../relationship/relationship.service.js';
import { ensureMirrorGroupShellInTx } from '../../shared/ensure-mirror-group-shell-in-tx.js';

/** One command family: a local member's authored intent about their own group
 * membership — apply (REQUESTED), withdraw / decline / leave (REVOKED), and
 * accept an outstanding invitation (ACCEPTED). The group is addressed by its
 * thread; the pair is minted when the member has none yet. */
export type MemberAuthoredGroupMembershipIntentCommand =
  | {
      threadId: number;
      memberUserId: number;
      decision: 'REQUESTED';
      note?: string;
    }
  | {
      threadId: number;
      memberUserId: number;
      decision: 'ACCEPTED' | 'REVOKED';
      note?: never;
    };

export interface MemberAuthoredGroupMembershipIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  relationshipMutations: GroupRelationshipMutationService;
  federation: Pick<FederationService, 'pushStateFeedNamespaces'>;
}

export interface MemberAuthoredGroupMembershipIntentOptions {
  admissionInTx?: (tx: DatabaseTransaction) => Promise<void>;
  mirrorGroupSnapshot?: FederatedPendingProfileSnapshot;
}

export type MemberAuthoredGroupMembershipIntentResult =
  | { status: 'APPLIED' }
  | {
      status: 'NO_OP';
      reason: 'ALREADY_MEMBER' | 'ALREADY_SATISFIED';
    }
  | BusinessRejection;

const validated = Symbol('validated group membership decision');

/** The lock-and-locate product every branch validation starts from. */
type ValidatedBase = {
  readonly [validated]: true;
  readonly tx: DatabaseTransaction;
  readonly params: MemberAuthoredGroupMembershipIntentCommand;
  readonly threadLock: ThreadContentLock;
  readonly row: GroupMembershipStateRow;
};

/** Lexical capability, created only after locks and authorization. */
type ValidatedMembership = ValidatedBase &
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
        readonly input: MemberAuthoredMembershipRequestInput;
      }
    | {
        readonly kind: 'mirror-positive';
        readonly authoredStatus: 'REQUESTED' | 'ACCEPTED';
        readonly note: string;
      }
    | { readonly kind: 'mirror-revocation' }
  );

/** Application service for the member-authored group-membership intent family.
 * The public entry owns the transaction; internal updates consume its validated
 * lock capability. The local member owns the Account State scope; the Pair
 * protects both membership intents and relationship-derived projections. No
 * outbound namespace allocator exists on this authoritative-local-group path;
 * the admitted projection fan-out task owns per-manager notification. */
export class MemberAuthoredGroupMembershipIntentService {
  private readonly logger = new Logger(
    MemberAuthoredGroupMembershipIntentService.name,
  );
  constructor(
    private readonly deps: MemberAuthoredGroupMembershipIntentDependencies,
  ) {}

  async execute(
    params: MemberAuthoredGroupMembershipIntentCommand,
    options?: MemberAuthoredGroupMembershipIntentOptions,
  ): Promise<MemberAuthoredGroupMembershipIntentResult> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const applied = await this.deps.database.db.transaction((tx) =>
      this.executeInTx(tx, params, clientUpdates, options),
    );
    this.publishApplied(applied, clientUpdates);
    return applied.outcome;
  }

  async executeAddressed(params: {
    memberUserId: number;
    target: { account: string; domain: string };
    decision: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
    note?: string;
    snapshot?: FederatedPendingProfileSnapshot;
    admissionInTx?: (tx: DatabaseTransaction) => Promise<void>;
  }): Promise<MemberAuthoredGroupMembershipIntentResult> {
    const account = normalizeAccount(params.target.account);
    const domain = params.target.domain.trim().toLowerCase();
    if (!account.startsWith('!'))
      return this.reject(
        'GROUP_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'group not found',
      );
    const storedDomain = domain;
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const applied = await this.deps.database.db.transaction(async (tx) => {
      const namespaceId =
        storedDomain === 'local'
          ? 0
          : (
              await tx.execute<{ namespaceId: number }>(sql`
                SELECT ns.id AS "namespaceId"
                FROM "IdentityNamespace" ns
                WHERE ns.domain = ${storedDomain}
                  AND ns.active = true
                  AND ns."retiredAt" IS NULL
              `)
            ).rows[0]?.namespaceId;
      if (namespaceId === undefined)
        return {
          outcome: this.reject(
            'GROUP_NOT_FOUND',
            BusinessCode.NOT_FOUND,
            'group not found',
          ),
          peers: new Map<number, bigint>(),
        };
      const member = (
        await tx.execute<{ account: string }>(sql`
          SELECT account FROM "Account"
          WHERE id = ${params.memberUserId} AND domain = 'local'
            AND "namespaceId" = 0
        `)
      ).rows[0];
      if (!member)
        return {
          outcome: this.reject(
            'ACTOR_NOT_FOUND',
            BusinessCode.NOT_FOUND,
            'authenticated member is missing',
          ),
          peers: new Map<number, bigint>(),
        };
      await lockBusinessAccountsInTx(tx, [
        { account, profileNamespaceId: namespaceId },
        { account: member.account, profileNamespaceId: 0 },
      ]);
      let located = (
        await tx.execute<{ threadId: number }>(sql`
          SELECT g.id AS "threadId" FROM ${groupStateSql} g
          WHERE g.account = ${account} AND g.domain = ${storedDomain}
            AND g."namespaceId" = ${namespaceId}
        `)
      ).rows[0];
      if (
        !located &&
        params.decision === 'REQUESTED' &&
        storedDomain !== 'local'
      )
        located = await ensureMirrorGroupShellInTx(tx, {
          account,
          domain: storedDomain,
          namespaceId,
        });
      if (!located)
        return {
          outcome: this.reject(
            'GROUP_NOT_FOUND',
            BusinessCode.INVITE_NOT_FOUND,
            'group request not found',
          ),
          peers: new Map<number, bigint>(),
        };
      const command: MemberAuthoredGroupMembershipIntentCommand =
        params.decision === 'REQUESTED'
          ? {
              threadId: located.threadId,
              memberUserId: params.memberUserId,
              decision: 'REQUESTED',
              ...(params.note ? { note: params.note } : {}),
            }
          : {
              threadId: located.threadId,
              memberUserId: params.memberUserId,
              decision: params.decision,
            };
      return this.executeInTx(tx, command, clientUpdates, {
        ...(params.admissionInTx
          ? { admissionInTx: params.admissionInTx }
          : {}),
        ...(params.snapshot ? { mirrorGroupSnapshot: params.snapshot } : {}),
      });
    });
    this.publishApplied(applied, clientUpdates);
    return applied.outcome;
  }

  /** Local-member-authored revocation after the mirrored group authority
   * denied a thread query. The captured generation is checked by the normal
   * locked mutation writer before any intent or projection write. */
  async executeQueryDeniedRevocation(params: {
    threadId: number;
    group: { account: string; domain: string; namespaceId: number };
    memberUserId: number;
    expectedAuthorizationEpoch: number;
  }): Promise<QueryDeniedMembershipRevocationResult> {
    if (params.group.domain === 'local')
      throw new Error('query-denied member revocation requires a mirror group');
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      // Entry-scope advisory before the writer's row locks; nested writers
      // never take advisories themselves.
      await lockBusinessAccountsInTx(tx, [
        { account: params.group.account, profileNamespaceId: params.group.namespaceId },
      ]);
      return this.deps.relationshipMutations.writeMemberRelationshipIntentInTx(
        tx,
        params.threadId,
        params.memberUserId,
        'REVOKED',
        clientUpdates,
        '',
        undefined,
        {
          expectedAuthorization: {
            epoch: params.expectedAuthorizationEpoch,
            group: params.group,
          },
        },
      );
    });
    const outcome =
      peers.size > 0 || clientUpdates.length > 0
        ? ({ status: 'APPLIED' } as const)
        : ({
            status: 'NO_OP',
            reason: 'STALE_OR_ALREADY_REVOKED',
          } as const);
    this.publishApplied({ outcome, peers }, clientUpdates);
    return outcome;
  }

  private async executeInTx(
    tx: DatabaseTransaction,
    params: MemberAuthoredGroupMembershipIntentCommand,
    clientUpdates: PendingClientStateFeedUpdate[],
    options?: MemberAuthoredGroupMembershipIntentOptions,
  ): Promise<{
    outcome: MemberAuthoredGroupMembershipIntentResult;
    peers: Map<number, bigint>;
  }> {
    const context = await this.lockAndValidateInTx(tx, params);
    if ('status' in context)
      return { outcome: context, peers: new Map<number, bigint>() };
    await options?.admissionInTx?.(tx);
    return {
      outcome: { status: 'APPLIED' },
      peers: await this.applyInTx(
        context,
        clientUpdates,
        options?.mirrorGroupSnapshot,
      ),
    };
  }

  private publishApplied(
    applied: {
      outcome: { status: string };
      peers: Map<number, bigint>;
    },
    clientUpdates: PendingClientStateFeedUpdate[],
  ): void {
    if (applied.outcome.status !== 'APPLIED') return;
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn(
        'member-authored membership intent client-state wake failed',
        error,
      );
    }
    if (applied.peers.size > 0)
      void this.deps.federation.pushStateFeedNamespaces(applied.peers.keys());
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: MemberAuthoredGroupMembershipIntentCommand,
  ): Promise<ValidatedMembership | MemberAuthoredGroupMembershipIntentResult> {
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        groupNamespaceId: number;
        dissolvedAt: string | null;
        memberAccount: string;
      }>(
        memberAuthoredMembershipLocatorSql({
          threadId: params.threadId,
          memberUserId: params.memberUserId,
        }),
      )
    ).rows[0];
    if (!located)
      return this.reject(
        'GROUP_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'group not found',
      );
    // Applications and acceptance skip a dissolved authoritative group; a REVOKED entry
    // proceeds so a pending application can still be withdrawn there.
    if (
      located.groupDomain === 'local' &&
      located.dissolvedAt &&
      params.decision !== 'REVOKED'
    )
      return this.reject(
        'GROUP_DISSOLVED',
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    const member = {
      account: located.memberAccount,
      domain: 'local',
      // The member endpoint is always local on this server: namespace 0.
      namespaceId: 0,
    };
    const groupNamespaceId =
      located.groupDomain === 'local' ? 0 : located.groupNamespaceId;
    // The group scope rides along with the member's: the thread row lock below
    // must never be held without it, or the nested mutation writers' late
    // advisory acquisition deadlocks against the advisory-holding fan-out tasks.
    await lockBusinessAccountsInTx(tx, [
      { account: located.groupAccount, profileNamespaceId: groupNamespaceId },
      { account: member.account, profileNamespaceId: 0 },
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
    // Mint the canonical pair when the member has none yet (REQUESTED only).
    // The conflicting DO UPDATE always takes the row lock and rewrites the
    // canonical thread binding, so no separate pair select follows.
    let pairId: bigint;
    if (params.decision === 'REQUESTED') {
      pairId = await mintGroupMemberPairInTx(tx, {
        threadId: params.threadId,
        groupAccount: located.groupAccount,
        groupNamespaceId,
        memberAccount: member.account,
        profileNamespaceId: 0,
      });
    } else {
      // The pair's local endpoint is the member; the group sits on B with its
      // own namespace (0 for a locally hosted group).
      const existing = (
        await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM "RelationshipPair"
        WHERE kind = 'GROUP_MEMBER' AND "threadId" = ${params.threadId}
          AND "endpointAType" = 'USER' AND "endpointAAccount" = ${member.account}
          AND "endpointANamespaceId" = 0
          AND "endpointBType" = 'GROUP' AND "endpointBAccount" = ${located.groupAccount}
          AND "endpointBNamespaceId" = ${groupNamespaceId}
      `)
      ).rows[0];
      if (!existing)
        return this.reject(
          'INTENT_NOT_FOUND',
          BusinessCode.NOT_FOUND,
          'membership request not found',
        );
      pairId = BigInt(existing.id);
    }
    await lockGroupMemberIntentRowsInTx(
      tx,
      { account: located.groupAccount, namespaceId: groupNamespaceId },
      { account: member.account, namespaceId: 0 },
    );
    // The member's own AccountThreadState is the only participant row these
    // commands write; manager watermarks move through the fan-out task.
    await tx.execute(
      sql`SELECT participant.id FROM "AccountThreadState" participant
        JOIN "Account" owner ON owner.id = participant."accountId"
        WHERE participant."threadId" = ${params.threadId}
          AND owner.id = ${params.memberUserId}
        ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
      `,
    );
    // One statement both creates the group allocator row and takes its row lock
    // (the conflicting DO UPDATE self-assignment), keeping the
    // allocator-before-Account ordering without a second round trip. All
    // commands allocate: an application advances the application projection
    // counter, an acceptance writes meta facts, a revocation writes the
    // departure fact.
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${params.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    const row = (
      await tx.execute<GroupMembershipStateRow>(
        groupMembershipStateSql({
          threadId: params.threadId,
          pairId,
          actorUserId: params.memberUserId,
          groupAccount: located.groupAccount,
          groupNamespaceId,
          memberAccount: member.account,
          profileNamespaceId: 0,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('membership authorization disappeared');
    if (row.domain === 'local' && row.namespaceId !== 0)
      throw new Error('local group has a non-local namespace');
    if (!row.authorized)
      return this.reject(
        'ACTOR_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'authenticated member is missing',
      );
    if (row.localMemberId === null) throw new Error('local member is missing');
    const base: ValidatedBase = {
      [validated]: true,
      tx,
      params,
      threadLock,
      row,
    };
    if (params.decision === 'REQUESTED') return this.validateRequestInTx(base);
    if (params.decision === 'ACCEPTED')
      return this.validateAcceptanceInTx(base);
    return this.validateRevocationInTx(base);
  }

  /** REQUESTED entry. `req + req = ack` on this side: an outstanding invitation
   * is completed by the acceptance path with the authorization row in hand. A
   * pair-active member and a dangling side-B acceptance are satisfied no-ops; a
   * live application is refreshed; every other state receives a fresh or
   * renewed application. */
  private validateRequestInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | MemberAuthoredGroupMembershipIntentResult {
    const { row } = base;
    if (row.pairActive) return { status: 'NO_OP', reason: 'ALREADY_MEMBER' };
    if (
      row.memberIntentStatus === 'ACCEPTED' &&
      !row.invitationOutstanding &&
      row.groupIntentStatus !== 'ACCEPTED'
    )
      return { status: 'NO_OP', reason: 'ALREADY_SATISFIED' };
    if (row.invitationOutstanding) return this.prepareAcceptanceInTx(base);
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
    if (row.domain !== 'local')
      return this.finalizeValidationInTx(base, {
        kind: 'mirror-positive',
        authoredStatus: 'REQUESTED',
        note: (base.params.note ?? '').slice(0, 255),
      });
    return this.finalizeValidationInTx(base, {
      kind: 'request',
      input: {
        threadId: base.params.threadId,
        pairId: BigInt(row.pairId),
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        memberAccount: row.memberAccount,
        profileNamespaceId: 0,
        localMemberId: row.localMemberId!,
        note: (base.params.note ?? '').slice(0, 255),
        requestedAt,
        expiresAt,
      },
    });
  }

  /** ACCEPTED entry: the member completes an outstanding invitation. A pair-active
   * member is a satisfied no-op; everything else has nothing to accept. */
  private validateAcceptanceInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | MemberAuthoredGroupMembershipIntentResult {
    const { row } = base;
    if (row.pairActive) return { status: 'NO_OP', reason: 'ALREADY_MEMBER' };
    if (!row.invitationOutstanding)
      return this.reject(
        row.groupIntentStatus === 'REQUESTED'
          ? 'INTENT_EXPIRED'
          : 'INTENT_NOT_FOUND',
        row.groupIntentStatus === 'REQUESTED'
          ? BusinessCode.INVITE_EXPIRED
          : BusinessCode.NOT_FOUND,
        row.groupIntentStatus === 'REQUESTED'
          ? 'group invitation has expired'
          : 'no outstanding invitation',
      );
    if (
      row.domain === 'local' &&
      !row.alreadyAuthorized &&
      row.authorizedCount >= SERVER_MAX_GROUP_MEMBERS
    )
      return this.reject(
        'GROUP_FULL',
        BusinessCode.GROUP_FULL,
        `group invitations, including pending invitations, have reached the ${SERVER_MAX_GROUP_MEMBERS}-person limit`,
      );
    return this.prepareAcceptanceInTx(base);
  }

  /** The composed membership activation. Completing an invitation preserves the
   * group's own note, flips the INVITATION projection rows, and authors side B
   * in the same statement — the member's ack is the family's only side B
   * ACCEPTED writer. */
  private prepareAcceptanceInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> {
    const { row } = base;
    if (row.domain !== 'local')
      return this.finalizeValidationInTx(base, {
        kind: 'mirror-positive',
        authoredStatus: 'ACCEPTED',
        note: row.groupIntentNote ?? '',
      });
    return this.finalizeValidationInTx(base, {
      kind: 'acceptance',
      input: {
        pairId: BigInt(row.pairId),
        threadId: base.params.threadId,
        groupAccount: row.account,
        groupProfileRev: row.profileRev,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        memberAccount: row.memberAccount,
        profileNamespaceId: row.profileNamespaceId,
        note: row.groupIntentNote ?? '',
        acceptedAt: new Date(),
        projectionDirections: ['INVITATION'],
        memberAck: true,
      },
    });
  }

  /** REVOKED entry: withdraw a live application, decline an outstanding
   * invitation, or leave an active pair. A dissolved group still permits
   * withdrawals, but active-member departures belong to the
   * disband fan-out, exactly like the manager-side gate. */
  private validateRevocationInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | MemberAuthoredGroupMembershipIntentResult {
    const { row } = base;
    if (row.pairActive && row.dissolvedAt)
      return this.reject(
        'GROUP_DISSOLVED',
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    if (
      !row.pairActive &&
      !row.applicationPending &&
      !row.invitationOutstanding
    )
      return this.reject(
        row.memberIntentStatus === 'REQUESTED' ||
          row.groupIntentStatus === 'REQUESTED'
          ? 'INTENT_EXPIRED'
          : 'INTENT_NOT_FOUND',
        row.memberIntentStatus === 'REQUESTED' ||
          row.groupIntentStatus === 'REQUESTED'
          ? BusinessCode.INVITE_EXPIRED
          : BusinessCode.NOT_FOUND,
        row.memberIntentStatus === 'REQUESTED' ||
          row.groupIntentStatus === 'REQUESTED'
          ? 'membership request has expired'
          : 'membership request not found',
      );
    if (row.domain !== 'local')
      return this.finalizeValidationInTx(base, {
        kind: 'mirror-revocation',
      });
    return this.finalizeValidationInTx(base, {
      kind: 'revocation',
      input: {
        threadId: base.params.threadId,
        pairId: BigInt(row.pairId),
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        memberAccount: row.memberAccount,
        profileNamespaceId: row.profileNamespaceId,
        localMemberId: row.localMemberId,
        projectionDirections: row.projectionDirections,
        author: {
          account: row.memberAccount,
          namespaceId: row.profileNamespaceId,
        },
        receiver: { account: row.account, namespaceId: 0 },
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

  /** Shared branch epilogue: the Account row locks the composed statements'
   * feed allocations rely on, in the established id order. */
  private async finalizeValidationInTx(
    base: ValidatedBase,
    branch:
      | { kind: 'request'; input: MemberAuthoredMembershipRequestInput }
      | { kind: 'acceptance'; input: GroupMembershipAcceptanceInput }
      | { kind: 'revocation'; input: GroupMembershipRevocationInput }
      | {
          kind: 'mirror-positive';
          authoredStatus: 'REQUESTED' | 'ACCEPTED';
          note: string;
        }
      | { kind: 'mirror-revocation' },
  ): Promise<ValidatedMembership> {
    if (
      branch.kind === 'mirror-positive' ||
      branch.kind === 'mirror-revocation'
    )
      await this.deps.relationshipMutations.lockMemberRelationshipFeedInTx(
        base.tx,
        {
          domain: base.row.domain,
          namespaceId: base.row.namespaceId,
        },
      );
    const accounts = [...base.row.managerIds, base.row.localMemberId!];
    await base.tx.execute(
      sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(accounts)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
    );
    return {
      ...base,
      ...branch,
    };
  }

  private async applyInTx(
    context: ValidatedMembership,
    clientUpdates: PendingClientStateFeedUpdate[],
    mirrorGroupSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Map<number, bigint>> {
    if (context[validated] !== true || context.threadLock.tx !== context.tx)
      throw new Error('invalid group membership lock context');
    if (context.kind === 'acceptance') {
      const result = await context.tx.execute<{
        canonicalRosterChanged: boolean;
        audienceChanged: boolean;
        systemMessageSeq: number | null;
        recipientFeedId: string | null;
        recipientUserId: number | null;
        invalidPeerHead: boolean;
      }>(groupMembershipAcceptanceSql(context.input));
      const row = result.rows[0];
      if (!row) throw new Error('membership acceptance update disappeared');
      if (row.invalidPeerHead) throw new Error('conflicting peer content head');
      pushRecipient(row.recipientUserId, row.recipientFeedId, clientUpdates);
      return new Map();
    }
    if (context.kind === 'mirror-revocation')
      return this.deps.relationshipMutations.writeMemberRelationshipIntentInTx(
        context.tx,
        context.params.threadId,
        context.params.memberUserId,
        'REVOKED',
        clientUpdates,
        '',
        undefined,
        {
          lockedGroupPair: {
            pairId: BigInt(context.row.pairId),
            threadLock: context.threadLock,
          },
          validatedPairActive: false,
          ...(context.row.applicationPending
            ? {
                clientRequestStatus: 'WITHDRAWN' as const,
                clientRequestDirection: 'OUTGOING' as const,
              }
            : context.row.invitationOutstanding
              ? {
                  clientRequestStatus: 'REJECTED' as const,
                  clientRequestDirection: 'INCOMING' as const,
                }
              : {}),
        },
      );
    if (context.kind === 'mirror-positive')
      return this.deps.relationshipMutations.writeMemberRelationshipIntentInTx(
        context.tx,
        context.params.threadId,
        context.params.memberUserId,
        context.authoredStatus,
        clientUpdates,
        context.note,
        mirrorGroupSnapshot,
        {
          allowDissolvedPositive: true,
          lockedGroupPair: {
            pairId: BigInt(context.row.pairId),
            threadLock: context.threadLock,
          },
          validatedPairActive:
            context.authoredStatus === 'ACCEPTED' ? true : undefined,
        },
      );
    if (context.kind === 'revocation') {
      const result = await context.tx.execute<{
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
      if (!row) throw new Error('membership revocation update disappeared');
      pushRecipient(row.recipientUserId, row.recipientFeedId, clientUpdates);
      if (row.pairChanged) {
        return this.deps.relationshipMutations.writeGroupRelationshipIntentInTx(
          context.tx,
          context.params.threadId,
          context.params.memberUserId,
          '',
          'REVOKED',
          clientUpdates,
        );
      }
      return new Map();
    }
    if (context.kind === 'request') {
      const result = await context.tx.execute<{
        requestId: string;
        status: string;
        note: string;
        intentChanged: boolean;
        projectionChanged: boolean;
        recipientUserId: number | null;
        recipientFeedId: string | null;
      }>(memberAuthoredMembershipRequestSql(context.input));
      const row = result.rows[0];
      if (!row) throw new Error('membership application update disappeared');
      pushRecipient(row.recipientUserId, row.recipientFeedId, clientUpdates);
      // No thread-head admission: an application writes no GroupMeta facts. The
      // projection fan-out task is admitted only when manager rows changed.
      if (row.projectionChanged)
        await admitGroupMembershipProjectionFanoutInTx(context.tx, {
          threadId: context.params.threadId,
          groupAccount: context.row.account,
        });
      return new Map();
    }
    throw new Error('invalid group membership intent branch');
  }
}

function pushRecipient(
  userId: number | null,
  feedId: string | null,
  clientUpdates: PendingClientStateFeedUpdate[],
): void {
  if (userId !== null && feedId !== null)
    clientUpdates.push({ userId, feedId: Number(feedId) });
}
