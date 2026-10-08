import { assertGroupNameLength } from './group-profile-validation.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import {
  groupState as group,
  groupStateFields,
  readGroupState,
} from './shared/group-state.js';
import { p2pPeerRelation } from '../relationship/shared/relationship-address.js';
import type { NamespacedAddress } from '../common/client-identity.js';
import type { RequestProjectionStatusValue } from '../../shared/request-projection-status.js';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  groupAccount,
  groupMeta,
  account as userAccount,
  accountThreadState,
  groupRequestProjection,
  messageThread,
  profileTable,
} from '../database/schema.js';
import { localIdentityDomain } from '../common/local-identity.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import {
  lockBusinessAccountsInTx,
  type BusinessScopeAddress,
} from '../common/locks/account-business-lock.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { captureThreadStateUpdatesInTx } from '../client-state-feed/capture-thread-state-updates.js';
import { lockAccountFeedAllocatorsInTx } from '../common/locks/account-feed-allocator-lock.js';
import { GroupRelationshipMutationService } from './membership-intent/shared/group-relationship-mutation.service.js';
import { GroupMetaFeedService } from './meta/group-meta-feed.service.js';
import { enqueueCurrentThreadFanoutsInTx } from '../message/thread-fanout-task.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import { MeasureBusinessOperation } from '../diagnostics/execution-measurement.js';
import {
  readCurrentGroupMemberByAddressInTx,
  readCurrentGroupMemberInTx,
  readCurrentGroupOwnersInTx,
  readCurrentLocalGroupManagersInTx,
} from './meta/current-group-roster.js';

/**
 * Group lifecycle and query support outside the authored membership and roster
 * business transactions.
 *
 * MessageThread stores group coordinates; GroupAccount holds local group control state. The owner is
 * derived from the latest canonical Group Meta member operations. All group-management
 * operations key on threadId (the stable handle, also used for messaging); API
 * fields named `groupId` carry that same threadId value.
 *
 * Roster membership is stored in canonical Group Meta; AccountThreadState contains only local per-user state.
 * Authorization is split:
 * ThreadAccessGuard + RolesGuard decide the OPERATOR's membership and role (throwing BusinessException →
 * HTTP 200 + domain code); the methods below validate TARGET-specific invariants and mutate.
 */
@Injectable()
export class GroupService {
  @Inject(DurableTaskQueueService)
  private readonly tasks!: DurableTaskQueueService;
  constructor(
    private database: DatabaseService,
    private readonly relationshipMutations: GroupRelationshipMutationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groupMeta: GroupMetaFeedService,
    private readonly messages: MessageService,
  ) {}

  /** Resolve a member's current roster details only after its pair is active. */
  async resolveActiveMember(
    threadId: number,
    identity: { account: string; namespaceId: number },
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
      if (!member || !(await isThreadMutuallyAuthorized(tx, member, threadId)))
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active group member',
        );
      const snapshot = await tx.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, member.account),
          eq(
            profileTable.publisherNamespaceId,
            member.namespaceId === 0 ? 0 : member.namespaceId,
          ),
          eq(profileTable.profileNamespaceId, member.namespaceId),
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
        friend.account AS name,
        '' AS avatar, '' AS bio,
        CASE WHEN member.operation = 'MEMBER_UPSERT' THEN 'MEMBER'
          WHEN invitation.status = 'REQUESTED' AND invitation."expiresAt" > CURRENT_TIMESTAMP THEN 'INVITED'
          ELSE 'AVAILABLE' END AS state
      FROM "RelationshipPair" friendship
      JOIN "Account" actor ON actor.id = ${managerUserId}
      JOIN ${p2pPeerRelation(sql`friendship`, sql`actor`)} friend ON true
      JOIN "MessageThread" thread_scope ON thread_scope.id = ${threadId} AND thread_scope.type = 'GROUP'
      LEFT JOIN "RelationshipIntent" peer_intent
        ON peer_intent."authorAccount" = friend.account
       AND peer_intent."authorNamespaceId" = friend."namespaceId"
       AND peer_intent."receiverAccount" = actor.account
       AND peer_intent."receiverNamespaceId" = 0
      LEFT JOIN LATERAL (
        SELECT member_fact.operation FROM "GroupMetaMemberFeed" member_fact
        WHERE member_fact."threadId" = thread_scope.id
          AND member_fact."memberAccount" = friend.account
          AND member_fact."profileNamespaceId" = friend."namespaceId"
        ORDER BY member_fact."feedId" DESC LIMIT 1
      ) member ON true
      LEFT JOIN "GroupRequestProjection" invitation ON
        invitation."threadId" = ${threadId} AND invitation."memberAccount" = friend.account
        AND invitation."profileNamespaceId" = friend."namespaceId"
        AND invitation.direction = 'INVITATION'
      WHERE friendship.kind = 'P2P' AND friendship.active = true AND friendship."threadId" IS NOT NULL
        ${afterThreadId === undefined ? sql.empty() : sql`AND friendship."threadId" > ${afterThreadId}`}
        ${normalizedSearch === '' ? sql.empty() : sql`AND (friend.account ILIKE ${pattern} ESCAPE '\\' OR (friend.account || '@' || friend.domain) ILIKE ${pattern} ESCAPE '\\')`}
      ORDER BY friendship."threadId" ASC LIMIT ${take + 1}
    `);
    const page = rows.rows.slice(0, take);
    return {
      data: page,
      hasMore: rows.rows.length > take,
      afterThreadId: page.at(-1)?.threadId ?? null,
    };
  }

  async queryJoinRequests(threadId: number, before?: number, take = 20) {
    return this.queryGroupRequests(threadId, 'APPLICATION', before, take);
  }

  async queryInvitations(threadId: number, before?: number, take = 20) {
    return this.queryGroupRequests(threadId, 'INVITATION', before, take);
  }

  private async queryGroupRequests(
    threadId: number,
    direction: 'APPLICATION' | 'INVITATION',
    before?: number,
    take = 20,
  ) {
    const rows = await this.database.db.execute<{
      feedId: number;
      status: RequestProjectionStatusValue;
      namespaceId: number;
      profileRev: number;
      account: string;
      name: string;
      avatar: string;
      note: string;
      requestedAt: number | null;
      expiresAt: number | null;
    }>(sql`
      SELECT projection."feedId",
        CASE WHEN projection.status = 'REQUESTED'
          AND projection."expiresAt" <= CURRENT_TIMESTAMP
          THEN 'EXPIRED' ELSE projection.status END AS status,
        projection."memberAccount" AS account,
        projection."profileNamespaceId" AS "namespaceId", projection."memberProfileRev" AS "profileRev",
        projection."memberAccount" AS name, '' AS avatar, projection.note,
        (EXTRACT(EPOCH FROM projection."requestedAt") * 1000)::bigint AS "requestedAt",
        (EXTRACT(EPOCH FROM projection."expiresAt") * 1000)::bigint AS "expiresAt"
      FROM "GroupRequestProjection" projection
      WHERE projection."threadId" = ${threadId}
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

  /** Physically collect expired projections. Current managers of affected
   * groups get a refreshed join-request head so their badge reflects the
   * removed rows; manager enumeration lives in the batch sweep only. */
  @Interval(60 * 60 * 1000)
  async garbageCollectJoinRequestProjections(): Promise<number> {
    const pending: PendingClientStateFeedUpdate[] = [];
    const count = await this.database.db.transaction(async (tx) => {
      const candidates = await tx.execute<{
        threadId: number;
        expiredThroughFeedId: number;
      }>(sql`
        SELECT projection."threadId",
          MAX(projection."feedId")::integer AS "expiredThroughFeedId"
        FROM "GroupRequestProjection" projection
        WHERE projection."expiresAt" <= CURRENT_TIMESTAMP
        GROUP BY projection."threadId"
      `);
      let removed = 0;
      for (const candidate of candidates.rows) {
        const deleted = await tx
          .delete(groupRequestProjection)
          .where(
            and(
              eq(groupRequestProjection.threadId, candidate.threadId),
              sql`${groupRequestProjection.expiresAt} <= CURRENT_TIMESTAMP`,
            ),
          );
        removed += deleted.rowCount ?? 0;
        if ((deleted.rowCount ?? 0) === 0) continue;
        const managers = await readCurrentLocalGroupManagersInTx(tx, {
          groupId: candidate.threadId,
          threadId: candidate.threadId,
        });
        const managerIds = managers.map((manager) => manager.userId);
        if (managerIds.length === 0) continue;
        await lockAccountFeedAllocatorsInTx(tx, managerIds);
        const updated = await tx.execute<{ accountId: number }>(sql`
          UPDATE "AccountThreadState"
          SET "joinRequestReadFeedId" = LEAST(
                "joinRequestEndFeedId",
                GREATEST("joinRequestReadFeedId", ${candidate.expiredThroughFeedId})),
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "threadId" = ${candidate.threadId}
            AND "accountId" IN (${sql.join(
              managerIds.map((id) => sql`${id}`),
              sql`, `,
            )})
            AND "joinRequestReadFeedId" >= 0
            AND "joinRequestReadFeedId" < LEAST(
              "joinRequestEndFeedId", ${candidate.expiredThroughFeedId})
          RETURNING "accountId" AS "accountId"
        `);
        pending.push(
          ...(await captureThreadStateUpdatesInTx(
            tx,
            updated.rows.map((row) => row.accountId),
          )),
        );
      }
      return removed;
    });
    this.clientStateFeed.notifyFeedUpdates(pending);
    return count;
  }

  async markJoinRequestsRead(
    threadId: number,
    managerUserId: number,
    joinRequestReadFeedId: number,
  ): Promise<void> {
    let pending: PendingClientStateFeedUpdate | undefined;
    await this.database.db.transaction(async (tx) => {
      await lockAccountFeedAllocatorsInTx(tx, [managerUserId]);
      const [updated] = await tx
        .update(accountThreadState)
        .set({
          joinRequestReadFeedId: sql`LEAST(${accountThreadState.joinRequestEndFeedId}, ${joinRequestReadFeedId})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(accountThreadState.accountId, managerUserId),
            eq(accountThreadState.threadId, threadId),
            sql`${accountThreadState.joinRequestReadFeedId} >= 0`,
            sql`${accountThreadState.joinRequestReadFeedId} < LEAST(${accountThreadState.joinRequestEndFeedId}, ${joinRequestReadFeedId})`,
          ),
        )
        .returning({ accountId: accountThreadState.accountId });
      if (!updated) return;
      [pending] = await captureThreadStateUpdatesInTx(tx, [updated.accountId]);
    });
    if (pending) this.clientStateFeed.notifyFeedUpdated(pending);
  }

  /** Exact public lookup; dissolved and uninitialized groups cannot be discovered. */
  async findPublicLocalGroupByAccount(account: string) {
    const row = await readGroupState(
      this.database.db,
      and(
        eq(groupStateFields.account, account),
        eq(groupStateFields.namespaceId, 0),
        isNull(groupStateFields.dissolvedAt),
      ),
    );
    return row && row.profileRev > 0 ? row : null;
  }

  /** Resolve a group address visible to a member without trusting a client-supplied thread id. */
  async findVisibleGroupByAddress(
    userId: number,
    address: { account: string; namespaceId: number },
  ) {
    const [row] = await this.database.db
      .select(groupStateFields)
      .from(group)
      .innerJoin(accountThreadState, eq(accountThreadState.threadId, group.id))
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          isNull(accountThreadState.messageVisibleThroughSeq),
          eq(groupStateFields.account, address.account),
          eq(groupStateFields.namespaceId, address.namespaceId),
        ),
      )
      .limit(1);
    return row ?? null;
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

  /**
   * Create a local group account, its initial immutable profile, and its conversation.
   * The owner's authored relationship creates the first canonical OWNER membership fact.
   * Retry a minted account collision without exposing any partial creation state.
   */
  @MeasureBusinessOperation('group.create')
  async createNewGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    owner: number;
  }) {
    assertGroupNameLength(params.name);
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
              groupDomain: await localIdentityDomain(tx),
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
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            profileRev: 1,
            displayName: groupState.name,
            avatar: groupState.avatar,
            bio: groupState.description,
          });
          const clientFeedUpdates: Array<{
            userId: number;
            feedId: number;
          }> = [];
          // Entry-scope advisory for the freshly minted group: uncontended, but
          // taken here so the seeding writers keep the entry-lock contract.
          await lockBusinessAccountsInTx(tx, [
            { account, profileNamespaceId: 0 },
          ]);
          // Establish an explicit cleared announcement before any origin feed
          // can be served; subsequent membership/profile facts use later ids.
          await tx.insert(groupMeta).values({
            threadId: thread.id,
            metaEndId: 1,
            announcementFeedId: 1,
            announcementText: null,
          });
          await this.relationshipMutations.writeGroupRelationshipIntentInTx(
            tx,
            thread.id,
            params.owner,
            '',
            'REQUESTED',
            clientFeedUpdates,
          );
          // The creation notice is authority-local history: federation message
          // feeds exclude SYSTEM rows. Write it before owner activation so the
          // new participant's read boundary initializes at this sequence.
          const owner = await tx.query.account.findFirst({
            where: eq(userAccount.id, params.owner),
            columns: {
              account: true,
              defaultProfileRev: true,
            },
          });
          if (!owner) throw new Error('group creator account is unavailable');
          await this.messages.writeSystemMessageInTx(tx, thread.id, {
            type: SystemMessageType.GROUP_CREATED,
            creator: {
              account: owner.account,
              domain: await localIdentityDomain(tx),
              profileNamespaceId: 0,
              profileRev: owner.defaultProfileRev,
            },
          });
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
  async resolveDisbandCommandScope(
    threadId: number,
    operatorUserId: number,
  ): Promise<BusinessScopeAddress> {
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
        state.namespaceId !== 0 ||
        operator?.namespaceId !== 0 ||
        operator.role !== GroupRole.OWNER ||
        !(await isThreadMutuallyAuthorized(tx, operatorUserId, threadId))
      )
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      return { account: state.account, profileNamespaceId: state.namespaceId };
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

  /** Commit the terminal group fact and its single GROUP_DISSOLVED boundary
   * message. Member relationships are revoked silently by child commands; the
   * message fans out to every still-active member here, so their watermarks
   * end at it and the children never touch the thread content. */
  @MeasureBusinessOperation('group.disband')
  async markGroupDissolved(params: {
    threadId: number;
    operatorUserId: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      // Entry-scope advisory: the group's business scope is held before any row
      // lock; nested writers never take advisories themselves.
      const [located] = await tx
        .select({
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (located)
        await lockBusinessAccountsInTx(tx, [
          {
            account: located.account,
            profileNamespaceId: located.namespaceId,
          },
        ]);
      const mutationLock =
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
      // Terminal short-circuit first: a replayed parent arrives after the
      // sweep has already revoked the owner, so the owner gate below can no
      // longer pass and must not be reached.
      if (state.dissolvedAt !== null) return { transitioned: false };
      const operator = await readCurrentGroupMemberInTx(
        tx,
        state.groupId,
        params.operatorUserId,
      );
      if (
        state.namespaceId !== 0 ||
        operator?.namespaceId !== 0 ||
        operator.role !== GroupRole.OWNER
      ) {
        throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
      }
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
      if (dissolved.length > 0) {
        // Gated on the transition so a replayed parent never writes a second
        // boundary. GROUP_LEFT-free by design: the sweep children are silent.
        await this.messages.writeSystemMessageInTx(
          tx,
          params.threadId,
          { type: SystemMessageType.GROUP_DISSOLVED },
          { threadLock: mutationLock.threadLock },
        );
      }
      return { transitioned: dissolved.length > 0 };
    });
  }

  /**
   * Kick a member by deactivating membership. The operator must strictly outrank the target; the owner
   * cannot be kicked. Throws GROUP_TARGET_NOT_MEMBER / GROUP_FORBIDDEN on invariant violation.
   */
  /** Acknowledge only a coordinate that could have been displayed from the
   * committed current group projection. A newer announcement never gets
   * acknowledged by a stale device; the account-local watermark is monotone. */
  async markAnnouncementRead(params: {
    threadId: number;
    accountId: number;
    feedId: number;
  }): Promise<{ announcementReadFeedId: number }> {
    let pending: PendingClientStateFeedUpdate | undefined;
    const result = await this.database.db.transaction(async (tx) => {
      await lockAccountFeedAllocatorsInTx(tx, [params.accountId]);
      const updated = await tx.execute<{ announcementReadFeedId: number }>(sql`
        UPDATE "AccountThreadState" state
        SET "announcementReadFeedId" = GREATEST(state."announcementReadFeedId", ${params.feedId}),
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "GroupMeta" meta
        WHERE state."threadId" = ${params.threadId}
          AND state."accountId" = ${params.accountId}
          AND meta."threadId" = state."threadId"
          AND meta."announcementFeedId" >= ${params.feedId}
          AND state."announcementReadFeedId" < ${params.feedId}
        RETURNING state."announcementReadFeedId"
      `);
      if (updated.rows[0]) {
        [pending] = await captureThreadStateUpdatesInTx(tx, [params.accountId]);
        return updated.rows[0];
      }
      const [current] = await tx
        .select({
          announcementReadFeedId: accountThreadState.announcementReadFeedId,
        })
        .from(accountThreadState)
        .where(
          and(
            eq(accountThreadState.threadId, params.threadId),
            eq(accountThreadState.accountId, params.accountId),
          ),
        )
        .limit(1);
      if (current && current.announcementReadFeedId >= params.feedId)
        return current;
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'announcement coordinate is not available',
      );
    });
    if (pending) this.clientStateFeed.notifyFeedUpdated(pending);
    return result;
  }

  async setAnnouncement(params: {
    threadId: number;
    operatorUserId: number;
    text: string | null;
  }): Promise<{ feedId: number }> {
    return this.database.db.transaction(async (tx) => {
      const [located] = await tx
        .select({
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (located)
        await lockBusinessAccountsInTx(tx, [
          {
            account: located.account,
            profileNamespaceId: located.namespaceId,
          },
        ]);
      const locked = await this.relationshipMutations.lockGroupMutationInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const current = await readGroupState(tx, eq(group.id, params.threadId));
      if (!current || current.namespaceId !== 0 || current.dissolvedAt !== null)
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'group announcement authority is unavailable',
        );
      await this.assertGroupManagerInTx(
        tx,
        params.threadId,
        params.operatorUserId,
      );
      const result = await this.groupMeta.reconcileAnnouncementInTx(
        tx,
        params.threadId,
        params.text,
      );
      if (result.changed)
        await enqueueCurrentThreadFanoutsInTx(tx, locked.threadLock);
      return { feedId: result.feedId };
    });
  }

  @MeasureBusinessOperation('group.update')
  async updateGroup(params: {
    threadId: number;
    operatorUserId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    assertGroupNameLength(params.name);
    return this.database.db.transaction(async (tx) => {
      // Entry-scope advisory: the group's business scope is held before any row
      // lock; nested writers never take advisories themselves.
      const [located] = await tx
        .select({
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, params.threadId))
        .limit(1);
      if (located)
        await lockBusinessAccountsInTx(tx, [
          {
            account: located.account,
            profileNamespaceId: located.namespaceId,
          },
        ]);
      const locked = await this.relationshipMutations.lockGroupMutationInTx(
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
      if (current.group.namespaceId !== 0 || current.group.dissolvedAt !== null)
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
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
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
      await this.groupMeta.reconcileProfileInTx(tx, current.group.id, nextRev);
      await enqueueCurrentThreadFanoutsInTx(tx, locked.threadLock);
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
      manager.namespaceId !== 0 ||
      (manager.role !== GroupRole.OWNER && manager.role !== GroupRole.ADMIN) ||
      !(await isThreadMutuallyAuthorized(tx, managerUserId, threadId))
    ) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only active group managers may handle requests',
      );
    }
  }
}
