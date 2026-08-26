import {
  forwardRef,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  clientStateFeed,
  group,
  groupRequestProjection,
  relationshipIntent,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationService } from '../federation/federation.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { mutuallyAuthorizedSql } from '../invite/relationship-authorization.js';

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
    private readonly federation: FederationService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<
      MessageFanoutService,
      'dispatch' | 'dispatchToUsers'
    >,
  ) {}

  /**
   * Build the invitation picker from server state. The client cannot infer this page from its cached
   * conversations because friendship, membership, and manager-facing invitation projections converge
   * independently across federation.
   */
  async queryInviteCandidates(
    threadId: number,
    managerUserId: number,
    afterUserId?: number,
    search?: string,
    take = 20,
  ) {
    const normalizedSearch = search?.trim() ?? '';
    const pattern = `%${normalizedSearch.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = await this.database.db.execute<{
      userId: number;
      account: string;
      domain: string;
      name: string;
      avatar: string;
      bio: string;
      state: 'AVAILABLE' | 'INVITED' | 'MEMBER';
    }>(sql`
      SELECT friend.id AS "userId", friend.account, friend.domain,
        friend.name, friend.avatar, friend.bio,
        CASE
          WHEN member."userId" IS NOT NULL THEN 'MEMBER'
          WHEN invitation.status = 'REQUESTED'
            AND invitation."expiresAt" > CURRENT_TIMESTAMP THEN 'INVITED'
          ELSE 'AVAILABLE'
        END AS state
      FROM "User" friend
      LEFT JOIN "ThreadParticipant" member
        ON member."threadId" = ${threadId} AND member."userId" = friend.id
      LEFT JOIN "GroupRequestProjection" invitation
        ON invitation."managerUserId" = ${managerUserId}
       AND invitation."threadId" = ${threadId}
       AND invitation."memberUserId" = friend.id
       AND invitation.direction = 'INVITATION'
      WHERE friend.id <> ${managerUserId}
        AND friend."isGroup" = false
        AND friend."isDeleted" = false
        AND ${mutuallyAuthorizedSql(managerUserId, sql`friend.id`)}
        ${afterUserId === undefined ? sql.empty() : sql`AND friend.id > ${afterUserId}`}
        ${normalizedSearch === '' ? sql.empty() : sql`AND (friend.name ILIKE ${pattern} ESCAPE '\\' OR friend.account ILIKE ${pattern} ESCAPE '\\' OR (friend.account || '@' || COALESCE(NULLIF(friend.domain, ''), 'local')) ILIKE ${pattern} ESCAPE '\\')`}
      ORDER BY friend.id ASC
      LIMIT ${take + 1}
    `);
    const page = rows.rows.slice(0, take);
    return {
      data: page,
      hasMore: rows.rows.length > take,
      afterUserId: page.at(-1)?.userId ?? null,
    };
  }

  async queryJoinRequests(
    threadId: number,
    managerUserId: number,
    before?: number,
    take = 20,
  ) {
    return this.queryGroupRequests(
      threadId,
      managerUserId,
      'APPLICATION',
      before,
      take,
    );
  }

  async queryInvitations(
    threadId: number,
    managerUserId: number,
    before?: number,
    take = 20,
  ) {
    return this.queryGroupRequests(
      threadId,
      managerUserId,
      'INVITATION',
      before,
      take,
    );
  }

  private async queryGroupRequests(
    threadId: number,
    managerUserId: number,
    direction: 'APPLICATION' | 'INVITATION',
    before?: number,
    take = 20,
  ) {
    const rows = await this.database.db.execute<{
      feedId: number;
      id: string;
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
      userId: number;
      account: string;
      domain: string;
      name: string;
      avatar: string;
      note: string;
      requestedAt: number | null;
      expiresAt: number | null;
    }>(sql`
      SELECT projection."feedId", projection."requestId"::text AS id,
        CASE WHEN projection.status = 'REQUESTED'
          AND projection."expiresAt" <= CURRENT_TIMESTAMP
          THEN 'EXPIRED' ELSE projection.status END AS status,
        applicant.id AS "userId", applicant.account,
        applicant.domain,
        applicant.name, applicant.avatar, projection.note,
        (EXTRACT(EPOCH FROM projection."requestedAt") * 1000)::bigint AS "requestedAt",
        (EXTRACT(EPOCH FROM projection."expiresAt") * 1000)::bigint AS "expiresAt"
      FROM "GroupRequestProjection" projection
      JOIN "User" applicant ON applicant.id = projection."memberUserId"
      WHERE projection."managerUserId" = ${managerUserId}
        AND projection."threadId" = ${threadId}
        AND projection.direction = ${direction}
        ${before === undefined ? sql.empty() : sql`AND projection."feedId" < ${before}`}
      ORDER BY projection."feedId" DESC
      LIMIT ${take + 1}
    `);
    const page = rows.rows.slice(0, take);
    return {
      data: page.map((row) => ({
        ...row,
        requestedAt:
          row.requestedAt === null
            ? null
            : new Date(Number(row.requestedAt)).toISOString(),
        expiresAt:
          row.expiresAt === null
            ? null
            : new Date(Number(row.expiresAt)).toISOString(),
      })),
      hasMore: rows.rows.length > take,
      before: page.at(-1)?.feedId ?? null,
    };
  }

  /** Physically collect projections at seven days, or when their manager loses the group reference. */
  @Interval(60 * 60 * 1000)
  async garbageCollectJoinRequestProjections(): Promise<number> {
    const pending: Array<{ userId: number; feedId: number }> = [];
    const count = await this.database.db.transaction(async (tx) => {
      const candidates = await tx.execute<{
        managerUserId: number;
        threadId: number;
        latestFeedId: number;
      }>(sql`
        SELECT projection."managerUserId", projection."threadId",
          MAX(projection."feedId")::integer AS "latestFeedId"
        FROM "GroupRequestProjection" projection
        LEFT JOIN "ThreadParticipant" manager
          ON manager."userId" = projection."managerUserId"
         AND manager."threadId" = projection."threadId"
         AND manager.role IN ('OWNER', 'ADMIN')
        WHERE projection."expiresAt" <= CURRENT_TIMESTAMP
           OR manager."userId" IS NULL
        GROUP BY projection."managerUserId", projection."threadId"
      `);
      let removed = 0;
      for (const candidate of candidates.rows) {
        const deleted = await tx
          .delete(groupRequestProjection)
          .where(
            and(
              eq(groupRequestProjection.managerUserId, candidate.managerUserId),
              eq(groupRequestProjection.threadId, candidate.threadId),
              sql`(${groupRequestProjection.expiresAt} <= CURRENT_TIMESTAMP OR NOT EXISTS (
                SELECT 1 FROM "ThreadParticipant" manager
                WHERE manager."userId" = ${candidate.managerUserId}
                  AND manager."threadId" = ${candidate.threadId}
                  AND manager.role IN ('OWNER', 'ADMIN')
              ))`,
            ),
          )
          .returning({
            feedId: groupRequestProjection.feedId,
            memberUserId: groupRequestProjection.memberUserId,
          });
        removed += deleted.length;
        if (deleted.length === 0) continue;
        for (const memberUserId of new Set(
          deleted.map((row) => row.memberUserId),
        ))
          await this.clientStateFeed.cleanupProfileStateIfUnreferencedInTx(
            tx,
            candidate.managerUserId,
            memberUserId,
          );
        const [head] = await tx
          .select({
            account: clientStateFeed.account,
            domain: clientStateFeed.domain,
          })
          .from(clientStateFeed)
          .where(
            and(
              eq(clientStateFeed.userId, candidate.managerUserId),
              eq(clientStateFeed.eventType, 'GROUP_JOIN_REQUEST_HEAD'),
              sql`(${clientStateFeed.body}->>'threadId')::integer = ${candidate.threadId}`,
            ),
          )
          .limit(1);
        if (!head) continue;
        const feedId = await this.clientStateFeed.writeGroupJoinRequestHeadInTx(
          tx,
          {
            userId: candidate.managerUserId,
            account: head.account,
            domain: head.domain,
            threadId: candidate.threadId,
            readFeedId: candidate.latestFeedId,
          },
        );
        if (feedId !== null)
          pending.push({ userId: candidate.managerUserId, feedId });
      }
      return removed;
    });
    this.clientStateFeed.notifyFeedUpdates(pending);
    return count;
  }

  async handleJoinRequest(
    threadId: number,
    requestId: bigint,
    decision: 'ACCEPTED' | 'REVOKED',
  ): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const [request] = await tx
        .execute<{
          memberUserId: number;
          note: string;
        }>(
          sql`
        SELECT intent."authorUserId" AS "memberUserId", intent.note
        FROM "RelationshipIntent" intent
        JOIN "MessageThread" thread
          ON thread."groupUserId" = intent."subjectUserId"
        LEFT JOIN "RelationshipIntent" prior
          ON prior."authorUserId" = intent."subjectUserId"
         AND prior."subjectUserId" = intent."authorUserId"
        WHERE thread.id = ${threadId} AND intent.id = ${requestId}
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP
          AND (prior."authorUserId" IS NULL OR prior.status = 'REQUESTED'
            OR (prior.status = 'REVOKED' AND prior."updatedAt" < intent."requestedAt"))
        FOR UPDATE OF intent
      `,
        )
        .then((result) => result.rows);
      if (!request)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'join request not found',
        );
      statePeers = await this.federation.writeGroupRelationshipIntentInTx(
        tx,
        threadId,
        request.memberUserId,
        decision === 'ACCEPTED' ? request.note : '',
        decision,
        clientFeedUpdates,
        'APPLICATION',
      );
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.federation.pushStateFeedDomains(statePeers.keys());
  }

  async revokeInvitation(threadId: number, requestId: bigint): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const [request] = await tx
        .execute<{ memberUserId: number }>(
          sql`
          SELECT intent."subjectUserId" AS "memberUserId"
          FROM "RelationshipIntent" intent
          JOIN "MessageThread" thread
            ON thread."groupUserId" = intent."authorUserId"
          WHERE thread.id = ${threadId} AND intent.id = ${requestId}
            AND intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP
          FOR UPDATE OF intent
        `,
        )
        .then((result) => result.rows);
      if (!request)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group invitation not found',
        );
      statePeers = await this.federation.writeGroupRelationshipIntentInTx(
        tx,
        threadId,
        request.memberUserId,
        '',
        'REVOKED',
        clientFeedUpdates,
        'INVITATION',
      );
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.federation.pushStateFeedDomains(statePeers.keys());
  }

  async markJoinRequestsRead(
    threadId: number,
    managerUserId: number,
    readFeedId: number,
  ): Promise<void> {
    let pending: { userId: number; feedId: number } | undefined;
    await this.database.db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ account: user.account })
        .from(messageThread)
        .innerJoin(user, eq(user.id, messageThread.groupUserId))
        .where(eq(messageThread.id, threadId))
        .limit(1);
      if (!identity)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      const [head] = await tx
        .select({ domain: clientStateFeed.domain })
        .from(clientStateFeed)
        .where(
          and(
            eq(clientStateFeed.userId, managerUserId),
            eq(clientStateFeed.account, identity.account),
            eq(clientStateFeed.eventType, 'GROUP_JOIN_REQUEST_HEAD'),
          ),
        )
        .limit(1);
      if (!head) return;
      const feedId = await this.clientStateFeed.writeGroupJoinRequestHeadInTx(
        tx,
        {
          userId: managerUserId,
          account: identity.account,
          domain: head.domain,
          threadId,
          readFeedId,
        },
      );
      if (feedId !== null) pending = { userId: managerUserId, feedId };
    });
    if (pending) this.clientStateFeed.notifyFeedUpdated(pending);
  }

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
          // Group lifecycle state. Identity/profile fields live on groupUserId.
          await tx.insert(group).values({
            groupUserId: groupUser.id,
            ownerId: params.owner,
            updatedAt: new Date(),
          });
          const clientFeedUpdates: Array<{
            userId: number;
            feedId: number;
          }> = [];
          await this.federation.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'REQUESTED',
            clientFeedUpdates,
          );
          await this.federation.writeMemberRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            'ACCEPTED',
            clientFeedUpdates,
          );
          await this.federation.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'ACCEPTED',
            clientFeedUpdates,
          );
          clientFeedUpdates.push(
            ...(await this.clientStateFeed.recordGroupStateInTx(tx, thread.id)),
          );
          return {
            id: groupUser.id,
            threadId: thread.id,
            name: groupUser.name,
            avatar: groupUser.avatar,
            bio: groupUser.bio,
            clientFeedUpdates,
          };
        });
        this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
        const { clientFeedUpdates: _clientFeedUpdates, ...groupResult } =
          result;
        return groupResult;
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
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const shouldDelete = params.deleteData;
      const [current] = await tx
        .select({
          role: threadParticipant.role,
          groupUserId: messageThread.groupUserId,
          groupDomain: user.domain,
        })
        .from(threadParticipant)
        .innerJoin(
          messageThread,
          eq(messageThread.id, threadParticipant.threadId),
        )
        .innerJoin(user, eq(user.id, messageThread.groupUserId))
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
      if (current.groupUserId === null)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      const outgoing = await tx.execute<{ status: string }>(sql`
        SELECT status
        FROM "RelationshipIntent"
        WHERE "authorUserId" = ${params.userId}
          AND "subjectUserId" = ${current.groupUserId}
      `);
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      if (transitioned && current.role === GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_OWNER_MUST_TRANSFER,
          'transfer ownership or dissolve the group before leaving',
        );
      }
      const localRecipientIds = transitioned
        ? await this.localAuthorizedRecipientIdsInTx(tx, params.threadId)
        : [];
      const systemMessage =
        transitioned && this.messages
          ? (
              await this.messages.writeSystemMessageInTx(
                tx,
                params.threadId,
                SystemMessageType.GROUP_LEFT,
                params.userId,
                {
                  actorUserId: params.userId,
                  recipientUserIds: localRecipientIds,
                  markReadUserId: params.userId,
                },
              )
            ).message
          : null;
      if (systemMessage) {
        await tx
          .update(threadParticipant)
          .set({
            messageVisibleBeforeSeq: systemMessage.seq + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(threadParticipant.userId, params.userId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      if (transitioned) {
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
      if (transitioned) {
        const [thread] = await tx
          .select({ groupUserId: messageThread.groupUserId })
          .from(messageThread)
          .where(eq(messageThread.id, params.threadId))
          .limit(1);
        if (thread?.groupUserId != null) {
          await tx
            .update(group)
            .set({
              updatedAt: now,
            })
            .where(eq(group.groupUserId, thread.groupUserId));
        }
      }
      const requestState = transitioned
        ? await this.federation.writeMemberRelationshipIntentInTx(
            tx,
            params.threadId,
            params.userId,
            'REVOKED',
            clientFeedUpdates,
          )
        : new Map<string, bigint>();
      if (transitioned && current.groupDomain === 'local') {
        await this.federation.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          params.userId,
          '',
          'REVOKED',
          clientFeedUpdates,
        );
      }
      await this.federation.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.userId,
        clientFeedUpdates,
      );
      const groupState = transitioned
        ? await this.federation.writeGroupStateInTx(
            tx,
            params.threadId,
            clientFeedUpdates,
          )
        : new Map<string, bigint>();
      const remaining = await tx
        .select({ userId: threadParticipant.userId })
        .from(threadParticipant)
        .where(eq(threadParticipant.threadId, params.threadId));
      const remainingAuthorization = await Promise.all(
        remaining.map((row) =>
          isThreadMutuallyAuthorized(tx, row.userId, params.threadId),
        ),
      );
      return {
        transitioned,
        remainingMemberIds: remaining
          .filter((_, index) => remainingAuthorization[index])
          .map((row) => row.userId),
        statePeers: [...requestState.keys(), ...groupState.keys()],
        clientFeedUpdates,
        systemMessage,
        localRecipientIds,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.federation.pushStateFeedDomains(result.statePeers);
    if (result.transitioned) {
      await this.federation.notifyGroupLeave(params.threadId, params.userId);
    }
    if (result.systemMessage && this.messageFanout)
      void this.messageFanout.dispatchToUsers(
        result.systemMessage,
        result.localRecipientIds,
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
    operatorUserId?: number;
    deleteForUserId?: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const shouldDelete = params.deleteForUserId !== undefined;
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
      const localRecipientIds =
        dissolved.length > 0 && this.messages
          ? await this.localAuthorizedRecipientIdsInTx(tx, params.threadId)
          : [];
      const systemMessages: Array<{
        message: Awaited<
          ReturnType<MessageService['writeSystemMessageInTx']>
        >['message'];
        recipientUserId: number;
      }> = [];
      for (const recipientUserId of localRecipientIds) {
        const written = await this.messages!.writeSystemMessageInTx(
          tx,
          params.threadId,
          SystemMessageType.GROUP_LEFT,
          recipientUserId,
          {
            actorUserId: params.operatorUserId,
            recipientUserIds: [recipientUserId],
            markReadUserId:
              recipientUserId === params.deleteForUserId
                ? recipientUserId
                : undefined,
          },
        );
        systemMessages.push({
          message: written.message,
          recipientUserId,
        });
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
      const stateItems =
        dissolved.length > 0
          ? await this.federation.writeGroupStateInTx(
              tx,
              params.threadId,
              clientFeedUpdates,
            )
          : new Map<string, bigint>();
      return {
        transitioned: dissolved.length > 0,
        statePeers: [...stateItems.keys()],
        clientFeedUpdates,
        systemMessages,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.federation.pushStateFeedDomains(result.statePeers);
    if (this.messageFanout)
      for (const systemMessage of result.systemMessages)
        void this.messageFanout.dispatchToUsers(systemMessage.message, [
          systemMessage.recipientUserId,
        ]);
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
          clientFeedUpdates: [],
          statePeers: [],
          systemMessage: null,
          localRecipientIds: [],
        };
      }
      const [operatorAuthorized, targetAuthorized] = await Promise.all([
        isThreadMutuallyAuthorized(tx, params.operatorUserId, params.threadId),
        isThreadMutuallyAuthorized(tx, params.targetUserId, params.threadId),
      ]);
      if (!targetAuthorized)
        return {
          transitioned: false,
          clientFeedUpdates: [],
          statePeers: [],
          systemMessage: null,
          localRecipientIds: [],
        };
      if (
        !operator ||
        !operatorAuthorized ||
        operator.role === null ||
        target.role === GroupRole.OWNER ||
        !outranks(operator.role, target.role)
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'you can only kick members below your role',
        );
      }
      const now = new Date();
      const localRecipientIds = await this.localAuthorizedRecipientIdsInTx(
        tx,
        params.threadId,
      );
      const systemMessage = this.messages
        ? (
            await this.messages.writeSystemMessageInTx(
              tx,
              params.threadId,
              SystemMessageType.GROUP_LEFT,
              params.targetUserId,
              {
                actorUserId: params.operatorUserId,
                recipientUserIds: localRecipientIds,
                markReadUserId: params.operatorUserId,
              },
            )
          ).message
        : null;
      if (systemMessage) {
        await tx
          .update(threadParticipant)
          .set({
            messageVisibleBeforeSeq: systemMessage.seq + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(threadParticipant.userId, params.targetUserId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      const [thread] = await tx
        .select({ groupUserId: messageThread.groupUserId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (thread?.groupUserId != null) {
        await tx
          .update(group)
          .set({
            updatedAt: now,
          })
          .where(eq(group.groupUserId, thread.groupUserId));
      }
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const requestState =
        await this.federation.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          params.targetUserId,
          params.reason ?? '',
          'REVOKED',
          clientFeedUpdates,
        );
      const groupState = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      return {
        transitioned: true,
        clientFeedUpdates,
        statePeers: [...requestState.keys(), ...groupState.keys()],
        systemMessage,
        localRecipientIds,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.federation.pushStateFeedDomains(result.statePeers);
    if (result.systemMessage && this.messageFanout)
      void this.messageFanout.dispatchToUsers(
        result.systemMessage,
        result.localRecipientIds,
      );
    return { transitioned: result.transitioned };
  }

  /**
   * Transfer ownership to an active member: demote the caller to MEMBER, promote the target to
   * OWNER — all in one transaction so no ownerless state is visible. Group.ownerId is updated in
   * the same transaction, then advances every local member's group-meta feed.
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
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      // Serialize every transfer through the current OWNER row. The partial unique index prevents
      // multiple active owners; the service invariants prevent the sole owner from leaving/demotion.
      const [currentOwner] = await tx
        .select({ id: threadParticipant.id, role: threadParticipant.role })
        .from(threadParticipant)
        .where(
          and(
            eq(threadParticipant.userId, params.fromUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        currentOwner?.role !== GroupRole.OWNER ||
        !(await isThreadMutuallyAuthorized(
          tx,
          params.fromUserId,
          params.threadId,
        ))
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'only the current owner may transfer ownership',
        );
      }
      const [target] = await tx
        .select({
          participant: threadParticipant,
          domain: user.domain,
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
        !(await isThreadMutuallyAuthorized(
          tx,
          params.toUserId,
          params.threadId,
        ))
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active member',
        );
      }
      // Ownership can't cross servers — the owner must stay on the origin (the roster authority).
      if (target.domain !== 'local') {
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
            updatedAt: now,
          })
          .where(eq(group.groupUserId, trd.groupUserId));
      }
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      await this.federation.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.fromUserId,
        clientFeedUpdates,
      );
      await this.federation.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.toUserId,
        clientFeedUpdates,
      );
      return { statePeers: [...state.keys()], clientFeedUpdates };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
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
    const operator = await this.database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, params.operatorUserId),
        eq(threadParticipant.threadId, params.threadId),
      ),
      columns: { role: true },
    });
    if (
      operator?.role !== GroupRole.OWNER ||
      !(await isThreadMutuallyAuthorized(
        this.database.db,
        params.operatorUserId,
        params.threadId,
      ))
    ) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only the group owner may change administrator roles',
      );
    }
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
      with: { user: { columns: { domain: true } } },
    });
    if (
      !target ||
      !(await isThreadMutuallyAuthorized(
        this.database.db,
        params.targetUserId,
        params.threadId,
      ))
    ) {
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
    if (params.role === GroupRole.ADMIN && target.user.domain !== 'local') {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot grant administrator role to a member on another server',
      );
    }
    if (target.role === params.role) return;
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
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
            updatedAt: new Date(),
          })
          .where(eq(group.groupUserId, trd.groupUserId));
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      await this.federation.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.targetUserId,
        clientFeedUpdates,
      );
      return { statePeers: [...state.keys()], clientFeedUpdates };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
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
      threadId,
      type,
      subjectUserId,
      { actorUserId },
    );
    if (message && this.messageFanout)
      void this.messageFanout.dispatch(message);
  }

  private async localAuthorizedRecipientIdsInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<number[]> {
    const rows = await tx
      .select({ userId: threadParticipant.userId })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.userId))
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          eq(user.domain, 'local'),
          eq(user.isDeleted, false),
        ),
      );
    const authorized = await Promise.all(
      rows.map((row) => isThreadMutuallyAuthorized(tx, row.userId, threadId)),
    );
    return rows
      .filter((_, index) => authorized[index])
      .map((row) => row.userId);
  }

  /** Update a group's name / description / avatar on the `!`-User row (only provided fields are written).
   *  description maps to User.bio. */
  async updateGroup(params: {
    threadId: number;
    name?: string;
    description?: string;
    avatar?: string;
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
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const [row] = await tx
        .update(user)
        .set({
          ...data,
          profileRev: sql`${user.profileRev} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(user.id, trd.groupUserId!))
        .returning();
      const stateItems = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      return { row, statePeers: [...stateItems.keys()], clientFeedUpdates };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.federation.pushStateFeedDomains(result.statePeers);
    return result.row;
  }
}
