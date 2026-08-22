import {
  forwardRef,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  group,
  relationshipIntent,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../database/schema.js';
import {
  GroupRole,
  MessageThreadType,
  ThreadParticipantState,
} from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';
import { FederationService } from '../federation/federation.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';

/** Privilege rank — LOWER is more privileged (OWNER outranks ADMIN outranks MEMBER). */
function roleRank(role: GroupRole | null): number {
  switch (role) {
    case GroupRole.OWNER:
      return 0;
    case GroupRole.ADMIN:
      return 1;
    default:
      return 2; // MEMBER (group participants always have a non-null role)
  }
}

/** Strict outrank: the operator may act on the target iff their rank is strictly lower. */
function outranks(operator: GroupRole, target: GroupRole | null): boolean {
  return roleRank(operator) < roleRank(target);
}

/**
 * Group lifecycle: creation, invite-token mint/verify, joining, and the membership/role mutations
 * (leave/kick/transfer/set-role/update).
 *
 * A group IS a `!`-sigil User row (account="!"+ULID, isGroup=true) carrying name/avatar/bio; the Group
 * table is abolished. The group↔thread link is MessageThread.groupUserId, and
 * the owner is derived from ThreadParticipant.role=OWNER (no ownerId column). All group-management
 * operations now key on threadId (the stable handle, also used for messaging); the wire still calls it
 * `groupId` for frontend compatibility, but the value IS the threadId.
 *
 * Membership is stored on ThreadParticipant (single source of truth). createNewGroup/joinGroup write
 * ThreadParticipant rows (OWNER for the creator, MEMBER for joiners). Authorization is split:
 * ThreadAccessGuard + RolesGuard decide the OPERATOR's membership and role (throwing BusinessException →
 * HTTP 200 + domain code); the methods below validate TARGET-specific invariants and mutate.
 */
@Injectable()
export class GroupService {
  constructor(
    private database: DatabaseService,
    private readonly threadRevisionService: ThreadRevisionService,
    private readonly federation: FederationService,
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
  ) {}

  /** Load a GROUP thread + its `!`-User (name/avatar/bio) by threadId. Returns null if missing. The read
   *  path replacing the old queryGroups/findUniqeGroup (which hit the Group table). */
  findGroupByThreadId(threadId: number) {
    return this.database.db.query.messageThread
      .findFirst({
        where: eq(messageThread.id, threadId),
        with: { user: { with: { group: true } } },
      })
      .then((row) => (row ? { ...row, groupUser: row.user } : null));
  }

  /** Batch-load the `!`-User (name/avatar/bio) for each of the given GROUP threads, keyed by threadId.
   *  Replaces the old queryGroups hydration that hit the Group table. Threads with no groupUser (P2P,
   *  or malformed) are omitted. Returns Map<threadId, {id,name,avatar,bio}>. */
  async resolveGroupUsersByThreadIds(threadIds: number[]): Promise<
    Map<
      number,
      {
        id: number;
        account: string;
        name: string;
        avatar: string;
        bio: string;
        domain: string;
        profileRev: number;
        group: {
          ownerId: number;
          membersCanInvite: boolean;
          dissolvedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }
    >
  > {
    if (threadIds.length === 0) return new Map();
    const threads = await this.database.db.query.messageThread.findMany({
      where: inArray(messageThread.id, threadIds),
      columns: { id: true },
      with: {
        user: {
          columns: {
            id: true,
            account: true,
            name: true,
            avatar: true,
            bio: true,
            domain: true,
            profileRev: true,
          },
          with: {
            group: {
              columns: {
                ownerId: true,
                membersCanInvite: true,
                dissolvedAt: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });
    const m = new Map<
      number,
      {
        id: number;
        account: string;
        name: string;
        avatar: string;
        bio: string;
        domain: string;
        profileRev: number;
        group: {
          ownerId: number;
          membersCanInvite: boolean;
          dissolvedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }
    >();
    for (const t of threads) {
      if (t.user) m.set(t.id, t.user);
    }
    return m;
  }

  /**
   * Create a group: mint the `!`-User identity (name/avatar/bio) + the GROUP thread linked via
   * groupUserId + the owner as an OWNER participant. No other members are created here; invitations
   * are represented by membership state. Wrapped in a
   * regenerate-on-P2002 loop: a same-ms ULID collision at the
   * account-domain unique index is probabilistically impossible, but the loop is a real safety net.
   */
  async createNewGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    owner: number;
  }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const account = mintGroupAccount();
      try {
        const result = await this.database.db.transaction(async (tx) => {
          const groupUser = await tx
            .insert(user)
            .values({
              account,
              domain: 'local',
              isForeigner: false,
              isGroup: true,
              hashPwd: '', // empty — !-group-users never log in (validateUser rejects isGroup before verify)
              name: params.name,
              avatar: params.avatar ?? '',
              bio: params.description ?? '',
              updatedAt: new Date(),
            })
            .returning()
            .then(([row]) => row);
          const thread = await tx
            .insert(messageThread)
            .values({
              type: MessageThreadType.GROUP,
              groupUserId: groupUser.id,
              updatedAt: new Date(),
            })
            .returning()
            .then(([row]) => row);
          await tx.insert(threadParticipant).values({
            userId: params.owner,
            threadId: thread.id,
            role: GroupRole.OWNER,
            updatedAt: new Date(),
          });
          await tx.insert(threadAudience).values({
            targetDomain: 'local',
            localUserId: params.owner,
            threadId: thread.id,
          });
          // Group-exclusive state: owner + roster revision (origin group: remoteRosterRev null).
          await tx.insert(group).values({
            groupUserId: groupUser.id,
            ownerId: params.owner,
            rosterRev: 0,
            updatedAt: new Date(),
          });
          return {
            id: groupUser.id,
            threadId: thread.id,
            name: groupUser.name,
            avatar: groupUser.avatar,
            bio: groupUser.bio,
          };
        });
        // Record the thread add for the owner AFTER the tx commits (bump threadRevision + push signal).
        await this.threadRevisionService.recordThreadAdd(
          params.owner,
          result.threadId,
        );
        return result;
      } catch (e) {
        if (!isP2002(e)) throw e; // regenerate a fresh ULID, never append a counter
      }
    }
    throw new Error(
      'group account collision after 3 attempts (probabilistically impossible)',
    );
  }

  /**
   * Leave a group by deactivating membership. The owner may not leave: they must transfer ownership or dissolve
   * the group, preserving the invariant that every active group has exactly one owner. Returns the
   * remaining active member ids for the caller response and follow-up effects.
   */
  async leaveGroup(params: {
    userId: number;
    threadId: number;
    role: GroupRole | null;
    deleteData: boolean;
  }): Promise<{ remainingMemberIds: number[]; transitioned: boolean }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const hidden = params.deleteData
        ? await this.threadRevisionService.isThreadHiddenInTx(
            tx,
            params.userId,
            params.threadId,
          )
        : false;
      const shouldDelete = params.deleteData && !hidden;
      const [current] = await tx
        .select({
          state: threadParticipant.state,
          role: threadParticipant.role,
        })
        .from(threadParticipant)
        .where(
          and(
            eq(threadParticipant.userId, params.userId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        )
        .for('update')
        .limit(1);
      if (!current)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'member not found');
      if (
        current.state === ThreadParticipantState.ESTABLISHED &&
        current.role === GroupRole.OWNER
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_OWNER_MUST_TRANSFER,
          'transfer ownership or dissolve the group before leaving',
        );
      }
      const ended = await tx
        .update(threadParticipant)
        .set({ state: ThreadParticipantState.REVOKED, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.userId, params.userId),
            eq(threadParticipant.threadId, params.threadId),
            eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
          ),
        )
        .returning({ id: threadParticipant.id });
      if (ended.length > 0) {
        await tx.execute(sql`
          DELETE FROM "ThreadAudience" audience
          WHERE audience."targetDomain" = 'local'
            AND audience."localUserId" = ${params.userId}
            AND audience."threadId" = ${params.threadId}
        `);
      }
      if (shouldDelete) {
        await tx
          .update(threadParticipant)
          .set({
            clearedSeq: sql`(SELECT "curSeq" FROM "MessageThread" WHERE id = ${params.threadId})`,
            pinned: false,
            pinnedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(threadParticipant.userId, params.userId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      if (ended.length > 0) {
        const [thread] = await tx
          .select({ groupUserId: messageThread.groupUserId })
          .from(messageThread)
          .where(eq(messageThread.id, params.threadId))
          .limit(1);
        if (thread?.groupUserId != null) {
          await tx
            .update(group)
            .set({
              rosterRev: sql`${group.rosterRev} + 1`,
              updatedAt: now,
            })
            .where(eq(group.groupUserId, thread.groupUserId));
        }
      }
      const remaining = await tx
        .select({ userId: threadParticipant.userId })
        .from(threadParticipant)
        .where(
          and(
            eq(threadParticipant.threadId, params.threadId),
            eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
          ),
        );
      const revision = shouldDelete
        ? await this.threadRevisionService.recordThreadDeleteInTx(
            tx,
            params.userId,
            params.threadId,
          )
        : ended.length > 0 && !hidden
          ? await this.threadRevisionService.recordThreadAddInTx(
              tx,
              params.userId,
              params.threadId,
            )
          : null;
      const requestState =
        ended.length > 0
          ? await this.federation.writeMemberRelationshipIntentInTx(
              tx,
              params.threadId,
              params.userId,
              'REVOKED',
            )
          : new Map<string, bigint>();
      const groupState =
        ended.length > 0
          ? await this.federation.writeGroupStateInTx(tx, params.threadId)
          : new Map<string, bigint>();
      const refreshes =
        ended.length > 0
          ? await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
              tx,
              params.threadId,
            )
          : [];
      return {
        transitioned: ended.length > 0,
        remainingMemberIds: remaining.map((row) => row.userId),
        revisions: [
          ...refreshes,
          ...(revision === null ? [] : [{ userId: params.userId, revision }]),
        ],
        statePeers: [...requestState.keys(), ...groupState.keys()],
      };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    if (result.transitioned) {
      await this.federation.notifyGroupLeave(params.threadId, params.userId);
    }
    if (result.transitioned)
      await this.emitSystemMessage(
        params.userId,
        params.threadId,
        SystemMessageType.GROUP_LEFT,
        params.userId,
      );
    return {
      transitioned: result.transitioned,
      remainingMemberIds: result.remainingMemberIds,
    };
  }

  /** Mark a group terminal while retaining participants and history visibility. Pending invites are
   * revoked in the same transaction, so an old card cannot join a dissolved group. */
  async dissolveGroup(params: {
    threadId: number;
    deleteForUserId?: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const hidden =
        params.deleteForUserId === undefined
          ? false
          : await this.threadRevisionService.isThreadHiddenInTx(
              tx,
              params.deleteForUserId,
              params.threadId,
            );
      const shouldDelete = params.deleteForUserId !== undefined && !hidden;
      const [thread] = await tx
        .select({ groupUserId: messageThread.groupUserId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (thread?.groupUserId == null) {
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      }
      const dissolved = await tx
        .update(group)
        .set({
          dissolvedAt: now,
          rosterRev: sql`${group.rosterRev} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(group.groupUserId, thread.groupUserId),
            isNull(group.dissolvedAt),
          ),
        )
        .returning({ id: group.id });
      if (dissolved.length > 0) {
        await tx
          .update(relationshipIntent)
          .set({
            status: 'REVOKED',
            updatedAt: now,
          })
          .where(
            and(
              eq(relationshipIntent.authorUserId, thread.groupUserId),
              eq(relationshipIntent.status, 'REQUESTED'),
            ),
          );
      }
      if (shouldDelete && params.deleteForUserId !== undefined) {
        await tx
          .update(threadParticipant)
          .set({
            clearedSeq: sql`(SELECT "curSeq" FROM "MessageThread" WHERE id = ${params.threadId})`,
            pinned: false,
            pinnedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(threadParticipant.userId, params.deleteForUserId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      const revision =
        shouldDelete && params.deleteForUserId !== undefined
          ? await this.threadRevisionService.recordThreadDeleteInTx(
              tx,
              params.deleteForUserId,
              params.threadId,
            )
          : null;
      const stateItems =
        dissolved.length > 0
          ? await this.federation.writeGroupStateInTx(tx, params.threadId)
          : new Map<string, bigint>();
      const refreshes =
        dissolved.length > 0
          ? await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
              tx,
              params.threadId,
              params.deleteForUserId === undefined
                ? []
                : [params.deleteForUserId],
            )
          : [];
      return {
        transitioned: dissolved.length > 0,
        revisions: [
          ...refreshes,
          ...(revision === null || params.deleteForUserId === undefined
            ? []
            : [{ userId: params.deleteForUserId, revision }]),
        ],
        statePeers: [...stateItems.keys()],
      };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    return { transitioned: result.transitioned };
  }

  /**
   * Kick a member by deactivating membership. The operator must strictly outrank the target; the owner
   * cannot be kicked. Throws GROUP_TARGET_NOT_MEMBER / GROUP_FORBIDDEN on invariant violation.
   */
  async kickMember(params: {
    threadId: number;
    operatorUserId: number;
    targetUserId: number;
    reason?: string;
  }): Promise<{ transitioned: boolean }> {
    const result = await this.database.db.transaction(async (tx) => {
      const [operator, target] = await Promise.all([
        tx
          .select()
          .from(threadParticipant)
          .where(
            and(
              eq(threadParticipant.userId, params.operatorUserId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          )
          .limit(1)
          .then(([row]) => row),
        tx
          .select()
          .from(threadParticipant)
          .where(
            and(
              eq(threadParticipant.userId, params.targetUserId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          )
          .limit(1)
          .then(([row]) => row),
      ]);
      if (!target) {
        return {
          transitioned: false,
          revisions: [],
          statePeers: [],
        };
      }
      if (target.state !== ThreadParticipantState.ESTABLISHED)
        return {
          transitioned: false,
          revisions: [],
          statePeers: [],
        };
      if (
        !operator ||
        operator.state !== ThreadParticipantState.ESTABLISHED ||
        operator.role === null ||
        target.role === GroupRole.OWNER ||
        !outranks(operator.role, target.role)
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'you can only kick members below your role',
        );
      }
      const hidden = await this.threadRevisionService.isThreadHiddenInTx(
        tx,
        params.targetUserId,
        params.threadId,
      );
      const now = new Date();
      const ended = await tx
        .update(threadParticipant)
        .set({ state: ThreadParticipantState.REVOKED, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.id, target.id),
            eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
            eq(threadParticipant.role, target.role!),
          ),
        )
        .returning({ id: threadParticipant.id });
      if (ended.length === 0)
        return {
          transitioned: false,
          revisions: [],
          statePeers: [],
        };
      const [thread] = await tx
        .select({ groupUserId: messageThread.groupUserId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (thread?.groupUserId != null) {
        await tx
          .update(group)
          .set({
            rosterRev: sql`${group.rosterRev} + 1`,
            updatedAt: now,
          })
          .where(eq(group.groupUserId, thread.groupUserId));
      }
      const revision = hidden
        ? null
        : await this.threadRevisionService.recordThreadAddInTx(
            tx,
            params.targetUserId,
            params.threadId,
          );
      const [targetIdentity] = await tx
        .select({ domain: user.domain, isForeigner: user.isForeigner })
        .from(user)
        .where(eq(user.id, params.targetUserId))
        .limit(1);
      const clientRevisions: Array<{ userId: number; revision: number }> = [];
      const requestState =
        await this.federation.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          params.targetUserId,
          params.reason ?? '',
          'REVOKED',
          clientRevisions,
        );
      const groupState = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        targetIdentity?.isForeigner ? [targetIdentity.domain] : [],
      );
      const refreshes =
        await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
          tx,
          params.threadId,
        );
      return {
        transitioned: true,
        revisions: [
          ...clientRevisions,
          ...refreshes,
          ...(revision === null
            ? []
            : [{ userId: params.targetUserId, revision }]),
        ],
        statePeers: [...requestState.keys(), ...groupState.keys()],
      };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    if (result.transitioned)
      await this.emitSystemMessage(
        params.operatorUserId,
        params.threadId,
        SystemMessageType.GROUP_LEFT,
        params.targetUserId,
      );
    return { transitioned: result.transitioned };
  }

  /**
   * Transfer ownership to an active member: demote the caller to MEMBER, promote the target to
   * OWNER — all in one transaction so no ownerless state is visible. Group.ownerId is updated in
   * the same transaction, then records a durable hydrated-thread refresh for every local member.
   */
  async transferOwnership(params: {
    threadId: number;
    fromUserId: number;
    toUserId: number;
  }): Promise<void> {
    if (params.toUserId === params.fromUserId) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot transfer ownership to yourself',
      );
    }
    const result = await this.database.db.transaction(async (tx) => {
      // Serialize every transfer through the current OWNER row. The partial unique index prevents
      // multiple active owners; the service invariants prevent the sole owner from leaving/demotion.
      const [currentOwner] = await tx
        .select({ id: threadParticipant.id, role: threadParticipant.role })
        .from(threadParticipant)
        .where(
          and(
            eq(threadParticipant.userId, params.fromUserId),
            eq(threadParticipant.threadId, params.threadId),
            eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
          ),
        )
        .for('update')
        .limit(1);
      if (currentOwner?.role !== GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'only the current owner may transfer ownership',
        );
      }
      const [target] = await tx
        .select({
          participant: threadParticipant,
          isForeigner: user.isForeigner,
        })
        .from(threadParticipant)
        .innerJoin(user, eq(user.id, threadParticipant.userId))
        .where(
          and(
            eq(threadParticipant.userId, params.toUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !target ||
        target.participant.state !== ThreadParticipantState.ESTABLISHED
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active member',
        );
      }
      // Ownership can't cross servers — the owner must stay on the origin (the roster authority).
      if (target.isForeigner) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'cannot transfer ownership to a member on another server',
        );
      }
      if (target.participant.role === GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'target is already the owner',
        );
      }
      const now = new Date();
      await tx
        .update(threadParticipant)
        .set({ role: GroupRole.MEMBER, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.userId, params.fromUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        );
      await tx
        .update(threadParticipant)
        .set({ role: GroupRole.OWNER, updatedAt: now })
        .where(eq(threadParticipant.id, target.participant.id));
      const [trd] = await tx
        .select({ groupUserId: messageThread.groupUserId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (trd?.groupUserId != null) {
        await tx
          .update(group)
          .set({
            ownerId: params.toUserId,
            rosterRev: sql`${group.rosterRev} + 1`,
            updatedAt: now,
          })
          .where(eq(group.groupUserId, trd.groupUserId));
      }
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
      );
      const revisions =
        await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
          tx,
          params.threadId,
        );
      return { statePeers: [...state.keys()], revisions };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    await this.emitSystemMessage(
      params.fromUserId,
      params.threadId,
      SystemMessageType.GROUP_OWNER_TRANSFERRED,
      params.toUserId,
    );
  }

  /**
   * Set a member's role to ADMIN or MEMBER. OWNER-only (enforced by @Roles); ownership changes go
   * through transferOwnership, so role=OWNER is rejected here, as is touching the current owner.
   */
  async setRole(params: {
    threadId: number;
    targetUserId: number;
    role: GroupRole;
    operatorUserId: number;
  }): Promise<void> {
    if (params.role === GroupRole.OWNER) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'use transfer to change ownership',
      );
    }
    if (params.targetUserId === params.operatorUserId) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot change your own role',
      );
    }
    const target = await this.database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, params.targetUserId),
        eq(threadParticipant.threadId, params.threadId),
      ),
    });
    if (!target || target.state !== ThreadParticipantState.ESTABLISHED) {
      throw new BusinessException(
        BusinessCode.GROUP_TARGET_NOT_MEMBER,
        'target is not an active member',
      );
    }
    if (target.role === GroupRole.OWNER) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        "cannot change the owner's role",
      );
    }
    if (target.role === params.role) return;
    const result = await this.database.db.transaction(async (tx) => {
      await tx
        .update(threadParticipant)
        .set({ role: params.role, updatedAt: new Date() })
        .where(eq(threadParticipant.id, target.id));
      const [trd] = await tx
        .select({ groupUserId: messageThread.groupUserId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (trd?.groupUserId != null)
        await tx
          .update(group)
          .set({
            rosterRev: sql`${group.rosterRev} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(group.groupUserId, trd.groupUserId));
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
      );
      const revisions =
        await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
          tx,
          params.threadId,
        );
      return { statePeers: [...state.keys()], revisions };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    await this.emitSystemMessage(
      params.operatorUserId,
      params.threadId,
      params.role === GroupRole.ADMIN
        ? SystemMessageType.GROUP_ADMIN_GRANTED
        : SystemMessageType.GROUP_ADMIN_REVOKED,
      params.targetUserId,
    );
  }

  private async emitSystemMessage(
    actorUserId: number,
    threadId: number,
    type: SystemMessageType,
    subjectUserId?: number,
  ): Promise<void> {
    if (!this.messages) return;
    const message = await this.messages.tryWriteSystemMessage(
      actorUserId,
      threadId,
      type,
      subjectUserId,
    );
    if (message && this.messageFanout)
      void this.messageFanout.dispatch(message);
  }

  /** Update a group's name / description / avatar on the `!`-User row (only provided fields are written).
   *  description maps to User.bio. */
  async updateGroup(params: {
    threadId: number;
    name?: string;
    description?: string;
    avatar?: string;
    membersCanInvite?: boolean;
  }) {
    const trd = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, params.threadId),
      columns: { groupUserId: true },
    });
    if (!trd || !trd.groupUserId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'group thread not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Partial<typeof user.$inferInsert> = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.description !== undefined) data.bio = params.description;
    if (params.avatar !== undefined) data.avatar = params.avatar;
    const result = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .update(user)
        .set({
          ...data,
          profileRev: sql`${user.profileRev} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(user.id, trd.groupUserId!))
        .returning();
      if (params.membersCanInvite !== undefined) {
        await tx
          .update(group)
          .set({
            membersCanInvite: params.membersCanInvite,
            rosterRev: sql`${group.rosterRev} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(group.groupUserId, trd.groupUserId!));
      }
      const stateItems = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
      );
      const revisions =
        await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
          tx,
          params.threadId,
        );
      return { row, statePeers: [...stateItems.keys()], revisions };
    });
    result.revisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    await this.federation.pushStateFeedDomains(result.statePeers);
    return result.row;
  }
}
