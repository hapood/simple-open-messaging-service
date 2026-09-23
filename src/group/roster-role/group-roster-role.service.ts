import { and, eq, sql } from 'drizzle-orm';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../common/locks/thread-content-lock.js';
import {
  groupRosterRoleAuthorizationSql,
  groupRosterRoleLocatorSql,
  type GroupRosterRoleAuthorizationRow,
} from './group-roster-role-authorization-sql.js';
import { admitGroupMembershipProjectionFanoutInTx } from '../membership-intent/shared/group-membership-projection-fanout.js';
import { enqueueCurrentThreadFanoutsInTx } from '../../message/thread-fanout-task.js';
import { GroupRole } from '../../database/enums.js';
import { accountThreadState } from '../../database/schema.js';
import { BusinessCode } from '../../common/business-code.js';
import { normalizeAccount } from '../../common/account.js';
import type { BusinessRejection } from '../../common/business-command-result.js';
import { rejectBusinessCommand } from '../../common/business-command-result.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../database/database.service.js';
import type { GroupMetaFeedService } from '../meta/group-meta-feed.service.js';
import type { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../../shared/system-message-content.js';
import { transitionGroupManagerProjection } from '../shared/group-manager-projection.js';

/** One command family: the group's canonical roster role facts, authored by
 * its owner. Ownership transfer promotes the target and leaves the previous
 * owner as an administrator; SET_ROLE moves one member between ADMIN and
 * MEMBER. Targets are addressed; the roster names their authoritative identity. */
export type GroupRosterRoleCommand =
  | {
      threadId: number;
      operatorUserId: number;
      kind: 'TRANSFER_OWNERSHIP';
      target: { account: string; domain: string };
      role?: never;
    }
  | {
      threadId: number;
      operatorUserId: number;
      kind: 'SET_ROLE';
      target: { account: string; domain: string };
      role: GroupRole;
    };

/** Outcome for the HTTP surface: refusals are data (the controller envelopes
 * them); only unexpected state throws through the exception pipeline. */
export type GroupRosterRoleOutcome =
  | { status: 'APPLIED' }
  | { status: 'NO_OP'; reason: 'ROLE_UNCHANGED' }
  | BusinessRejection;

/** The in-transaction result of a command that wrote nothing. */
type RosterRoleRefusal = Exclude<GroupRosterRoleOutcome, { status: 'APPLIED' }>;

export interface GroupRosterRoleDependencies {
  database: DatabaseService;
  groupMeta: Pick<GroupMetaFeedService, 'reconcileMembersInTx'>;
  messages: Pick<MessageService, 'writeSystemMessageInTx'>;
}

interface RosterRoleChange {
  account: string;
  domain: string;
  namespaceId: number;
  previousRole: GroupRole;
  role: GroupRole;
  profileRev: number;
  /** Local Account.id to project the role onto, or null for a peer member. */
  localId: number | null;
}

const validated = Symbol('validated roster role command');

/** Lexical capability, created only after locks and authorization. Mutable
 * roster state is not cached. */
interface ValidatedRosterRole {
  readonly [validated]: true;
  readonly tx: DatabaseTransaction;
  readonly threadId: number;
  readonly groupAccount: string;
  readonly threadLock: ThreadContentLock;
  readonly changes: readonly RosterRoleChange[];
  readonly systemMessage:
    | {
        type: typeof SystemMessageType.GROUP_OWNER_TRANSFERRED;
        previousOwner: {
          account: string;
          domain: string;
          namespaceId: number;
          profileRev: number;
        };
        newOwner: {
          account: string;
          domain: string;
          namespaceId: number;
          profileRev: number;
        };
      }
    | {
        type:
          | typeof SystemMessageType.GROUP_ADMIN_GRANTED
          | typeof SystemMessageType.GROUP_ADMIN_REVOKED;
        member: {
          account: string;
          domain: string;
          namespaceId: number;
          profileRev: number;
        };
      };
}

/** Application service for the roster-role command family. The public entry
 * owns the transaction; internal updates consume its validated lock capability.
 * The group's Account State scope is the only account scope: role facts live in
 * the canonical Group Meta roster, and every competing writer (both authored
 * directions) serializes on the GroupMeta allocator row this transaction takes
 * before its authorization read. */
export class GroupRosterRoleService {
  constructor(private readonly deps: GroupRosterRoleDependencies) {}

  async execute(
    params: GroupRosterRoleCommand,
  ): Promise<GroupRosterRoleOutcome> {
    return this.deps.database.db.transaction(async (tx) => {
      const validated = await this.lockAndValidateInTx(tx, params);
      if ('outcome' in validated) return validated.outcome;
      await this.applyInTx(validated);
      return { status: 'APPLIED' };
    });
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupRosterRoleCommand,
  ): Promise<ValidatedRosterRole | { outcome: RosterRoleRefusal }> {
    const target = {
      account: normalizeAccount(params.target.account),
      domain: params.target.domain.trim().toLowerCase(),
    };
    if (params.kind === 'SET_ROLE' && params.role === GroupRole.OWNER)
      return {
        outcome: forbidden('use transfer to change ownership'),
      };
    // One pre-lock locator: the group address names the only business scope.
    // It authorizes nothing; every mutable state is re-read under the locks.
    const located = (
      await tx.execute<{ groupAccount: string; groupDomain: string }>(
        groupRosterRoleLocatorSql({ threadId: params.threadId }),
      )
    ).rows[0];
    if (!located) return { outcome: notFound() };
    await lockBusinessAccountsInTx(tx, [
      { account: located.groupAccount, domain: located.groupDomain },
    ]);
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.threadId,
      params.threadId,
    );
    // One statement creates the group allocator row and takes its row lock
    // (the conflicting DO UPDATE self-assignment), so this authorization read
    // is ordered against every other roster writer without a second round trip.
    await tx.execute(
      sql`INSERT INTO "GroupMeta" ("threadId") VALUES (${params.threadId})
        ON CONFLICT ("threadId") DO UPDATE SET "updatedAt" = "GroupMeta"."updatedAt"
        RETURNING "threadId"`,
    );
    // The local projections these commands write, locked in account order.
    await tx.execute(
      sql`SELECT participant.id FROM "AccountThreadState" participant
        JOIN "Account" owner ON owner.id = participant."accountId"
        WHERE participant."threadId" = ${params.threadId}
          AND (owner.id = ${params.operatorUserId}
            OR (owner.account = ${target.account} AND ${target.domain} = 'local'))
        ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
      `,
    );
    const row = (
      await tx.execute<GroupRosterRoleAuthorizationRow>(
        groupRosterRoleAuthorizationSql({
          threadId: params.threadId,
          operatorUserId: params.operatorUserId,
          targetAccount: target.account,
          targetDomain: target.domain,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('group roster state disappeared under the locks');
    if (row.groupDomain !== 'local' || row.namespaceId !== 0)
      return {
        outcome: forbidden('group role authority is unavailable'),
      };
    if (row.dissolvedAt)
      return {
        outcome: rejectBusinessCommand(
          'GROUP_DISSOLVED',
          BusinessCode.GROUP_DISSOLVED,
          'group has been dissolved',
        ),
      };
    if (
      !row.operatorAccount ||
      row.operatorRole !== GroupRole.OWNER ||
      !row.operatorAuthorized
    )
      return {
        outcome: forbidden(
          params.kind === 'TRANSFER_OWNERSHIP'
            ? 'only the current owner may transfer ownership'
            : 'only the group owner may change administrator roles',
        ),
      };
    const operator: RosterRoleChange = {
      account: row.operatorAccount,
      domain: 'local',
      namespaceId: 0,
      previousRole: GroupRole.OWNER,
      role: GroupRole.ADMIN,
      profileRev: requireProfileRev(row.operatorProfileRev, 'operator'),
      localId: params.operatorUserId,
    };
    const selfTarget =
      target.domain === 'local' && target.account === row.operatorAccount;
    if (params.kind === 'TRANSFER_OWNERSHIP') {
      if (selfTarget)
        return { outcome: forbidden('cannot transfer ownership to yourself') };
      if (!row.targetAccount || !row.targetActive)
        return { outcome: targetNotMember() };
      // Ownership can't cross servers — the owner must stay on the origin
      // (the roster authority).
      if (row.targetDomain !== 'local')
        return {
          outcome: forbidden(
            'cannot transfer ownership to a member on another server',
          ),
        };
      if (row.targetRole === GroupRole.OWNER)
        return { outcome: forbidden('target is already the owner') };
      if (row.localTargetId === null)
        throw new Error('local roster target is missing');
      const newOwner: RosterRoleChange = {
        account: row.targetAccount,
        domain: row.targetDomain,
        namespaceId: row.targetNamespaceId!,
        previousRole: row.targetRole!,
        role: GroupRole.OWNER,
        profileRev: requireProfileRev(row.targetProfileRev, 'target'),
        localId: row.localTargetId,
      };
      return {
        [validated]: true,
        tx,
        threadId: params.threadId,
        groupAccount: row.groupAccount,
        threadLock,
        changes: [operator, newOwner],
        systemMessage: {
          type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
          previousOwner: {
            account: operator.account,
            domain: 'local',
            namespaceId: 0,
            profileRev: operator.profileRev,
          },
          newOwner: {
            account: newOwner.account,
            domain: newOwner.domain,
            namespaceId: newOwner.namespaceId,
            profileRev: newOwner.profileRev,
          },
        },
      };
    }
    if (selfTarget)
      return { outcome: forbidden('cannot change your own role') };
    if (!row.targetAccount || !row.targetActive)
      return { outcome: targetNotMember() };
    if (row.targetRole === GroupRole.OWNER)
      return { outcome: forbidden("cannot change the owner's role") };
    // Privileged roles must remain on the origin (the roster authority).
    if (params.role === GroupRole.ADMIN && row.targetDomain !== 'local')
      return {
        outcome: forbidden(
          'cannot grant administrator role to a member on another server',
        ),
      };
    if (row.targetRole === params.role)
      return { outcome: { status: 'NO_OP', reason: 'ROLE_UNCHANGED' } };
    if (row.targetDomain === 'local' && row.localTargetId === null)
      throw new Error('local roster target is missing');
    const change: RosterRoleChange = {
      account: row.targetAccount,
      domain: row.targetDomain!,
      namespaceId: row.targetNamespaceId!,
      previousRole: row.targetRole!,
      role: params.role,
      profileRev: requireProfileRev(row.targetProfileRev, 'target'),
      localId: row.localTargetId,
    };
    return {
      [validated]: true,
      tx,
      threadId: params.threadId,
      groupAccount: row.groupAccount,
      threadLock,
      changes: [change],
      systemMessage: {
        type:
          params.role === GroupRole.ADMIN
            ? SystemMessageType.GROUP_ADMIN_GRANTED
            : SystemMessageType.GROUP_ADMIN_REVOKED,
        member: {
          account: change.account,
          domain: change.domain,
          namespaceId: change.namespaceId,
          profileRev: change.profileRev,
        },
      },
    };
  }

  private async applyInTx(context: ValidatedRosterRole): Promise<void> {
    if (context[validated] !== true || context.threadLock.tx !== context.tx)
      throw new Error('invalid roster role lock context');
    const { tx } = context;
    // Canonical roster facts. The reconcile diffs against history, so a fact
    // that a concurrent writer already applied consumes no feed position.
    await this.deps.groupMeta.reconcileMembersInTx(
      tx,
      context.threadId,
      context.changes.map((change) => ({
        account: change.account,
        domain: change.domain,
        operation: 'UPSERT' as const,
        body: { role: change.role, profileRev: change.profileRev },
      })),
    );
    // Local role projections, in account order.
    const now = new Date();
    for (const change of [...context.changes]
      .filter((change) => change.localId !== null)
      .sort((a, b) => a.localId! - b.localId!)) {
      const managerProjection = transitionGroupManagerProjection(
        change.previousRole,
        change.role,
        {
          applicationEndId: sql`(SELECT "applicationEndId" FROM "GroupMeta" WHERE "threadId" = ${context.threadId})`,
          invitationEndId: sql`(SELECT "invitationEndId" FROM "GroupMeta" WHERE "threadId" = ${context.threadId})`,
        },
      );
      await tx
        .update(accountThreadState)
        .set({
          ...managerProjection,
          role: change.role,
          updatedAt: now,
        })
        .where(
          and(
            eq(accountThreadState.accountId, change.localId!),
            eq(accountThreadState.threadId, context.threadId),
          ),
        );
    }
    // The system event is the members' notification vehicle; it admits the
    // local thread fan-out itself, and the head republish below advances the
    // federation one so peer-hosted members see the new roster head too.
    await this.deps.messages.writeSystemMessageInTx(
      tx,
      context.threadId,
      context.systemMessage,
      { threadLock: context.threadLock },
    );
    await enqueueCurrentThreadFanoutsInTx(tx, context.threadLock);
    // The manager set changed with the roles; the projection fan-out task
    // rebuilds each manager's join-request watermark after commit.
    await admitGroupMembershipProjectionFanoutInTx(tx, {
      threadId: context.threadId,
      groupAccount: context.groupAccount,
    });
  }
}

function requireProfileRev(profileRev: number | null, side: string): number {
  if (
    profileRev === null ||
    !Number.isSafeInteger(profileRev) ||
    profileRev < 0
  )
    throw new Error(`roster ${side} has an invalid profile revision`);
  return profileRev;
}

function forbidden(message: string): BusinessRejection {
  return rejectBusinessCommand(
    'FORBIDDEN',
    BusinessCode.GROUP_FORBIDDEN,
    message,
  );
}

function targetNotMember(): BusinessRejection {
  return rejectBusinessCommand(
    'TARGET_NOT_FOUND',
    BusinessCode.GROUP_TARGET_NOT_MEMBER,
    'target is not an active member',
  );
}

function notFound(): BusinessRejection {
  return rejectBusinessCommand(
    'GROUP_NOT_FOUND',
    BusinessCode.NOT_FOUND,
    'group not found',
  );
}
