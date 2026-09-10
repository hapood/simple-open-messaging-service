import {
  groupState as group,
  groupStateFields,
  readGroupState,
  isGroupDissolvedInTx,
} from './group-state.js';
import { p2pPeerRelation } from '../relationship/relationship-address.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import type { NamespacedAddress } from '../common/client-identity.js';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  groupAccount,
  clientStateFeed,
  groupRequestProjection,
  messageThread,
  profileTable,
  accountThreadState,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FederationService } from '../federation/federation.service.js';
import { FederationRelationshipMutationService } from '../federation/federation-relationship-mutation.service.js';
import { AuthoritativeGroupMetaMutationService } from '../federation/authoritative-group-meta-mutation.service.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';
import {
  readCurrentGroupMemberByAddressInTx,
  readCurrentGroupMemberInTx,
  readCurrentGroupOwnersInTx,
} from '../group-meta/current-group-roster.js';

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
 * MessageThread stores group coordinates; GroupAccount holds local group control state. The owner is
 * derived from the latest canonical Group Meta member operations. All group-management
 * operations now key on threadId (the stable handle, also used for messaging); the wire still calls it
 * `groupId` for frontend compatibility, but the value IS the threadId.
 *
 * Roster membership is stored in canonical Group Meta; AccountThreadState contains only local per-user state.
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
    private readonly relationshipMutations: FederationRelationshipMutationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly authoritativeGroupMeta: AuthoritativeGroupMetaMutationService,
    @Optional() private readonly messages?: MessageService,
  ) {}

  /** Resolve one active roster member by its exact wire-level address. */
  async resolveActiveMember(
    threadId: number,
    identity: { account: string; domain: string },
  ): Promise<NamespacedAddress & { name: string }> {
    return this.database.db.transaction(async (tx) => {
      const [thread] = await tx
        .select({ groupId: messageThread.id })
        .from(messageThread)
        .where(eq(messageThread.id, threadId))
        .limit(1);
      const member = thread?.groupId
        ? await readCurrentGroupMemberByAddressInTx(
            tx,
            thread.groupId,
            identity,
          )
        : undefined;
      if (!member)
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active group member',
        );
      const snapshot = await tx.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, member.account),
          eq(profileTable.domain, member.domain),
          eq(profileTable.namespaceId, member.namespaceId),
          eq(profileTable.profileRev, member.profileRev),
        ),
        columns: { displayName: true },
      });
      return {
        name: snapshot?.displayName ?? member.account,
        account: member.account,
        domain: member.domain,
        namespaceId: member.namespaceId,
      };
    });
  }

  /**
   * Build the invitation picker from server state. The client cannot infer this page from its cached
   * conversations because friendship, membership, and manager-facing invitation projections converge
   * independently across federation.
   */
  async queryInviteCandidates(
    threadId: number,
    managerUserId: number,
    afterThreadId?: number,
    search?: string,
    take = 20,
  ) {
    const normalizedSearch = search?.trim() ?? '';
    const pattern = `%${normalizedSearch.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = await this.database.db.execute<{
      threadId: number;
      namespaceId: number;
      profileRev: number;
      account: string;
      domain: string;
      name: string;
      avatar: string;
      bio: string;
      state: 'AVAILABLE' | 'INVITED' | 'MEMBER';
    }>(sql`
      SELECT friendship."threadId", friend.account, friend.domain, friend."namespaceId",
        COALESCE(peer_intent."profileRev", 0) AS "profileRev",
        COALESCE(snapshot."displayName", friend.account) AS name,
        COALESCE(snapshot.avatar, '') AS avatar, COALESCE(snapshot.bio, '') AS bio,
        CASE WHEN member.operation = 'UPSERT' THEN 'MEMBER'
          WHEN invitation.status = 'REQUESTED' AND invitation."expiresAt" > CURRENT_TIMESTAMP THEN 'INVITED'
          ELSE 'AVAILABLE' END AS state
      FROM "RelationshipPair" friendship
      JOIN "Account" actor ON actor.id = ${managerUserId}
      JOIN ${p2pPeerRelation(sql`friendship`, sql`actor`)} friend ON true
      JOIN "MessageThread" thread_scope ON thread_scope.id = ${threadId} AND thread_scope.type = 'GROUP'
      LEFT JOIN "RelationshipIntent" peer_intent ON peer_intent."pairId" = friendship.id AND peer_intent."authorSide" = friend.side
      LEFT JOIN "Profile" snapshot ON snapshot.account = friend.account AND snapshot.domain = friend.domain
        AND snapshot."namespaceId" = friend."namespaceId" AND snapshot."profileRev" = peer_intent."profileRev"
      LEFT JOIN LATERAL (
        SELECT member_fact.operation FROM "GroupMetaMemberFeed" member_fact
        WHERE member_fact."threadId" = thread_scope.id
          AND member_fact."memberAccount" = friend.account AND member_fact."memberDomain" = friend.domain
          AND member_fact."memberNamespaceId" = friend."namespaceId"
        ORDER BY member_fact."feedId" DESC LIMIT 1
      ) member ON true
      LEFT JOIN "GroupRequestProjection" invitation ON invitation."managerUserId" = ${managerUserId}
        AND invitation."threadId" = ${threadId} AND invitation."memberAccount" = friend.account
        AND invitation."memberDomain" = friend.domain AND invitation."memberNamespaceId" = friend."namespaceId"
        AND invitation.direction = 'INVITATION'
      WHERE friendship.kind = 'P2P' AND friendship.active = true AND friendship."threadId" IS NOT NULL
        ${afterThreadId === undefined ? sql.empty() : sql`AND friendship."threadId" > ${afterThreadId}`}
        ${normalizedSearch === '' ? sql.empty() : sql`AND (COALESCE(snapshot."displayName", friend.account) ILIKE ${pattern} ESCAPE '\\' OR friend.account ILIKE ${pattern} ESCAPE '\\' OR (friend.account || '@' || friend.domain) ILIKE ${pattern} ESCAPE '\\')`}
      ORDER BY friendship."threadId" ASC LIMIT ${take + 1}
    `);
    const page = rows.rows.slice(0, take);
    return {
      data: page,
      hasMore: rows.rows.length > take,
      afterThreadId: page.at(-1)?.threadId ?? null,
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
      namespaceId: number;
      profileRev: number;
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
        projection."memberAccount" AS account, projection."memberDomain" AS domain,
        projection."memberNamespaceId" AS "namespaceId", projection."memberProfileRev" AS "profileRev",
        COALESCE(snapshot."displayName", projection."memberAccount") AS name, COALESCE(snapshot.avatar, '') AS avatar, projection.note,
        (EXTRACT(EPOCH FROM projection."requestedAt") * 1000)::bigint AS "requestedAt",
        (EXTRACT(EPOCH FROM projection."expiresAt") * 1000)::bigint AS "expiresAt"
      FROM "GroupRequestProjection" projection
      LEFT JOIN "Profile" snapshot ON snapshot.account = projection."memberAccount"
        AND snapshot.domain = projection."memberDomain"
        AND snapshot."namespaceId" = projection."memberNamespaceId"
        AND snapshot."profileRev" = projection."memberProfileRev"
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
        JOIN "MessageThread" thread_scope
          ON thread_scope.id = projection."threadId"
        LEFT JOIN LATERAL (
          SELECT member_fact."memberAccount" AS account,
                 member_fact.operation, member_fact.body
          FROM "GroupMetaMemberFeed" member_fact
          WHERE member_fact."threadId" = thread_scope.id
            AND member_fact."memberAccount" = (SELECT account FROM "Account" WHERE id = projection."managerUserId")
            AND member_fact."memberDomain" = 'local' AND member_fact."memberNamespaceId" = 0
          ORDER BY member_fact."feedId" DESC
          LIMIT 1
        ) manager ON manager.operation = 'UPSERT'
         AND manager.body ->> 'role' IN ('OWNER', 'ADMIN')
        WHERE projection."expiresAt" <= CURRENT_TIMESTAMP
           OR manager.account IS NULL
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
                SELECT 1
                FROM (
                  SELECT member_fact.operation, member_fact.body
                  FROM "GroupMetaMemberFeed" member_fact
                  JOIN "MessageThread" thread_scope
                    ON thread_scope.id = member_fact."threadId"
                  WHERE thread_scope.id = ${candidate.threadId}
                    AND member_fact."memberAccount" = (SELECT account FROM "Account" WHERE id = ${candidate.managerUserId})
                    AND member_fact."memberDomain" = 'local' AND member_fact."memberNamespaceId" = 0
                  ORDER BY member_fact."feedId" DESC
                  LIMIT 1
                ) current_manager
                WHERE current_manager.operation = 'UPSERT'
                  AND current_manager.body ->> 'role' IN ('OWNER', 'ADMIN')
              ))`,
            ),
          )
          .returning({
            feedId: groupRequestProjection.feedId,
            account: groupRequestProjection.memberAccount,
            domain: groupRequestProjection.memberDomain,
            namespaceId: groupRequestProjection.memberNamespaceId,
          });
        removed += deleted.length;
        if (deleted.length === 0) continue;
        for (const memberUserId of new Set(
          deleted.map((row) => ({
            account: row.account,
            domain: row.domain,
            namespaceId: row.namespaceId,
          })),
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
    const applied = await this.database.db.transaction(async (tx) => {
      if (
        params.decision === 'ACCEPTED' &&
        (await isGroupDissolvedInTx(tx, params.threadId))
      )
        return false;
      const readRequest = () =>
        tx
          .execute<{
            account: string;
            domain: string;
            namespaceId: number;
            note: string;
          }>(
            sql`
        SELECT pair."endpointBAccount" AS account, pair."endpointBDomain" AS domain,
          CASE WHEN pair."endpointBDomain" = 'local' THEN 0 ELSE pair."endpointBNamespaceId" END AS "namespaceId", intent.note
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
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
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        candidate,
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
        await this.relationshipMutations.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          request,
          params.decision === 'ACCEPTED' ? request.note : '',
          params.decision,
          clientFeedUpdates,
          'APPLICATION',
        );
      return true;
    });
    if (!applied) return;
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
          .execute<{ account: string; domain: string; namespaceId: number }>(
            sql`
          SELECT pair."endpointBAccount" AS account, pair."endpointBDomain" AS domain,
          CASE WHEN pair."endpointBDomain" = 'local' THEN 0 ELSE pair."endpointBNamespaceId" END AS "namespaceId"
          FROM "RelationshipIntent" intent
          JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
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
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        candidate,
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
        await this.relationshipMutations.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          request,
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
        .select({ account: groupStateFields.account })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
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
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ thread: messageThread, group: groupStateFields })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, threadId))
        .limit(1);
      if (!row) return null;
      const [owner] = await readCurrentGroupOwnersInTx(tx, [row.group.id]);
      return {
        ...row.thread,
        group: {
          ...row.group,
          owner: owner?.identity ?? null,
        },
      };
    });
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
        owner: NamespacedAddress | null;
        dissolvedAt: Date | null;
      }
    >
  > {
    if (threadIds.length === 0) return new Map();
    const { threads, ownerByGroup } = await this.database.db.transaction(
      async (tx) => {
        const threads = await tx
          .select({ threadId: messageThread.id, group: groupStateFields })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.id))
          .where(inArray(messageThread.id, threadIds));
        const owners = await readCurrentGroupOwnersInTx(
          tx,
          threads.map((row) => row.group.id),
        );
        return {
          threads,
          ownerByGroup: new Map(
            owners.map((owner) => [owner.groupId, owner.identity]),
          ),
        };
      },
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
        owner: NamespacedAddress | null;
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
        profileRev: row.group.profileRev,
        owner: ownerByGroup.get(row.group.id) ?? null,
        dissolvedAt: row.group.dissolvedAt,
      });
    return m;
  }

  /**
   * Create a local group account, its initial immutable profile, and its conversation.
   * The owner's authored relationship creates the first canonical OWNER membership fact.
   * Retry a minted account collision without exposing any partial creation state.
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
          const [ownerAccount] = await tx
            .insert(groupAccount)
            .values({ account, defaultProfileRev: 1 })
            .returning();
          const [thread] = await tx
            .insert(messageThread)
            .values({
              type: MessageThreadType.GROUP,
              groupAccount: account,
              groupDomain: 'local',
              groupAccountId: ownerAccount.id,
              federationRoundsEnabled: true,
              authorityNamespaceId: 0,
              updatedAt: new Date(),
            })
            .returning();
          const groupState = {
            id: thread.id,
            account,
            name: params.name,
            avatar: params.avatar ?? '',
            description: params.description ?? '',
          };
          await tx.insert(profileTable).values({
            account,
            domain: 'local',
            namespaceId: 0,
            profileRev: 1,
            displayName: groupState.name,
            avatar: groupState.avatar,
            bio: groupState.description,
          });
          const clientFeedUpdates: Array<{
            userId: number;
            feedId: number;
          }> = [];
          await this.relationshipMutations.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'REQUESTED',
            clientFeedUpdates,
          );
          await this.relationshipMutations.writeMemberRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            'ACCEPTED',
            clientFeedUpdates,
            '',
            undefined,
            { initialRole: GroupRole.OWNER },
          );
          await this.relationshipMutations.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'ACCEPTED',
            clientFeedUpdates,
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
   * the group, preserving the invariant that every active group has exactly one owner.
   */
  async leaveGroup(params: {
    userId: AccountTarget;
    threadId: number;
    dissolvedFanout?: boolean;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const mutationLock =
        await this.relationshipMutations.lockGroupMutationInTx(
          tx,
          params.threadId,
          params.userId,
        );
      const [thread] = await tx
        .select({
          groupId: messageThread.id,
          groupAccount: groupStateFields.account,
          groupDomain: groupStateFields.domain,
          dissolvedAt: groupStateFields.dissolvedAt,
          namespaceId: groupStateFields.namespaceId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!thread?.groupId)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      if (params.dissolvedFanout && thread.dissolvedAt === null) {
        throw new Error('group member fan-out requires a dissolved group');
      }
      const identity = await accountAddressInTx(tx, params.userId);
      const [localMember] = await localAccountsForTargetsInTx(tx, [identity]);
      const currentMember = await readCurrentGroupMemberInTx(
        tx,
        thread.groupId,
        params.userId,
      );
      const outgoing = await tx.execute<{
        status: string;
        active: boolean;
      }>(sql`
        SELECT intent.status, pair.active
        FROM "RelationshipPair" pair
        LEFT JOIN "RelationshipIntent" intent
          ON intent."pairId" = pair.id AND intent."authorSide" = 'B'
        WHERE pair."threadId" = ${params.threadId}
          AND pair.kind = 'GROUP_MEMBER'
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = ${identity.account}
          AND pair."endpointBDomain" = ${identity.domain}
          AND (${identity.namespaceId} = 0
            OR pair."endpointBNamespaceId" = ${identity.namespaceId})
      `);
      if (!currentMember && outgoing.rows.length === 0)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'member not found');
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      if (
        transitioned &&
        !params.dissolvedFanout &&
        thread.groupDomain === 'local' &&
        currentMember?.role === GroupRole.OWNER
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_OWNER_MUST_TRANSFER,
          'transfer ownership or dissolve the group before leaving',
        );
      }
      if (transitioned && localMember && thread.groupDomain !== 'local') {
        await this.relationshipMutations.lockMemberRelationshipFeedInTx(tx, {
          domain: thread.groupDomain,
          namespaceId: thread.namespaceId,
        });
      }
      const systemMessage =
        transitioned && outgoing.rows[0]?.active === true && this.messages
          ? (
              await this.messages.writeDepartureMessageInTx(
                tx,
                params.threadId,
                SystemMessageType.GROUP_LEFT,
                params.userId,
                {
                  threadLock: mutationLock.threadLock,
                  actorUserId: params.userId,
                },
              )
            ).message
          : null;

      if (systemMessage && localMember)
        await tx
          .update(accountThreadState)
          .set({ messageVisibleThroughSeq: systemMessage.seq, updatedAt: now })
          .where(
            and(
              eq(accountThreadState.threadId, params.threadId),
              eq(accountThreadState.accountId, localMember.id),
            ),
          );

      if (transitioned) {
        await tx
          .update(messageThread)
          .set({ updatedAt: now })
          .where(eq(messageThread.id, params.threadId));
      }
      const requestState =
        transitioned && localMember !== undefined
          ? await this.relationshipMutations.writeMemberRelationshipIntentInTx(
              tx,
              params.threadId,
              localMember.id,
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
          await this.relationshipMutations.writeGroupRelationshipIntentInTx(
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
      if (localMember)
        await this.relationshipMutations.reconcileGroupJoinRequestManagerInTx(
          tx,
          params.threadId,
          localMember.id,
          clientFeedUpdates,
        );
      return {
        transitioned,
        statePeers: [...requestState.keys(), ...groupRequestState.keys()],
        clientFeedUpdates,
        systemMessage,
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
    if (
      result.transitioned &&
      !params.dissolvedFanout &&
      typeof params.userId === 'number'
    ) {
      void this.federation
        .notifyGroupLeave(params.threadId, params.userId)
        .catch((error: unknown) =>
          this.logger.warn('group leave notification failed', error),
        );
    }
    return {
      transitioned: result.transitioned,
    };
  }

  async revokeDissolvedGroupMember(params: {
    threadId: number;
    memberUserId: AccountTarget;
  }): Promise<void> {
    await this.leaveGroup({
      userId: params.memberUserId,
      threadId: params.threadId,
      dissolvedFanout: true,
    });
  }

  async resolveDisbandCommandScope(
    threadId: number,
    operatorUserId: number,
  ): Promise<{ account: string; domain: string }> {
    return this.database.db.transaction(async (tx) => {
      const [state] = await tx
        .select({
          groupId: group.id,
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, threadId))
        .limit(1);
      if (!state)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      const operator = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        operatorUserId,
      );
      if (
        state.domain !== 'local' ||
        state.namespaceId !== 0 ||
        operator?.domain !== 'local' ||
        operator.role !== GroupRole.OWNER ||
        !(await isThreadMutuallyAuthorized(tx, operatorUserId, threadId))
      )
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      return { account: state.account, domain: state.domain };
    });
  }

  async resolveGroupCommandScope(
    threadId: number,
  ): Promise<{ account: string; domain: string }> {
    const [state] = await this.database.db
      .select({
        account: groupStateFields.account,
        domain: groupStateFields.domain,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
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
  }): Promise<{ memberUserId: NamespacedAddress }> {
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
        columns: {
          memberAccount: true,
          memberDomain: true,
          memberNamespaceId: true,
        },
      });
    if (!request) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        params.direction === 'APPLICATION'
          ? 'join request not found'
          : 'group invitation not found',
      );
    }
    return {
      memberUserId: {
        account: request.memberAccount,
        domain: request.memberDomain,
        namespaceId: request.memberNamespaceId,
      },
    };
  }

  /** Commit only the terminal group fact. Member relationships are revoked by child commands. */
  async markGroupDissolved(params: {
    threadId: number;
    operatorUserId: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const [state] = await tx
        .select({
          groupId: group.id,
          groupAccount: groupStateFields.account,
          groupDomain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
          dissolvedAt: groupStateFields.dissolvedAt,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!state)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      const operator = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.operatorUserId,
      );
      if (
        state.groupDomain !== 'local' ||
        state.namespaceId !== 0 ||
        operator?.domain !== 'local' ||
        operator.role !== GroupRole.OWNER
      ) {
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      }
      if (state.dissolvedAt !== null) return { transitioned: false };
      if (
        !(await isThreadMutuallyAuthorized(
          tx,
          params.operatorUserId,
          params.threadId,
        ))
      )
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      const dissolved = await tx
        .update(groupAccount)
        .set({ dissolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(groupAccount.account, state.groupAccount),
            isNull(groupAccount.dissolvedAt),
          ),
        )
        .returning({ id: groupAccount.id });
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
    targetUserId: AccountTarget;
    reason?: string;
  }): Promise<{ transitioned: boolean }> {
    const result = await this.database.db.transaction(async (tx) => {
      const mutationLock =
        await this.relationshipMutations.lockGroupMutationInTx(
          tx,
          params.threadId,
          params.targetUserId,
          [params.operatorUserId],
        );
      const [thread] = await tx
        .select({
          groupId: group.id,
          groupAccount: groupStateFields.account,
          groupDomain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
          dissolvedAt: groupStateFields.dissolvedAt,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!thread)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      if (
        thread.groupDomain !== 'local' ||
        thread.namespaceId !== 0 ||
        thread.dissolvedAt !== null
      )
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'group membership authority is unavailable',
        );
      const operator = await readCurrentGroupMemberInTx(
        tx,
        thread.groupId,
        params.operatorUserId,
      );
      const target = await readCurrentGroupMemberInTx(
        tx,
        thread.groupId,
        params.targetUserId,
      );
      if (!target) {
        return {
          transitioned: false,
          clientFeedUpdates: [],
          statePeers: [],
          systemMessage: null,
        };
      }
      const operatorAuthorized = await isThreadMutuallyAuthorized(
        tx,
        params.operatorUserId,
        params.threadId,
      );
      const targetAuthorized = await isThreadMutuallyAuthorized(
        tx,
        params.targetUserId,
        params.threadId,
      );
      if (!targetAuthorized)
        return {
          transitioned: false,
          clientFeedUpdates: [],
          statePeers: [],
          systemMessage: null,
        };
      if (
        !operator ||
        !operatorAuthorized ||
        target.role === GroupRole.OWNER ||
        !outranks(operator.role, target.role)
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'you can only kick members below your role',
        );
      }
      const now = new Date();
      const [localTarget] = await localAccountsForTargetsInTx(tx, [target]);
      const systemMessage = this.messages
        ? (
            await this.messages.writeDepartureMessageInTx(
              tx,
              params.threadId,
              SystemMessageType.GROUP_LEFT,
              params.targetUserId,
              {
                threadLock: mutationLock.threadLock,
                actorUserId: params.operatorUserId,
              },
            )
          ).message
        : null;

      if (systemMessage && localTarget)
        await tx
          .update(accountThreadState)
          .set({ messageVisibleThroughSeq: systemMessage.seq, updatedAt: now })
          .where(
            and(
              eq(accountThreadState.threadId, params.threadId),
              eq(accountThreadState.accountId, localTarget.id),
            ),
          );

      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const requestState =
        await this.relationshipMutations.writeGroupRelationshipIntentInTx(
          tx,
          params.threadId,
          params.targetUserId,
          params.reason ?? '',
          'REVOKED',
          clientFeedUpdates,
        );
      if (localTarget) {
        const reverseState =
          await this.relationshipMutations.writeMemberRelationshipIntentInTx(
            tx,
            params.threadId,
            localTarget.id,
            'REVOKED',
            clientFeedUpdates,
          );
        for (const [domain, feedId] of reverseState)
          requestState.set(domain, feedId);
      }
      return {
        transitioned: true,
        clientFeedUpdates,
        statePeers: [...requestState.keys()],
        systemMessage,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.federation.pushStateFeedDomains(result.statePeers);
    return { transitioned: result.transitioned };
  }

  /** Transfer ownership atomically in the authoritative Group Meta roster. */
  async transferOwnership(params: {
    threadId: number;
    fromUserId: number;
    toUserId: AccountTarget;
  }): Promise<void> {
    if (params.toUserId === params.fromUserId) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot transfer ownership to yourself',
      );
    }
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const [localTarget] = await localAccountsForTargetsInTx(tx, [
        params.toUserId,
      ]);
      if (!localTarget)
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'ownership requires a local account',
        );
      if (localTarget.id === params.fromUserId)
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'cannot transfer ownership to yourself',
        );
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.fromUserId,
        [localTarget.id],
      );
      const [state] = await tx
        .select({
          groupId: group.id,
          groupAccount: groupStateFields.account,
          groupDomain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
          dissolvedAt: groupStateFields.dissolvedAt,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (
        !state ||
        state.groupDomain !== 'local' ||
        state.namespaceId !== 0 ||
        state.dissolvedAt !== null
      )
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'group role authority is unavailable',
        );
      const currentOwner = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.fromUserId,
      );
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
      const target = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.toUserId,
      );
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
      if (target.role === GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'target is already the owner',
        );
      }
      await this.authoritativeGroupMeta.applyRoleFactsInTx(tx, {
        threadId: params.threadId,
        groupId: state.groupId,
        changes: [
          { member: currentOwner, role: GroupRole.MEMBER },
          { member: target, role: GroupRole.OWNER },
        ],
      });
      await this.relationshipMutations.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        params.fromUserId,
        clientFeedUpdates,
      );
      await this.relationshipMutations.reconcileGroupJoinRequestManagerInTx(
        tx,
        params.threadId,
        localTarget.id,
        clientFeedUpdates,
      );
      await this.authoritativeGroupMeta.finalizeInTx(tx, {
        threadId: params.threadId,
        groupAccount: state.groupAccount,
      });
      return { clientFeedUpdates };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    await this.emitSystemMessage(
      params.fromUserId,
      params.threadId,
      SystemMessageType.GROUP_OWNER_TRANSFERRED,
      params.toUserId,
    );
  }

  /** Set ADMIN or MEMBER in the authoritative Group Meta roster. */
  async setRole(params: {
    threadId: number;
    targetUserId: AccountTarget;
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
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      const [localTarget] = await localAccountsForTargetsInTx(tx, [
        params.targetUserId,
      ]);
      if (localTarget?.id === params.operatorUserId)
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'cannot change your own role',
        );
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.operatorUserId,
        localTarget ? [localTarget.id] : [],
      );
      const [state] = await tx
        .select({
          groupId: group.id,
          groupAccount: groupStateFields.account,
          groupDomain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
          dissolvedAt: groupStateFields.dissolvedAt,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (
        !state ||
        state.groupDomain !== 'local' ||
        state.namespaceId !== 0 ||
        state.dissolvedAt !== null
      )
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'group role authority is unavailable',
        );
      const operator = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.operatorUserId,
      );
      if (
        operator?.role !== GroupRole.OWNER ||
        !(await isThreadMutuallyAuthorized(
          tx,
          params.operatorUserId,
          params.threadId,
        ))
      )
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'only the group owner may change administrator roles',
        );
      const target = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.targetUserId,
      );
      if (
        !target ||
        !(await isThreadMutuallyAuthorized(
          tx,
          params.targetUserId,
          params.threadId,
        ))
      )
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active member',
        );
      if (target.role === GroupRole.OWNER)
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          "cannot change the owner's role",
        );
      if (params.role === GroupRole.ADMIN && target.domain !== 'local')
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'cannot grant administrator role to a member on another server',
        );
      if (target.role === params.role)
        return { changed: false, clientFeedUpdates };

      await this.authoritativeGroupMeta.applyRoleFactsInTx(tx, {
        threadId: params.threadId,
        groupId: state.groupId,
        changes: [{ member: target, role: params.role }],
      });
      if (localTarget)
        await this.relationshipMutations.reconcileGroupJoinRequestManagerInTx(
          tx,
          params.threadId,
          localTarget.id,
          clientFeedUpdates,
        );
      await this.authoritativeGroupMeta.finalizeInTx(tx, {
        threadId: params.threadId,
        groupAccount: state.groupAccount,
      });
      return { changed: true, clientFeedUpdates };
    });
    if (!result.changed) return;
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
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
    type: Exclude<SystemMessageType, 'CALL_ENDED'>,
    subjectUserId?: AccountTarget,
  ): Promise<void> {
    if (!this.messages) return;
    await this.messages.tryWriteSystemMessage(threadId, type, subjectUserId, {
      actorUserId,
    });
  }

  /** Update a group's independent profile. */
  async updateGroup(params: {
    threadId: number;
    operatorUserId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    return this.database.db.transaction(async (tx) => {
      await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const [current] = await tx
        .select({ group: groupStateFields })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (!current)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group thread not found',
          HttpStatus.NOT_FOUND,
        );
      if (
        current.group.domain !== 'local' ||
        current.group.namespaceId !== 0 ||
        current.group.dissolvedAt !== null
      )
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'group profile authority is unavailable',
        );
      await this.assertGroupManagerInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const name = params.name ?? current.group.name;
      const description = params.description ?? current.group.description;
      const avatar = params.avatar ?? current.group.avatar;
      if (
        name === current.group.name &&
        description === current.group.description &&
        avatar === current.group.avatar
      )
        return current.group;

      const nextRev = current.group.profileRev + 1;
      await tx.insert(profileTable).values({
        account: current.group.account,
        domain: 'local',
        namespaceId: 0,
        profileRev: nextRev,
        displayName: name,
        avatar,
        bio: description,
      });
      await tx
        .update(groupAccount)
        .set({ defaultProfileRev: nextRev, updatedAt: new Date() })
        .where(eq(groupAccount.account, current.group.account));
      await tx
        .update(messageThread)
        .set({ updatedAt: new Date() })
        .where(eq(messageThread.id, params.threadId));
      const row = await readGroupState(tx, eq(group.id, params.threadId));
      if (!row) throw new Error('group profile update returned no row');
      await this.authoritativeGroupMeta.applyProfileFactInTx(
        tx,
        current.group.id,
        nextRev,
      );
      await this.authoritativeGroupMeta.finalizeInTx(tx, {
        threadId: params.threadId,
        groupAccount: current.group.account,
      });
      return row;
    });
  }

  async assertGroupManagerInTx(
    tx: DatabaseTransaction,
    threadId: number,
    managerUserId: number,
  ): Promise<void> {
    const [thread] = await tx
      .select({ groupId: messageThread.id })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    const manager = thread?.groupId
      ? await readCurrentGroupMemberInTx(tx, thread.groupId, managerUserId)
      : undefined;
    if (
      !manager ||
      manager.domain !== 'local' ||
      (manager.role !== GroupRole.OWNER && manager.role !== GroupRole.ADMIN) ||
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
