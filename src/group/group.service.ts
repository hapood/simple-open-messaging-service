import {
  forwardRef,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  clientStateFeed,
  group,
  groupRequestProjection,
  relationshipIntent,
  relationshipPair,
  messageThread,
  profileVersion,
  threadAudience,
  threadMember,
  threadParticipant,
  user,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationService } from '../federation/federation.service.js';
import { FederationRelationshipCommandService } from '../federation/federation-relationship-command.service.js';
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
 * Group identity is stored independently from User and linked by MessageThread.groupId. The owner is
 * derived from the active ThreadMember with role=OWNER. All group-management
 * operations now key on threadId (the stable handle, also used for messaging); the wire still calls it
 * `groupId` for frontend compatibility, but the value IS the threadId.
 *
 * Roster membership is stored on ThreadMember; ThreadParticipant contains only local per-user state.
 * Authorization is split:
 * ThreadAccessGuard + RolesGuard decide the OPERATOR's membership and role (throwing BusinessException →
 * HTTP 200 + domain code); the methods below validate TARGET-specific invariants and mutate.
 */
@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  constructor(
    private database: DatabaseService,
    private readonly federation: FederationService,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<
      MessageFanoutService,
      'dispatch' | 'dispatchToUsers'
    >,
  ) {}

  /** Resolve one active roster member by its exact wire-level address. */
  async resolveActiveMember(
    threadId: number,
    identity: { account: string; domain: string },
  ): Promise<{
    userId: number;
    account: string;
    domain: string;
    name: string;
  }> {
    const [member] = await this.database.db
      .select({
        userId: user.id,
        account: user.account,
        domain: user.domain,
        name: user.name,
      })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .innerJoin(messageThread, eq(messageThread.id, threadMember.threadId))
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.left, false),
          eq(user.account, identity.account),
          eq(user.domain, identity.domain),
          eq(user.sourceDomain, group.domain),
        ),
      )
      .limit(1);
    if (!member)
      throw new BusinessException(
        BusinessCode.GROUP_TARGET_NOT_MEMBER,
        'target is not an active group member',
      );
    return member;
  }

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
      LEFT JOIN "ThreadMember" member
        ON member."threadId" = ${threadId} AND member."userId" = friend.id
       AND member.left = false
      LEFT JOIN "GroupRequestProjection" invitation
        ON invitation."managerUserId" = ${managerUserId}
       AND invitation."threadId" = ${threadId}
       AND invitation."memberUserId" = friend.id
       AND invitation.direction = 'INVITATION'
      WHERE friend.id <> ${managerUserId}
        AND friend.availability = 'AVAILABLE'
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
        requestedAt: row.requestedAt === null ? null : Number(row.requestedAt),
        expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
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
        LEFT JOIN "ThreadMember" manager
          ON manager."userId" = projection."managerUserId"
         AND manager."threadId" = projection."threadId"
         AND manager.left = false
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
                SELECT 1 FROM "ThreadMember" manager
                WHERE manager."userId" = ${candidate.managerUserId}
                  AND manager."threadId" = ${candidate.threadId}
                  AND manager.left = false
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

  async handleJoinRequest(params: {
    threadId: number;
    requestId: bigint;
    managerUserId: number;
    decision: 'ACCEPTED' | 'REVOKED';
  }): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const readRequest = () =>
        tx
          .execute<{
            memberUserId: number;
            note: string;
          }>(
            sql`
        SELECT member.id AS "memberUserId", intent.note
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
        JOIN "User" member
          ON member.account = pair."endpointBAccount"
         AND member.domain = pair."endpointBDomain"
         AND member."sourceDomain" = pair."endpointBDomain"
         AND ((member.domain = 'local' AND member."namespaceId" = 0)
           OR (member.domain <> 'local'
             AND member."namespaceId" = pair."endpointBNamespaceId"))
        LEFT JOIN "RelationshipIntent" prior
          ON prior."pairId" = pair.id AND prior."authorSide" = 'A'
        WHERE pair."threadId" = ${params.threadId} AND intent.id = ${params.requestId}
          AND pair.kind = 'GROUP_MEMBER' AND intent."authorSide" = 'B'
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP
          AND (prior.id IS NULL OR prior.status = 'REQUESTED'
            OR (prior.status = 'REVOKED' AND prior."updatedAt" < intent."requestedAt"))
      `,
          )
          .then((result) => result.rows);
      const [candidate] = await readRequest();
      if (!candidate)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'join request not found',
        );
      await this.relationshipCommands.lockGroupMutationInTx(
        tx,
        params.threadId,
        candidate.memberUserId,
        [params.managerUserId],
      );
      await this.assertGroupManagerInTx(
        tx,
        params.threadId,
        params.managerUserId,
      );
      const [request] = await readRequest();
      if (!request)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'join request not found',
        );
      statePeers =
        await this.relationshipCommands.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          request.memberUserId,
          params.decision === 'ACCEPTED' ? request.note : '',
          params.decision,
          clientFeedUpdates,
          'APPLICATION',
        );
    });
    this.notifyCommandEffects(
      clientFeedUpdates,
      statePeers.keys(),
      'group join-request decision',
    );
  }

  async revokeInvitation(params: {
    threadId: number;
    requestId: bigint;
    managerUserId: number;
  }): Promise<void> {
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const readRequest = () =>
        tx
          .execute<{ memberUserId: number }>(
            sql`
          SELECT member.id AS "memberUserId"
          FROM "RelationshipIntent" intent
          JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
          JOIN "User" member
            ON member.account = pair."endpointBAccount"
           AND member.domain = pair."endpointBDomain"
           AND member."sourceDomain" = pair."endpointBDomain"
           AND ((member.domain = 'local' AND member."namespaceId" = 0)
             OR (member.domain <> 'local'
               AND member."namespaceId" = pair."endpointBNamespaceId"))
          WHERE pair."threadId" = ${params.threadId} AND intent.id = ${params.requestId}
            AND pair.kind = 'GROUP_MEMBER' AND intent."authorSide" = 'A'
            AND intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP
        `,
          )
          .then((result) => result.rows);
      const [candidate] = await readRequest();
      if (!candidate)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group invitation not found',
        );
      await this.relationshipCommands.lockGroupMutationInTx(
        tx,
        params.threadId,
        candidate.memberUserId,
        [params.managerUserId],
      );
      await this.assertGroupManagerInTx(
        tx,
        params.threadId,
        params.managerUserId,
      );
      const [request] = await readRequest();
      if (!request)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group invitation not found',
        );
      statePeers =
        await this.relationshipCommands.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          request.memberUserId,
          '',
          'REVOKED',
          clientFeedUpdates,
          'INVITATION',
        );
    });
    this.notifyCommandEffects(
      clientFeedUpdates,
      statePeers.keys(),
      'group invitation revoke',
    );
  }

  async markJoinRequestsRead(
    threadId: number,
    managerUserId: number,
    readFeedId: number,
  ): Promise<void> {
    let pending: { userId: number; feedId: number } | undefined;
    await this.database.db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ account: group.account })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.groupId))
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

  /** Load a group thread with its independent profile. */
  async findGroupByThreadId(threadId: number) {
    const [row] = await this.database.db
      .select({ thread: messageThread, group })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!row) return null;
    const [owner] = await this.database.db
      .select({ userId: threadMember.userId })
      .from(threadMember)
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.role, GroupRole.OWNER),
          eq(threadMember.left, false),
        ),
      )
      .limit(1);
    return {
      ...row.thread,
      group: {
        ...row.group,
        ownerId: owner?.userId ?? 0,
      },
    };
  }

  /** Batch-load independent group profiles by thread id. */
  async resolveGroupsByThreadIds(threadIds: number[]): Promise<
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
        ownerId: number;
        dissolvedAt: Date | null;
      }
    >
  > {
    if (threadIds.length === 0) return new Map();
    const threads = await this.database.db
      .select({ threadId: messageThread.id, group })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(inArray(messageThread.id, threadIds));
    const owners = await this.database.db
      .select({ threadId: threadMember.threadId, userId: threadMember.userId })
      .from(threadMember)
      .where(
        and(
          inArray(threadMember.threadId, threadIds),
          eq(threadMember.role, GroupRole.OWNER),
          eq(threadMember.left, false),
        ),
      );
    const ownerByThread = new Map(
      owners.map((row) => [row.threadId, row.userId]),
    );
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
        ownerId: number;
        dissolvedAt: Date | null;
      }
    >();
    for (const row of threads)
      m.set(row.threadId, {
        id: row.group.id,
        account: row.group.account,
        name: row.group.name,
        avatar: row.group.avatar,
        bio: row.group.description,
        domain: row.group.domain,
        profileRev: row.group.defaultProfileRev,
        ownerId: ownerByThread.get(row.threadId) ?? 0,
        dissolvedAt: row.group.dissolvedAt,
      });
    return m;
  }

  /**
   * Create a group: mint the `!`-User identity (name/avatar/bio) + the GROUP thread linked via
   * Group.id + the owner as an OWNER ThreadMember. No other members are created here; invitations
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
          const groupState = await tx
            .insert(group)
            .values({
              account,
              domain: 'local',
              name: params.name,
              avatar: params.avatar ?? '',
              description: params.description ?? '',
              updatedAt: new Date(),
            })
            .returning()
            .then(([row]) => row);
          const thread = await tx
            .insert(messageThread)
            .values({
              type: MessageThreadType.GROUP,
              groupId: groupState.id,
              updatedAt: new Date(),
            })
            .returning()
            .then(([row]) => row);
          await tx.insert(profileVersion).values({
            groupId: groupState.id,
            profileRev: 0,
            displayName: groupState.name,
            avatar: groupState.avatar,
            bio: groupState.description,
          });
          const [ownerMember] = await tx
            .insert(threadMember)
            .values({
              userId: params.owner,
              threadId: thread.id,
              role: GroupRole.OWNER,
              updatedAt: new Date(),
            })
            .returning({ id: threadMember.id });
          if (!ownerMember) throw new Error('group owner member insert failed');
          await tx.insert(threadParticipant).values({
            accountId: params.owner,
            threadId: thread.id,
            role: GroupRole.OWNER,
          });
          await tx.insert(threadAudience).values({
            targetDomain: 'local',
            localUserId: params.owner,
            threadId: thread.id,
          });
          const clientFeedUpdates: Array<{
            userId: number;
            feedId: number;
          }> = [];
          await this.relationshipCommands.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'REQUESTED',
            clientFeedUpdates,
          );
          await this.relationshipCommands.writeMemberRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            'ACCEPTED',
            clientFeedUpdates,
          );
          await this.relationshipCommands.writeGroupRelationshipIntentInTx(
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
            id: groupState.id,
            threadId: thread.id,
            name: groupState.name,
            avatar: groupState.avatar,
            bio: groupState.description,
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
    dissolvedFanout?: boolean;
  }): Promise<{ remainingMemberIds: number[]; transitioned: boolean }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const shouldDelete = params.deleteData;
      await this.relationshipCommands.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.userId,
      );
      const [thread] = await tx
        .select({
          groupId: messageThread.groupId,
          groupDomain: group.domain,
          dissolvedAt: group.dissolvedAt,
          role: threadMember.role,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.groupId))
        .leftJoin(
          threadMember,
          and(
            eq(threadMember.threadId, messageThread.id),
            eq(threadMember.userId, params.userId),
            eq(threadMember.left, false),
          ),
        )
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!thread?.groupId)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      if (params.dissolvedFanout && thread.dissolvedAt === null) {
        throw new Error('group member fan-out requires a dissolved group');
      }
      const outgoing = await tx.execute<{ status: string }>(sql`
        SELECT intent.status
        FROM "RelationshipPair" pair
        JOIN "User" identity ON identity.id = ${params.userId}
        LEFT JOIN "RelationshipIntent" intent
          ON intent."pairId" = pair.id AND intent."authorSide" = 'B'
        WHERE pair."threadId" = ${params.threadId}
          AND pair.kind = 'GROUP_MEMBER'
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = identity.account
          AND pair."endpointBDomain" = identity.domain
          AND (identity."namespaceId" = 0
            OR pair."endpointBNamespaceId" = identity."namespaceId")
      `);
      if (params.role === null && outgoing.rows.length === 0)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'member not found');
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      const fanoutMember = params.dissolvedFanout
        ? await tx.query.user.findFirst({
            where: eq(user.id, params.userId),
            columns: { domain: true },
          })
        : null;
      if (params.dissolvedFanout && !fanoutMember) {
        throw new Error('dissolved group member identity is missing');
      }
      if (
        transitioned &&
        !params.dissolvedFanout &&
        thread.groupDomain === 'local' &&
        thread.role === GroupRole.OWNER
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_OWNER_MUST_TRANSFER,
          'transfer ownership or dissolve the group before leaving',
        );
      }
      let localRecipientIds: number[] = [];
      if (transitioned) {
        if (params.dissolvedFanout) {
          if (fanoutMember?.domain === 'local') {
            localRecipientIds = [params.userId];
          }
        } else {
          localRecipientIds = await this.localAuthorizedRecipientIdsInTx(
            tx,
            params.threadId,
          );
        }
      }
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
              eq(threadParticipant.accountId, params.userId),
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
              eq(threadParticipant.accountId, params.userId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      if (transitioned) {
        await tx
          .update(group)
          .set({ updatedAt: now })
          .where(eq(group.id, thread.groupId));
      }
      const requestState =
        transitioned &&
        (!params.dissolvedFanout || fanoutMember?.domain === 'local')
          ? await this.relationshipCommands.writeMemberRelationshipIntentInTx(
              tx,
              params.threadId,
              params.userId,
              'REVOKED',
              clientFeedUpdates,
              '',
              undefined,
              {
                publishGroupState: !params.dissolvedFanout,
                allowOwnerDeactivation: params.dissolvedFanout === true,
              },
            )
          : new Map<string, bigint>();
      let groupRequestState = new Map<string, bigint>();
      if (transitioned && thread.groupDomain === 'local') {
        groupRequestState =
          await this.relationshipCommands.writeGroupRelationshipIntentInTx(
            tx,
            params.threadId,
            params.userId,
            '',
            'REVOKED',
            clientFeedUpdates,
            undefined,
            {
              publishGroupState: !params.dissolvedFanout,
              allowOwnerDeactivation: params.dissolvedFanout === true,
            },
          );
      }
      await this.relationshipCommands.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.userId,
        clientFeedUpdates,
      );
      const groupState =
        transitioned && !params.dissolvedFanout
          ? await this.federation.writeGroupStateInTx(
              tx,
              params.threadId,
              clientFeedUpdates,
            )
          : new Map<string, bigint>();
      const remaining = params.dissolvedFanout
        ? []
        : await tx
            .select({ userId: threadMember.userId })
            .from(threadMember)
            .where(
              and(
                eq(threadMember.threadId, params.threadId),
                eq(threadMember.left, false),
              ),
            );
      const remainingAuthorization = params.dissolvedFanout
        ? []
        : await Promise.all(
            remaining.map((row) =>
              isThreadMutuallyAuthorized(tx, row.userId, params.threadId),
            ),
          );
      return {
        transitioned,
        remainingMemberIds: remaining
          .filter((_, index) => remainingAuthorization[index])
          .map((row) => row.userId),
        statePeers: [
          ...requestState.keys(),
          ...groupRequestState.keys(),
          ...groupState.keys(),
        ],
        clientFeedUpdates,
        systemMessage,
        localRecipientIds,
      };
    });
    try {
      this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    } catch (error) {
      this.logger.warn('group leave client-state wake failed', error);
    }
    void this.federation
      .pushStateFeedDomains(result.statePeers)
      .catch((error: unknown) =>
        this.logger.warn('group leave state-feed wake failed', error),
      );
    if (result.transitioned && !params.dissolvedFanout) {
      void this.federation
        .notifyGroupLeave(params.threadId, params.userId)
        .catch((error: unknown) =>
          this.logger.warn('group leave notification failed', error),
        );
    }
    if (result.systemMessage && this.messageFanout)
      void this.messageFanout
        .dispatchToUsers(result.systemMessage, result.localRecipientIds)
        .catch((error: unknown) =>
          this.logger.warn('group leave message wake failed', error),
        );
    return {
      transitioned: result.transitioned,
      remainingMemberIds: result.remainingMemberIds,
    };
  }

  async revokeDissolvedGroupMember(params: {
    threadId: number;
    memberUserId: number;
    deleteData: boolean;
  }): Promise<void> {
    await this.leaveGroup({
      userId: params.memberUserId,
      threadId: params.threadId,
      role: null,
      deleteData: params.deleteData,
      dissolvedFanout: true,
    });
  }

  async resolveDisbandCommandScope(
    threadId: number,
    operatorUserId: number,
  ): Promise<{ account: string; domain: string }> {
    const [state] = await this.database.db
      .select({
        account: group.account,
        domain: group.domain,
        role: threadMember.role,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .innerJoin(
        threadMember,
        and(
          eq(threadMember.threadId, messageThread.id),
          eq(threadMember.userId, operatorUserId),
        ),
      )
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    if (state.domain !== 'local' || state.role !== GroupRole.OWNER) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
    }
    return { account: state.account, domain: state.domain };
  }

  async resolveGroupCommandScope(
    threadId: number,
  ): Promise<{ account: string; domain: string }> {
    const [state] = await this.database.db
      .select({ account: group.account, domain: group.domain })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    return state;
  }

  async resolveGroupRequestCommandScope(params: {
    threadId: number;
    managerUserId: number;
    requestId: bigint;
    direction: 'APPLICATION' | 'INVITATION';
  }): Promise<{ memberUserId: number }> {
    const request =
      await this.database.db.query.groupRequestProjection.findFirst({
        where: and(
          eq(groupRequestProjection.threadId, params.threadId),
          eq(groupRequestProjection.managerUserId, params.managerUserId),
          eq(groupRequestProjection.requestId, params.requestId),
          eq(groupRequestProjection.direction, params.direction),
          eq(groupRequestProjection.status, 'REQUESTED'),
          gt(groupRequestProjection.expiresAt, new Date()),
        ),
        columns: { memberUserId: true },
      });
    if (!request) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        params.direction === 'APPLICATION'
          ? 'join request not found'
          : 'group invitation not found',
      );
    }
    return request;
  }

  /** Commit only the terminal group fact. Member relationships are revoked by child commands. */
  async markGroupDissolved(params: {
    threadId: number;
    operatorUserId: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      await this.relationshipCommands.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const [state] = await tx
        .select({
          groupId: group.id,
          groupDomain: group.domain,
          role: threadMember.role,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.groupId))
        .innerJoin(
          threadMember,
          and(
            eq(threadMember.threadId, messageThread.id),
            eq(threadMember.userId, params.operatorUserId),
          ),
        )
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!state)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      if (state.groupDomain !== 'local' || state.role !== GroupRole.OWNER) {
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      }
      const dissolved = await tx
        .update(group)
        .set({ dissolvedAt: now, updatedAt: now })
        .where(and(eq(group.id, state.groupId), isNull(group.dissolvedAt)))
        .returning({ id: group.id });
      return { transitioned: dissolved.length > 0 };
    });
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
      await this.relationshipCommands.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.targetUserId,
        [params.operatorUserId],
      );
      const [operator, target] = await Promise.all([
        tx
          .select()
          .from(threadMember)
          .where(
            and(
              eq(threadMember.userId, params.operatorUserId),
              eq(threadMember.threadId, params.threadId),
              eq(threadMember.left, false),
            ),
          )
          .limit(1)
          .then(([row]) => row),
        tx
          .select({ member: threadMember, domain: user.domain })
          .from(threadMember)
          .innerJoin(user, eq(user.id, threadMember.userId))
          .where(
            and(
              eq(threadMember.userId, params.targetUserId),
              eq(threadMember.threadId, params.threadId),
              eq(threadMember.left, false),
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
        target.member.role === GroupRole.OWNER ||
        !outranks(operator.role, target.member.role)
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
              eq(threadParticipant.accountId, params.targetUserId),
              eq(threadParticipant.threadId, params.threadId),
            ),
          );
      }
      const [thread] = await tx
        .select({
          groupId: messageThread.groupId,
          groupDomain: group.domain,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.groupId))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (thread?.groupId != null) {
        await tx
          .update(group)
          .set({
            updatedAt: now,
          })
          .where(eq(group.id, thread.groupId));
      }
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const requestState =
        await this.relationshipCommands.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          params.targetUserId,
          params.reason ?? '',
          'REVOKED',
          clientFeedUpdates,
        );
      if (thread?.groupDomain === 'local' && target.domain === 'local') {
        const reverseState =
          await this.relationshipCommands.writeMemberRelationshipIntentInTx(
            tx,
            params.threadId,
            params.targetUserId,
            'REVOKED',
            clientFeedUpdates,
          );
        for (const [domain, feedId] of reverseState)
          requestState.set(domain, feedId);
      }
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
   * OWNER — all in one transaction so no ownerless state is visible, then advances every local
   * member's group-meta feed.
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
        .select({ id: threadMember.id, role: threadMember.role })
        .from(threadMember)
        .where(
          and(
            eq(threadMember.userId, params.fromUserId),
            eq(threadMember.threadId, params.threadId),
            eq(threadMember.left, false),
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
          member: threadMember,
          domain: user.domain,
        })
        .from(threadMember)
        .innerJoin(user, eq(user.id, threadMember.userId))
        .where(
          and(
            eq(threadMember.userId, params.toUserId),
            eq(threadMember.threadId, params.threadId),
            eq(threadMember.left, false),
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
      if (target.member.role === GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'target is already the owner',
        );
      }
      const now = new Date();
      await tx
        .update(threadMember)
        .set({ role: GroupRole.MEMBER, updatedAt: now })
        .where(
          and(
            eq(threadMember.userId, params.fromUserId),
            eq(threadMember.threadId, params.threadId),
          ),
        );
      await tx
        .update(threadMember)
        .set({ role: GroupRole.OWNER, updatedAt: now })
        .where(eq(threadMember.id, target.member.id));
      await tx
        .update(threadParticipant)
        .set({ role: GroupRole.MEMBER, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.accountId, params.fromUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        );
      await tx
        .update(threadParticipant)
        .set({ role: GroupRole.OWNER, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.accountId, params.toUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        );
      await tx
        .update(group)
        .set({ updatedAt: now })
        .where(
          sql`${group.id} = (SELECT "groupId" FROM "MessageThread" WHERE id = ${params.threadId})`,
        );
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      await this.relationshipCommands.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.fromUserId,
        clientFeedUpdates,
      );
      await this.relationshipCommands.reconcileGroupJoinRequestManagerInTx(
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
    const operator = await this.database.db.query.threadMember.findFirst({
      where: and(
        eq(threadMember.userId, params.operatorUserId),
        eq(threadMember.threadId, params.threadId),
        eq(threadMember.left, false),
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
    const target = await this.database.db.query.threadMember.findFirst({
      where: and(
        eq(threadMember.userId, params.targetUserId),
        eq(threadMember.threadId, params.threadId),
        eq(threadMember.left, false),
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
        .update(threadMember)
        .set({ role: params.role, updatedAt: new Date() })
        .where(eq(threadMember.id, target.id));
      await tx
        .update(threadParticipant)
        .set({ role: params.role, updatedAt: new Date() })
        .where(
          and(
            eq(threadParticipant.accountId, params.targetUserId),
            eq(threadParticipant.threadId, params.threadId),
          ),
        );
      const [trd] = await tx
        .select({ groupId: messageThread.groupId })
        .from(messageThread)
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (trd?.groupId != null)
        await tx
          .update(group)
          .set({
            updatedAt: new Date(),
          })
          .where(eq(group.id, trd.groupId));
      const state = await this.federation.writeGroupStateInTx(
        tx,
        params.threadId,
        clientFeedUpdates,
      );
      await this.relationshipCommands.reconcileGroupJoinRequestManagerInTx(
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
      .select({ userId: threadMember.userId })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.left, false),
          eq(user.domain, 'local'),
          eq(user.availability, 'AVAILABLE'),
        ),
      );
    const authorized = await Promise.all(
      rows.map((row) => isThreadMutuallyAuthorized(tx, row.userId, threadId)),
    );
    return rows
      .filter((_, index) => authorized[index])
      .map((row) => row.userId);
  }

  /** Update a group's independent profile. */
  async updateGroup(params: {
    threadId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    const trd = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, params.threadId),
      columns: { groupId: true },
    });
    if (!trd || !trd.groupId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'group thread not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const [current] = await tx
        .select()
        .from(group)
        .where(eq(group.id, trd.groupId!))
        .for('update')
        .limit(1);
      if (!current) throw new Error('group disappeared during profile update');
      const nextRev = current.defaultProfileRev + 1;
      const name = params.name ?? current.name;
      const description = params.description ?? current.description;
      const avatar = params.avatar ?? current.avatar;
      await tx.insert(profileVersion).values({
        groupId: current.id,
        profileRev: nextRev,
        displayName: name,
        avatar,
        bio: description,
      });
      const [row] = await tx
        .update(group)
        .set({
          name,
          description,
          avatar,
          defaultProfileRev: nextRev,
          updatedAt: new Date(),
        })
        .where(eq(group.id, trd.groupId!))
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

  async assertGroupManagerInTx(
    tx: DatabaseTransaction,
    threadId: number,
    managerUserId: number,
  ): Promise<void> {
    const [manager] = await tx
      .select({ role: threadMember.role })
      .from(threadMember)
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, managerUserId),
          eq(threadMember.left, false),
        ),
      )
      .limit(1);
    if (
      (manager?.role !== GroupRole.OWNER &&
        manager?.role !== GroupRole.ADMIN) ||
      !(await isThreadMutuallyAuthorized(tx, managerUserId, threadId))
    ) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    }
  }

  private notifyCommandEffects(
    clientFeedUpdates: Array<{ userId: number; feedId: number }>,
    statePeers: Iterable<string>,
    operation: string,
  ): void {
    try {
      this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    } catch (error) {
      this.logger.warn(`${operation} client-state wake failed`, error);
    }
    void this.federation
      .pushStateFeedDomains(statePeers)
      .catch((error: unknown) =>
        this.logger.warn(`${operation} state-feed wake failed`, error),
      );
  }
}
