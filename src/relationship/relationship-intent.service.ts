import { parseRequestSnapshot, type RequestSnapshot } from '../../shared/request-snapshot.js';
import { authoredIntentWriteSql } from '../common/sql/authored-relationship-intent-sql.js';
import { groupStateSql } from '../group/shared/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';
import { Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  messageThread,
  relationshipIntent,
  relationshipPair,
  account as user,
} from '../database/schema.js';
import {
  RELATIONSHIP_INTENT_REQUEST_TTL_MS,
  isEffectiveRelationshipIntent,
  type RelationshipIntentStatus,
} from '../common/relationship-intent-state.js';
import {
  lockBusinessAccountsInTx,
  type BusinessScopeAddress,
} from '../common/locks/account-business-lock.js';
import { setLockedP2PPairActiveInTx } from './shared/p2p-pair-state.js';
import { lockAccountFeedAllocatorsInTx } from '../common/locks/account-feed-allocator-lock.js';

export type { RelationshipIntentStatus } from '../common/relationship-intent-state.js';

export interface RelationshipIntentState extends Record<string, unknown> {
  status: RelationshipIntentStatus;
  profileRev: number;
  note: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  requestedAt: Date | null;
  expiresAt: Date | null;
  snapshot?: RequestSnapshot | null;
}

/** One relationship endpoint. namespaceId is the endpoint's own identity
 * namespace — local endpoints are always 0; locality is never judged from a
 * domain. */
type RelationshipEndpoint = {
  type: 'USER' | 'GROUP';
  account: string;
  namespaceId: number;
};

type PairKey = {
  kind: 'P2P' | 'GROUP_MEMBER';
  endpointA: RelationshipEndpoint;
  endpointB: RelationshipEndpoint;
  /** The remote endpoint's own namespace; 0 when both endpoints are local.
   * Side A is always the local endpoint of a mixed pair. */
  endpointBNamespaceId: number;
  threadId: number | null;
};

/** The directed coordinates identifying one intent row: who requested whom. */
export interface IntentDirection {
  authorAccount: string;
  authorNamespaceId: number;
  receiverAccount: string;
  receiverNamespaceId: number;
}

/** Build the direction from one endpoint's coordinates to the other's. */
export function buildIntentDirection(
  author: { account: string; namespaceId: number },
  receiver: { account: string; namespaceId: number },
): IntentDirection {
  return {
    authorAccount: author.account,
    authorNamespaceId: author.namespaceId,
    receiverAccount: receiver.account,
    receiverNamespaceId: receiver.namespaceId,
  };
}

export type LockedPair = PairKey & {
  id: bigint;
  active: boolean;
};

type RawIntent = {
  status: RelationshipIntentStatus;
  profileRev: number;
  note: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  requestedAt: Date | null;
  expiresAt: Date | null;
  snapshot?: RequestSnapshot | null;
};

/** Serializes the two authored directions on a canonical Pair row. Pair.active is updated by the
 * owning relationship transaction after all state-machine side effects have been determined. */
@Injectable()
export class RelationshipIntentService {
  /** Read and lock an existing P2P relationship by Address without creating identity or pair rows. */
  async readP2PRelationshipByAddressInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
  ): Promise<
    | {
        pair: LockedPair;
        localSide: 'A' | 'B';
        remoteSide: 'A' | 'B';
        localIntent: RelationshipIntentState | undefined;
        remoteIntent: RelationshipIntentState | undefined;
      }
    | undefined
  > {
    const { key, local } = await this.prepareP2PAddressKeyInTx(
      tx,
      localUserId,
      remote,
    );
    await lockBusinessAccountsInTx(tx, [
      local,
      { account: remote.account, profileNamespaceId: remote.namespaceId },
    ]);
    const locked = await tx.execute<{
      id: string;
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT id, active, "threadId" FROM "RelationshipPair"
      WHERE kind = 'P2P'
        AND "endpointAType" = 'USER'
        AND "endpointAAccount" = ${key.endpointA.account}
        AND "endpointBType" = 'USER'
        AND "endpointBAccount" = ${key.endpointB.account}
        AND "endpointBNamespaceId" = ${key.endpointBNamespaceId}
      FOR NO KEY UPDATE
    `);
    const row = locked.rows[0];
    if (!row) return undefined;
    const pair: LockedPair = {
      ...key,
      id: BigInt(row.id),
      active: row.active,
      threadId: row.threadId,
    };
    await this.lockIntentRowsInTx(tx, pair);
    return {
      pair,
      localSide: key.localSide,
      remoteSide: key.remoteSide,
      localIntent: await this.readIntentInTx(tx, pair, key.localSide),
      remoteIntent: await this.readIntentInTx(tx, pair, key.remoteSide),
    };
  }

  async hasValidGroupInviteInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: AccountTarget;
      threadId: number;
      author: 'GROUP' | 'MEMBER';
    },
  ): Promise<boolean> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const intent = await this.readIntentInTx(
      tx,
      pair,
      pair.endpointA.type === 'GROUP'
        ? params.author === 'GROUP'
          ? 'A'
          : 'B'
        : params.author === 'GROUP'
          ? 'B'
          : 'A',
    );
    return isEffectiveRelationshipIntent(intent, new Date());
  }

  async writeGroupAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: AccountTarget;
      threadId: number;
      author: 'GROUP' | 'MEMBER';
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
    },
  ): Promise<{
    request: RelationshipIntentState;
    shouldBeActive: boolean;
    changed: boolean;
  }> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const groupSide =
      pair.endpointA.type === 'GROUP' ? pair.endpointA : pair.endpointB;
    const memberSide =
      groupSide === pair.endpointA ? pair.endpointB : pair.endpointA;
    return this.writeLockedGroupAuthoredIntentInTx(tx, {
      direction:
        params.author === 'GROUP'
          ? buildIntentDirection(groupSide, memberSide)
          : buildIntentDirection(memberSide, groupSide),
      threadId: params.threadId,
      threadLock: pair.threadLock,
      status: params.status,
      note: params.note,
      expiresAt: params.expiresAt,
    });
  }

  /** Write after the caller has acquired the canonical Pair, Intent, and
   * Thread locks. The thread lock is the runtime capability for this path. */
  async writeLockedGroupAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      direction: IntentDirection;
      threadId: number;
      threadLock: ThreadContentLock;
      status: RelationshipIntentStatus;
      snapshot?: RequestSnapshot | null;
      note?: string;
      expiresAt?: Date | null;
      validatedPairActive?: boolean;
    },
  ): Promise<{
    request: RelationshipIntentState;
    shouldBeActive: boolean;
    changed: boolean;
  }> {
    this.assertThreadLock(tx, params.threadId, params.threadLock);
    return this.writeAuthoredIntentOnPairInTx(tx, {
      direction: params.direction,
      threadId: params.threadId,
      status: params.status,
      snapshot: params.snapshot,
      note: params.note,
      expiresAt: params.expiresAt,
      ...(params.validatedPairActive === undefined
        ? {}
        : { validatedPairActive: params.validatedPairActive }),
    });
  }

  /** Callers still identify P2P endpoints by User id, but storage is always address-based. */
  async lockPairInTx(
    tx: DatabaseTransaction,
    firstUserId: AccountTarget,
    secondUserId: AccountTarget,
    threadId: number | null = null,
  ): Promise<LockedPair> {
    return this.lockUserPairMutationInTx(
      tx,
      firstUserId,
      secondUserId,
      threadId,
    );
  }

  async readP2PRelationshipInTx(
    tx: DatabaseTransaction,
    firstUserId: AccountTarget,
    secondUserId: AccountTarget,
  ) {
    const pair = await this.lockUserPairMutationInTx(
      tx,
      firstUserId,
      secondUserId,
      null,
    );
    const firstSide = await this.userSideInPair(tx, pair, firstUserId);
    const secondSide = firstSide === 'A' ? 'B' : 'A';
    return {
      pair,
      firstSide,
      secondSide,
      firstIntent: await this.readIntentInTx(tx, pair, firstSide),
      secondIntent: await this.readIntentInTx(tx, pair, secondSide),
      shouldBeActive: await this.shouldBeActiveInTx(
        tx,
        this.intentDirection(pair, 'A'),
      ),
    };
  }

  async setPairActiveInTx(
    tx: DatabaseTransaction,
    firstUserId: AccountTarget,
    secondUserId: AccountTarget,
    active: boolean,
  ): Promise<boolean> {
    const pair = await this.lockUserPairMutationInTx(
      tx,
      firstUserId,
      secondUserId,
      null,
    );
    return setLockedP2PPairActiveInTx(tx, pair.id, active);
  }

  async setGroupPairActiveInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: AccountTarget;
      threadId: number;
      active: boolean;
    },
  ): Promise<{ changed: boolean; threadLock: ThreadContentLock }> {
    const located = await tx.execute<{
      groupAccount: string;
      groupNamespaceId: number;
    }>(sql`
      SELECT group_profile.account AS "groupAccount",
        group_profile."namespaceId" AS "groupNamespaceId"
      FROM ${groupStateSql} group_profile
      WHERE group_profile.id = ${params.groupId}
    `);
    const group = located.rows[0];
    if (!group) throw new Error('group relationship endpoint does not exist');
    await lockBusinessAccountsInTx(tx, [
      {
        account: group.groupAccount,
        profileNamespaceId: group.groupNamespaceId,
      },
    ]);
    const pair = await this.lockGroupMutationInTx(tx, params);
    const groupEndpoint =
      pair.endpointA.type === 'GROUP' ? pair.endpointA : pair.endpointB;
    const memberEndpoint =
      groupEndpoint === pair.endpointA ? pair.endpointB : pair.endpointA;
    if (
      groupEndpoint.account !== group.groupAccount ||
      groupEndpoint.namespaceId !== group.groupNamespaceId
    )
      throw new Error('group identity changed while acquiring business lock');
    const changed = await this.setLockedGroupPairActiveInTx(tx, {
      pairId: pair.id,
      threadId: params.threadId,
      threadLock: pair.threadLock,
      memberLocal: memberEndpoint.namespaceId === 0,
      active: params.active,
    });
    return { changed, threadLock: pair.threadLock };
  }

  /** Fold Pair.active after a caller-owned locked intent mutation. */
  async setLockedGroupPairActiveInTx(
    tx: DatabaseTransaction,
    params: {
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      memberLocal: boolean;
      active: boolean;
    },
  ): Promise<boolean> {
    this.assertThreadLock(tx, params.threadId, params.threadLock);
    const changed = await this.updateLockedGroupPairActiveInTx(
      tx,
      params.pairId,
      params.active,
    );
    if (changed && params.active && params.memberLocal)
      await tx.execute(sql`
        UPDATE "MessageThread"
        SET "federationRoundsEnabled" = true, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${params.threadId}
      `);
    if (changed && !params.active && params.memberLocal)
      await tx.execute(sql`
        UPDATE "MessageThread" thread
        SET "authorizationEpoch" = thread."authorizationEpoch" + 1,
          "federationRoundsEnabled" = false,
          "updatedAt" = CURRENT_TIMESTAMP
        FROM ${groupStateSql} group_profile
        WHERE thread.id = ${params.threadId}
          AND thread.id = group_profile.id
          AND group_profile."namespaceId" > 0
            AND NOT EXISTS (
            SELECT 1
            FROM "RelationshipPair" remaining_pair
            WHERE remaining_pair."threadId" = thread.id
              AND remaining_pair.kind = 'GROUP_MEMBER'
              AND remaining_pair.active = true
              AND (
                (remaining_pair."endpointAType" = 'GROUP'
                  AND remaining_pair."endpointAAccount" = group_profile.account
                  AND remaining_pair."endpointBNamespaceId" = group_profile."namespaceId"
                  AND remaining_pair."endpointBType" = 'USER'
                  AND remaining_pair."endpointBNamespaceId" <> 0
                  AND remaining_pair."endpointANamespaceId" = 0)
                OR
                (remaining_pair."endpointBType" = 'GROUP'
                  AND remaining_pair."endpointBAccount" = group_profile.account
                  AND remaining_pair."endpointBNamespaceId" = group_profile."namespaceId"
                  AND remaining_pair."endpointAType" = 'USER'
                  AND remaining_pair."endpointANamespaceId" = 0)
              )
          )
      `);
    return changed;
  }

  /** Reads the member-authored profile reference captured for the current membership interval. */
  async readGroupMemberProfileRevInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: AccountTarget;
      threadId: number;
    },
  ): Promise<number> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const member = await accountAddressInTx(tx, params.memberUserId);
    const group = this.otherPairEndpoint(
      pair,
      member.account,
      member.namespaceId,
    );
    return this.readLockedGroupMemberProfileRevInTx(tx, {
      direction: buildIntentDirection(member, group),
      threadId: params.threadId,
      threadLock: pair.threadLock,
    });
  }

  async readLockedGroupMemberProfileRevInTx(
    tx: DatabaseTransaction,
    params: {
      direction: IntentDirection;
      threadId: number;
      threadLock: ThreadContentLock;
    },
  ): Promise<number> {
    this.assertThreadLock(tx, params.threadId, params.threadLock);
    const intent = await this.readIntentByDirectionInTx(tx, params.direction);
    if (!intent)
      throw new Error('active group member has no member-authored intent');
    if (!Number.isSafeInteger(intent.profileRev) || intent.profileRev < 0)
      throw new Error('active group member has an invalid profile revision');
    return intent.profileRev;
  }

  /** Row-lock set for group-relationship mutations. The caller's transaction
   * must already hold the group's business-scope advisory — advisory locks live
   * only at the flow entry, never inside nested helpers — so every entry takes
   * `lockBusinessAccountsInTx([group])` before reaching here. */
  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: AccountTarget;
      threadId: number;
      projectionUserIds?: readonly number[];
      /** Acquire these allocators before participant rows, after relationship locks. */
      feedAllocatorUserIds?: readonly number[];
    },
  ): Promise<LockedPair & { threadLock: ThreadContentLock }> {
    const member = await accountAddressInTx(tx, params.memberUserId);
    const located = await tx.execute<{
      groupAccount: string;
      groupNamespaceId: number;
      memberAccount: string;
      profileNamespaceId: number;
    }>(sql`
      SELECT group_profile.account AS "groupAccount",
        group_profile."namespaceId" AS "groupNamespaceId",
        ${member.account}::text AS "memberAccount",
        ${member.namespaceId}::integer AS "profileNamespaceId"
      FROM ${groupStateSql} group_profile
      WHERE group_profile.id = ${params.groupId}
    `);
    const location = located.rows[0];
    if (!location)
      throw new Error('group relationship endpoint does not exist');

    const row = location;

    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.groupId,
      params.threadId,
    );

    const pair = await this.lockCanonicalPairInTx(
      tx,
      this.prepareGroupMemberKey(
        {
          type: 'GROUP',
          account: row.groupAccount,
          namespaceId: row.groupNamespaceId,
        },
        {
          type: 'USER',
          account: row.memberAccount,
          namespaceId: row.profileNamespaceId,
        },
        params.threadId,
      ),
    );
    await this.lockIntentRowsInTx(tx, pair);

    await lockAccountFeedAllocatorsInTx(tx, params.feedAllocatorUserIds ?? []);
    const projectionUserIds = [...new Set(params.projectionUserIds ?? [])];
    await tx.execute(sql`
      SELECT participant.id FROM "AccountThreadState" participant
      JOIN "Account" owner ON owner.id = participant."accountId"
      WHERE participant."threadId" = ${params.threadId}
        AND ((owner.account = ${member.account} AND ${member.namespaceId} = 0)
          OR owner.id = ANY(${sql.param(projectionUserIds)}::integer[]))
      ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
    `);
    return { ...pair, threadLock };
  }

  async lockGroupBusinessScopeInTx(
    tx: DatabaseTransaction,
    address: BusinessScopeAddress,
  ): Promise<void> {
    await lockBusinessAccountsInTx(tx, [address]);
  }

  private async writeAuthoredIntentOnPairInTx(
    tx: DatabaseTransaction,
    params: {
      direction: IntentDirection;
      threadId: number | null;
      status: RelationshipIntentStatus;
      snapshot?: RequestSnapshot | null;
      note?: string;
      expiresAt?: Date | null;
      validatedPairActive?: boolean;
    },
  ) {
    let status = params.status;
    if (params.validatedPairActive === undefined) {
      const reverse = await this.readIntentByDirectionInTx(
        tx,
        this.reverseDirection(params.direction),
      );
      const current = await this.readIntentByDirectionInTx(
        tx,
        params.direction,
      );
      const reverseIsCurrent = isEffectiveRelationshipIntent(
        reverse,
        new Date(),
      );
      if (
        params.status === 'ACCEPTED' &&
        !reverseIsCurrent &&
        current?.status !== 'ACCEPTED'
      )
        throw new Error('cannot accept without a current reverse relationship');
      if (params.status === 'REQUESTED' && reverseIsCurrent)
        status = 'ACCEPTED';
    }
    const requestedAt = status !== 'REVOKED' ? new Date() : null;
    const expiresAt =
      status === 'REQUESTED'
        ? (params.expiresAt ??
          new Date(requestedAt!.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS))
        : null;
    const direction = params.direction;
    const written = await tx.execute(
      authoredIntentWriteSql({
        author: {
          account: direction.authorAccount,
          namespaceId: direction.authorNamespaceId,
        },
        receiver: {
          account: direction.receiverAccount,
          namespaceId: direction.receiverNamespaceId,
        },
        threadId: params.threadId,
        note: params.note ?? '',
        requestedAt,
        expiresAt,
        ...(status === 'REQUESTED'
          ? { status: 'REQUESTED' as const, snapshot: parseRequestSnapshot(params.snapshot) }
          : { status }),
      }),
    );
    const raw = await this.readIntentByDirectionInTx(tx, params.direction);
    if (!raw) throw new Error('relationship intent write disappeared');
    return {
      request: raw,
      shouldBeActive:
        params.validatedPairActive ??
        (await this.shouldBeActiveInTx(tx, params.direction)),
      changed: (written.rowCount ?? 0) > 0,
    };
  }

  private async lockUserPairMutationInTx(
    tx: DatabaseTransaction,
    firstUserId: AccountTarget,
    secondUserId: AccountTarget,
    threadId: number | null,
  ): Promise<LockedPair> {
    const first = await accountAddressInTx(tx, firstUserId);
    const second = await accountAddressInTx(tx, secondUserId);
    const key = this.prepareP2PKey(first, second, threadId);
    await lockBusinessAccountsInTx(tx, [
      { account: first.account, profileNamespaceId: first.namespaceId },
      { account: second.account, profileNamespaceId: second.namespaceId },
    ]);
    const pair = await this.lockCanonicalPairInTx(tx, key);
    if (pair.threadId !== null) {
      const thread = await tx
        .select({ id: messageThread.id })
        .from(messageThread)
        .where(eq(messageThread.id, pair.threadId))
        .for('no key update')
        .limit(1);
      if (!thread[0]) throw new Error('P2P relationship thread does not exist');
    }
    await this.lockIntentRowsInTx(tx, pair);
    return pair;
  }

  private async prepareP2PAddressKeyInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
  ): Promise<{
    key: PairKey & { localSide: 'A' | 'B'; remoteSide: 'A' | 'B' };
    local: BusinessScopeAddress;
  }> {
    const localAccount = await tx.query.account.findFirst({
      where: and(eq(user.id, localUserId), eq(user.namespaceId, 0)),
      columns: { account: true, namespaceId: true },
    });
    if (!localAccount)
      throw new Error('local relationship endpoint does not exist');
    const prepared = this.prepareP2PKey(localAccount, remote, null);
    return {
      key: {
        ...prepared,
        localSide: prepared.firstSide,
        remoteSide: prepared.secondSide,
      },
      local: {
        account: localAccount.account,
        profileNamespaceId: localAccount.namespaceId,
      },
    };
  }

  /** Build the same canonical identity for lookups and mutations, without creating rows or locking. */
  private prepareP2PKey(
    first: { account: string; namespaceId: number },
    second: { account: string; namespaceId: number },
    threadId: number | null,
  ): PairKey & { firstSide: 'A' | 'B'; secondSide: 'A' | 'B' } {
    const endpoint = (address: typeof first): RelationshipEndpoint => ({
      type: 'USER',
      account: normalizeAccount(address.account),
      namespaceId: address.namespaceId,
    });
    const firstEndpoint = endpoint(first);
    const secondEndpoint = endpoint(second);
    if (this.compareEndpoints(firstEndpoint, secondEndpoint) === 0)
      throw new Error('relationship endpoints must be distinct');
    const [endpointA, endpointB] = [firstEndpoint, secondEndpoint].sort(
      (left, right) => this.compareEndpoints(left, right),
    );
    const firstSide = endpointA === firstEndpoint ? 'A' : 'B';
    return {
      kind: 'P2P',
      endpointA: endpointA!,
      endpointB: endpointB!,
      endpointBNamespaceId: this.pairPeerNamespaceId(
        firstEndpoint,
        secondEndpoint,
      ),
      threadId,
      firstSide,
      secondSide: firstSide === 'A' ? 'B' : 'A',
    };
  }

  private prepareGroupMemberKey(
    group: RelationshipEndpoint,
    member: RelationshipEndpoint,
    threadId: number | null,
  ): PairKey {
    if (this.compareEndpoints(group, member) === 0)
      throw new Error('relationship endpoints must be distinct');
    const [endpointA, endpointB] = [group, member].sort((left, right) =>
      this.compareEndpoints(left, right),
    );
    return {
      kind: 'GROUP_MEMBER',
      endpointA: endpointA!,
      endpointB: endpointB!,
      endpointBNamespaceId: this.pairPeerNamespaceId(group, member),
      threadId,
    };
  }

  private async lockCanonicalPairInTx(
    tx: DatabaseTransaction,
    key: PairKey,
  ): Promise<LockedPair> {
    await tx
      .insert(relationshipPair)
      .values({
        kind: key.kind,
        endpointAType: key.endpointA.type,
        endpointAAccount: key.endpointA.account,
        endpointBType: key.endpointB.type,
        endpointBAccount: key.endpointB.account,
        endpointBNamespaceId: key.endpointBNamespaceId,
        threadId: key.threadId,
      })
      .onConflictDoNothing();
    if (key.threadId !== null)
      await tx
        .update(relationshipPair)
        .set({ threadId: key.threadId, updatedAt: new Date() })
        .where(
          and(
            eq(relationshipPair.endpointAType, key.endpointA.type),
            eq(relationshipPair.endpointAAccount, key.endpointA.account),
            eq(relationshipPair.endpointBType, key.endpointB.type),
            eq(relationshipPair.endpointBAccount, key.endpointB.account),
            eq(relationshipPair.endpointBNamespaceId, key.endpointBNamespaceId),
          ),
        );
    const locked = await tx.execute<{
      id: string;
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT id, active, "threadId" FROM "RelationshipPair"
      WHERE "endpointAType" = ${key.endpointA.type}
        AND "endpointAAccount" = ${key.endpointA.account}
        AND "endpointBType" = ${key.endpointB.type}
        AND "endpointBAccount" = ${key.endpointB.account}
        AND "endpointBNamespaceId" = ${key.endpointBNamespaceId}
      FOR NO KEY UPDATE
    `);
    const row = locked.rows[0];
    if (!row) throw new Error('relationship pair lock disappeared');
    return {
      ...key,
      id: BigInt(row.id),
      active: row.active,
      threadId: row.threadId,
    };
  }

  private async updateLockedGroupPairActiveInTx(
    tx: DatabaseTransaction,
    pairId: bigint,
    active: boolean,
  ): Promise<boolean> {
    const changed = await tx.execute(sql`
      UPDATE "RelationshipPair"
      SET active = ${active}, established = established OR ${active}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${pairId} AND active IS DISTINCT FROM ${active}
      RETURNING id
    `);
    return (changed.rowCount ?? 0) > 0;
  }

  private assertThreadLock(
    tx: DatabaseTransaction,
    threadId: number,
    threadLock: ThreadContentLock,
  ): void {
    if (threadLock.tx !== tx || threadLock.threadId !== threadId)
      throw new Error('invalid group relationship thread lock capability');
  }

  private async lockIntentRowsInTx(
    tx: DatabaseTransaction,
    pair: PairKey,
  ): Promise<void> {
    await tx
      .select({ authorAccount: relationshipIntent.authorAccount })
      .from(relationshipIntent)
      .where(
        or(
          and(
            eq(relationshipIntent.authorAccount, pair.endpointA.account),
            eq(
              relationshipIntent.authorNamespaceId,
              pair.endpointA.namespaceId,
            ),
            eq(relationshipIntent.receiverAccount, pair.endpointB.account),
            eq(
              relationshipIntent.receiverNamespaceId,
              pair.endpointB.namespaceId,
            ),
          ),
          and(
            eq(relationshipIntent.authorAccount, pair.endpointB.account),
            eq(
              relationshipIntent.authorNamespaceId,
              pair.endpointB.namespaceId,
            ),
            eq(relationshipIntent.receiverAccount, pair.endpointA.account),
            eq(
              relationshipIntent.receiverNamespaceId,
              pair.endpointA.namespaceId,
            ),
          ),
        ),
      )
      .orderBy(
        relationshipIntent.authorAccount,
        relationshipIntent.authorNamespaceId,
        relationshipIntent.receiverAccount,
        relationshipIntent.receiverNamespaceId,
      )
      .for('no key update');
  }

  /** The directed coordinates from one pair endpoint to the other. */
  private intentDirection(
    pair: PairKey,
    authorEndpoint: 'A' | 'B',
  ): IntentDirection {
    return buildIntentDirection(
      authorEndpoint === 'A' ? pair.endpointA : pair.endpointB,
      authorEndpoint === 'A' ? pair.endpointB : pair.endpointA,
    );
  }

  private reverseDirection(direction: IntentDirection): IntentDirection {
    return {
      authorAccount: direction.receiverAccount,
      authorNamespaceId: direction.receiverNamespaceId,
      receiverAccount: direction.authorAccount,
      receiverNamespaceId: direction.authorNamespaceId,
    };
  }

  private otherPairEndpoint(
    pair: PairKey,
    account: string,
    namespaceId: number,
  ): RelationshipEndpoint {
    return pair.endpointA.account === account &&
      pair.endpointA.namespaceId === namespaceId
      ? pair.endpointB
      : pair.endpointA;
  }

  private async readIntentByDirectionInTx(
    tx: DatabaseTransaction,
    direction: {
      authorAccount: string;
      authorNamespaceId: number;
      receiverAccount: string;
      receiverNamespaceId: number;
    },
  ): Promise<RawIntent | undefined> {
    return tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorAccount, direction.authorAccount),
        eq(relationshipIntent.authorNamespaceId, direction.authorNamespaceId),
        eq(relationshipIntent.receiverAccount, direction.receiverAccount),
        eq(
          relationshipIntent.receiverNamespaceId,
          direction.receiverNamespaceId,
        ),
      ),
      columns: {
        status: true,
        snapshot: true,
        profileRev: true,
        note: true,
        messageEndSeq: true,
        tombstoneEndSeq: true,
        requestedAt: true,
        expiresAt: true,
      },
    });
  }

  private async readIntentInTx(
    tx: DatabaseTransaction,
    pair: PairKey,
    authorEndpoint: 'A' | 'B',
  ): Promise<RawIntent | undefined> {
    return this.readIntentByDirectionInTx(
      tx,
      this.intentDirection(pair, authorEndpoint),
    );
  }

  private async shouldBeActiveInTx(
    tx: DatabaseTransaction,
    direction: IntentDirection,
  ): Promise<boolean> {
    const intents = await tx
      .select({
        authorAccount: relationshipIntent.authorAccount,
        authorNamespaceId: relationshipIntent.authorNamespaceId,
        status: relationshipIntent.status,
        profileRev: relationshipIntent.profileRev,
        note: relationshipIntent.note,
        requestedAt: relationshipIntent.requestedAt,
        expiresAt: relationshipIntent.expiresAt,
      })
      .from(relationshipIntent)
      .where(
        or(
          and(
            eq(relationshipIntent.authorAccount, direction.authorAccount),
            eq(
              relationshipIntent.authorNamespaceId,
              direction.authorNamespaceId,
            ),
            eq(relationshipIntent.receiverAccount, direction.receiverAccount),
            eq(
              relationshipIntent.receiverNamespaceId,
              direction.receiverNamespaceId,
            ),
          ),
          and(
            eq(relationshipIntent.authorAccount, direction.receiverAccount),
            eq(
              relationshipIntent.authorNamespaceId,
              direction.receiverNamespaceId,
            ),
            eq(relationshipIntent.receiverAccount, direction.authorAccount),
            eq(
              relationshipIntent.receiverNamespaceId,
              direction.authorNamespaceId,
            ),
          ),
        ),
      );
    const bySide = new Map(
      intents.map((intent) => [
        intent.authorAccount === direction.authorAccount &&
        intent.authorNamespaceId === direction.authorNamespaceId
          ? 'A'
          : 'B',
        intent,
      ]),
    );
    const now = new Date();
    return (
      isEffectiveRelationshipIntent(bySide.get('A'), now) &&
      isEffectiveRelationshipIntent(bySide.get('B'), now)
    );
  }

  private async userSideInPair(
    tx: DatabaseTransaction,
    pair: LockedPair,
    userId: AccountTarget,
  ): Promise<'A' | 'B'> {
    const identity = await accountAddressInTx(tx, userId);
    if (
      pair.endpointA.type === 'USER' &&
      pair.endpointA.account === normalizeAccount(identity.account)
    )
      return 'A';
    if (
      pair.endpointB.type === 'USER' &&
      pair.endpointB.account === normalizeAccount(identity.account)
    )
      return 'B';
    throw new Error('user is not a relationship endpoint');
  }

  private isValidRequest(intent: RawIntent | undefined): boolean {
    return (
      intent?.status === 'REQUESTED' &&
      intent.expiresAt !== null &&
      intent.expiresAt.getTime() > Date.now()
    );
  }

  /** Canonical side order: the local endpoint (namespace 0) is side A; a
   * local-local pair orders endpoints by account string. */
  private compareEndpoints(
    left: RelationshipEndpoint,
    right: RelationshipEndpoint,
  ): number {
    const leftLocal = left.namespaceId === 0;
    const rightLocal = right.namespaceId === 0;
    if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
    return (
      left.account.localeCompare(right.account) ||
      left.type.localeCompare(right.type) ||
      left.namespaceId - right.namespaceId
    );
  }

  /** The one namespace a pair persists: the remote endpoint's own namespace,
   * or 0 when both endpoints are local. */
  private pairPeerNamespaceId(
    first: RelationshipEndpoint,
    second: RelationshipEndpoint,
  ): number {
    const firstLocal = first.namespaceId === 0;
    const secondLocal = second.namespaceId === 0;
    if (firstLocal && secondLocal) return 0;
    return firstLocal ? second.namespaceId : first.namespaceId;
  }
}
