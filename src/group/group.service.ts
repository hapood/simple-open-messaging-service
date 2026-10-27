import { parseRequestSnapshot } from '../../shared/request-snapshot.js';
import { assertGroupNameLength } from './group-profile-validation.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import {
  groupState as group,
  groupStateFields,
  readGroupState,
} from './shared/group-state.js';
import type { NamespacedAddress } from '../common/client-identity.js';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  account as userAccount,
  accountThreadState,
  messageThread,
  profileTable,
} from '../database/schema.js';
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
import { ThreadFeedHeadWriter } from '../message/thread-feed-head.writer.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import { MeasureBusinessOperation } from '../diagnostics/execution-measurement.js';
import {
  readCurrentGroupMemberByAddressInTx,
  readCurrentGroupMemberInTx,
  readCurrentGroupOwnersInTx,
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
        .select({
          groupId: messageThread.id,
          authorityNamespaceId: messageThread.authorityNamespaceId,
        })
        .from(messageThread)
        .where(eq(messageThread.id, threadId))
        .limit(1);
      const member = thread
        ? await readCurrentGroupMemberByAddressInTx(
            tx,
            thread.groupId,
            identity,
          )
        : undefined;
      // Authoritative groups materialize a RelationshipPair for every member,
      // so the pair check is the local write-authority membership view. A
      // member-home mirror holds pairs only for its own local members; there
      // the current Group Meta roster fact (upsert without a later depart) is
      // the membership authority for mention targets.
      if (!thread || !member)
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active group member',
        );
      const targetActive =
        thread.authorityNamespaceId > 0 ||
        (await isThreadMutuallyAuthorized(tx, member, threadId));
      if (!targetActive)
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active group member',
        );
      const snapshot = await tx.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, member.account),
          // Profiles are keyed by the publisher that projected them. The
          // authority node receives remote members' profiles from their homes
          // (publisher = the roster namespace, subject namespace 0), while
          // mirrors receive every member through the group authority's
          // projection (publisher = the authority namespace, subject
          // namespace = the roster namespace).
          thread.authorityNamespaceId === 0
            ? eq(profileTable.publisherNamespaceId, member.namespaceId)
            : eq(
                profileTable.publisherNamespaceId,
                thread.authorityNamespaceId,
              ),
          eq(
            profileTable.profileNamespaceId,
            thread.authorityNamespaceId === 0 ? 0 : member.namespaceId,
          ),
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
   * Create the revision-zero group and owner conversation first, then set its
   * profile in a separate transaction. Publish captured feed heads only after
   * both transactions commit. Account collision retries cover creation only.
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
      const result = await (async () => {
        try {
          return await this.database.db.transaction(async (tx) => {
            const [ownerAccount] = await tx
              .insert(groupAccount)
              .values({ account, defaultProfileRev: 0 })
              .returning();
            const [thread] = await tx
              .insert(messageThread)
              .values({
                type: MessageThreadType.GROUP,
                groupAccount: account,
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
            const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
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
            });
            await tx.insert(groupMetaMemberFeed).values({
              threadId: thread.id,
              feedId: 1,
              operation: 'GROUP_ANNOUNCEMENT',
              body: { text: null },
            });
            const owner = await tx.query.account.findFirst({
              where: eq(userAccount.id, params.owner),
              columns: { account: true, defaultProfileRev: true },
            });
            if (!owner) throw new Error('group creator account is unavailable');
            const ownerProfile =
              owner.defaultProfileRev > 0
                ? await tx.query.profileTable.findFirst({
                    where: and(
                      eq(profileTable.account, owner.account),
                      eq(profileTable.publisherNamespaceId, 0),
                      eq(profileTable.profileNamespaceId, 0),
                      eq(profileTable.profileRev, owner.defaultProfileRev),
                    ),
                    columns: { displayName: true, avatar: true },
                  })
                : null;
            if (owner.defaultProfileRev > 0 && !ownerProfile)
              throw new Error('group creator profile is unavailable');
            // Creation authors a founding invitation before the owner accepts it.
            // A revision-zero owner has account-name presentation, not a stored profile.
            const snapshot = parseRequestSnapshot({
              displayName: ownerProfile?.displayName ?? owner.account,
              avatar: ownerProfile?.avatar ? ownerProfile.avatar : null,
            });
            await this.relationshipMutations.writeGroupRelationshipIntentInTx(
              tx,
              thread.id,
              params.owner,
              '',
              'REQUESTED',
              clientFeedUpdates,
              undefined,
              { snapshot },
            );
            // The creation notice is authority-local history: federation message
            // feeds exclude SYSTEM rows. Write it before owner activation so the
            // new participant's read boundary initializes at this sequence.
            await this.messages.writeSystemMessageInTx(tx, thread.id, {
              type: SystemMessageType.GROUP_CREATED,
              creator: {
                account: owner.account,
                publisherNamespaceId: 0,
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
        } catch (e) {
          if (!isP2002(e)) throw e;
          return undefined;
        }
      })();
      if (!result) continue;
      const profileFeedUpdates = await this.database.db.transaction(
        async (tx) => {
          await this.updateGroupInTx(
            tx,
            {
              threadId: result.threadId,
              operatorUserId: params.owner,
              name: params.name,
              description: params.description ?? '',
              avatar: params.avatar ?? '',
            },
            [params.owner],
          );
          await ThreadFeedHeadWriter.reconcileGroupMetaCoordinateInTx(tx, {
            threadId: result.threadId,
            userIds: [params.owner],
          });
          return captureThreadStateUpdatesInTx(tx, [params.owner]);
        },
      );
      this.clientStateFeed.notifyFeedUpdates([
        ...result.clientFeedUpdates,
        ...profileFeedUpdates,
      ]);
      const { clientFeedUpdates: _clientFeedUpdates, ...groupResult } = result;
      return groupResult;
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
  ): Promise<{ account: string }> {
    const [state] = await this.database.db
      .select({
        account: groupStateFields.account,
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
        FROM "GroupMetaMemberFeed" meta
        WHERE state."threadId" = ${params.threadId}
          AND state."accountId" = ${params.accountId}
          AND meta."threadId" = state."threadId"
          AND meta.operation = 'GROUP_ANNOUNCEMENT'
          AND meta."feedId" >= ${params.feedId}
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
    return this.database.db.transaction((tx) =>
      this.updateGroupInTx(tx, params),
    );
  }

  private async updateGroupInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      operatorUserId: number;
      name?: string;
      description?: string;
      avatar?: string;
    },
    feedAllocatorUserIds: readonly number[] = [],
  ) {
    // Entry-scope advisory: the group's business scope is held before any row
    // lock; nested writers never take advisories themselves.
    const [located] = await tx
      .select({
        account: groupStateFields.account,
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
      [],
      feedAllocatorUserIds,
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
      current.group.profileRev !== 0 &&
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
      generatedAt: Date.now(),
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
