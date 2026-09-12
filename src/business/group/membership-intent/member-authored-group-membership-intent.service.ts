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
import { memberAuthoredMembershipLocatorSql } from './member-authored-membership-locator-sql.js';
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
} from './group-membership-revocation-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from './group-membership-projection-fanout.js';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../../common/business-code.js';
import { BusinessException } from '../../../common/business.exception.js';
import { SERVER_MAX_GROUP_MEMBERS } from '../../../group/group-capacity.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import { loadFederationConfig } from '../../../federation/federation.config.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../shared/relationship-intent-state.js';

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
}

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
  private readonly config = loadFederationConfig();

  constructor(
    private readonly deps: MemberAuthoredGroupMembershipIntentDependencies,
  ) {}

  async execute(
    params: MemberAuthoredGroupMembershipIntentCommand,
  ): Promise<void> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if (!context) return;
      await this.applyInTx(context, clientUpdates);
    });
    if (clientUpdates.length === 0) return;
    try {
      this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn(
        'member-authored membership intent client-state wake failed',
        error,
      );
    }
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: MemberAuthoredGroupMembershipIntentCommand,
  ): Promise<ValidatedMembership | undefined> {
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
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
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    // Applications and acceptance skip a dissolved group entirely (the legacy
    // member intent never wrote positive directions into one); a REVOKED entry
    // proceeds so a pending application can still be withdrawn there.
    if (located.dissolvedAt && params.decision !== 'REVOKED') return undefined;
    const member = {
      account: located.memberAccount,
      domain: 'local',
      namespaceId: 0,
    };
    await lockBusinessAccountsInTx(tx, [
      { account: member.account, domain: member.domain },
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
    // The conflicting DO UPDATE always takes the row lock and mirrors the
    // legacy threadId rewrite, so no separate pair select follows.
    let pairId: bigint;
    if (params.decision === 'REQUESTED') {
      const minted = await tx.execute<{ id: string }>(sql`
        INSERT INTO "RelationshipPair"
          (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
           "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId")
        VALUES ('GROUP_MEMBER', 'GROUP', ${located.groupAccount}, ${located.groupDomain}, 0,
          'USER', ${member.account}, 'local', 0, ${params.threadId})
        ON CONFLICT ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
          "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
        DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
        RETURNING id
      `);
      pairId = BigInt(minted.rows[0]!.id);
    } else {
      const existing = (
        await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM "RelationshipPair"
        WHERE kind = 'GROUP_MEMBER' AND "threadId" = ${params.threadId}
          AND "endpointBType" = 'USER' AND "endpointBAccount" = ${member.account}
          AND "endpointBDomain" = 'local'
      `)
      ).rows[0];
      if (!existing)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'membership request not found',
        );
      pairId = BigInt(existing.id);
    }
    await tx.execute(
      sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId} ORDER BY "authorSide" FOR NO KEY UPDATE`,
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
          memberAccount: member.account,
          memberDomain: member.domain,
          memberNamespaceId: member.namespaceId,
        }),
      )
    ).rows[0];
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('membership commands require an authoritative group');
    if (!row.authorized)
      throw new BusinessException(
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
   * rostered member and a dangling side-B acceptance are satisfied no-ops; a
   * live application is refreshed; every other state receives a fresh or
   * renewed application. */
  private validateRequestInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | undefined {
    const { row } = base;
    if (row.isMember) return undefined;
    if (
      row.memberIntentStatus === 'ACCEPTED' &&
      !row.invitationOutstanding &&
      row.groupIntentStatus !== 'ACCEPTED'
    )
      return undefined;
    if (row.invitationOutstanding) return this.prepareAcceptanceInTx(base);
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
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
        localDomain: this.config.domain,
        memberAccount: row.memberAccount,
        localMemberId: row.localMemberId!,
        managerIds: row.managerIds,
        note: (base.params.note ?? '').slice(0, 255),
        requestedAt,
        expiresAt,
      },
    });
  }

  /** ACCEPTED entry: the member completes an outstanding invitation. A rostered
   * member is a satisfied no-op; everything else has nothing to accept. */
  private validateAcceptanceInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | undefined {
    const { row } = base;
    if (row.isMember) return undefined;
    if (!row.invitationOutstanding)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'no outstanding invitation',
      );
    if (
      !row.alreadyAuthorized &&
      row.authorizedCount >= SERVER_MAX_GROUP_MEMBERS
    )
      throw new BusinessException(
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
        localDomain: this.config.domain,
        memberAccount: row.memberAccount,
        memberDomain: row.memberDomain,
        memberNamespaceId: row.memberNamespaceId,
        note: row.groupIntentNote ?? '',
        acceptedAt: new Date(),
        managerIds: row.managerIds,
        projectionDirections: ['INVITATION'],
        authorMemberSide: true,
      },
    });
  }

  /** REVOKED entry: withdraw a live application, decline an outstanding
   * invitation, or leave the roster. A dissolved group keeps withdrawals (the
   * legacy REVOKED write never skipped them) but its departures belong to the
   * disband fan-out, exactly like the manager-side gate. */
  private validateRevocationInTx(
    base: ValidatedBase,
  ): Promise<ValidatedMembership> | undefined {
    const { row } = base;
    if (row.isMember && row.dissolvedAt)
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'group membership authority is unavailable',
      );
    if (!row.isMember && !row.applicationPending && !row.invitationOutstanding)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'membership request not found',
      );
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
        localDomain: this.config.domain,
        memberAccount: row.memberAccount,
        memberDomain: row.memberDomain,
        memberNamespaceId: row.memberNamespaceId,
        localMemberId: row.localMemberId,
        managerIds: row.managerIds,
        projectionDirections: row.projectionDirections,
        authorSide: 'B',
      },
    });
  }

  /** Shared branch epilogue: the Account row locks the composed statements'
   * feed allocations rely on, in the established id order. */
  private async finalizeValidationInTx(
    base: ValidatedBase,
    branch:
      | { kind: 'request'; input: MemberAuthoredMembershipRequestInput }
      | { kind: 'acceptance'; input: GroupMembershipAcceptanceInput }
      | { kind: 'revocation'; input: GroupMembershipRevocationInput },
  ): Promise<ValidatedMembership> {
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
  ): Promise<void> {
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
      return;
    }
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
      return;
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
      // No meta-head admission: an application writes no GroupMeta facts. The
      // projection fan-out task is admitted only when manager rows changed.
      if (row.projectionChanged)
        await admitGroupMembershipProjectionFanoutInTx(context.tx, {
          threadId: context.params.threadId,
          groupAccount: context.row.account,
        });
      return;
    }
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
