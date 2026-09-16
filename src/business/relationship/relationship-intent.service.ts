import { groupStateSql } from '../group/shared/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../../user/account-address.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../shared/locks/thread-content-lock.js';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../../common/account.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  messageThread,
  relationshipIntent,
  relationshipPair,
  account as user,
} from '../../database/schema.js';
import {
  RELATIONSHIP_INTENT_REQUEST_TTL_MS,
  isEffectiveRelationshipIntent,
  type RelationshipIntentStatus,
} from '../shared/relationship-intent-state.js';
import { lockBusinessAccountsInTx } from '../shared/locks/account-business-lock.js';
import { setLockedP2PPairActiveInTx } from './shared/p2p-pair-state.js';

export type { RelationshipIntentStatus } from '../shared/relationship-intent-state.js';

export interface RelationshipIntentState extends Record<string, unknown> {
  id: bigint;
  status: RelationshipIntentStatus;
  profileRev: number;
  note: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  requestedAt: Date | null;
  expiresAt: Date | null;
}

type RelationshipEndpoint = {
  type: 'USER' | 'GROUP';
  account: string;
  domain: string;
  namespaceId: number;
};

type PairKey = {
  kind: 'P2P' | 'GROUP_MEMBER';
  endpointA: RelationshipEndpoint;
  endpointB: RelationshipEndpoint;
  threadId: number | null;
};

export type LockedPair = PairKey & {
  id: bigint;
  active: boolean;
};

type RawIntent = {
  id: bigint;
  status: RelationshipIntentStatus;
  profileRev: number;
  note: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  requestedAt: Date | null;
  expiresAt: Date | null;
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
    const key = await this.prepareP2PAddressKeyInTx(tx, localUserId, remote);
    await lockBusinessAccountsInTx(tx, [key.endpointA, key.endpointB]);
    const locked = await tx.execute<{
      id: string;
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT id, active, "threadId" FROM "RelationshipPair"
      WHERE kind = 'P2P'
        AND "endpointAType" = 'USER'
        AND "endpointAAccount" = ${key.endpointA.account}
        AND "endpointADomain" = ${key.endpointA.domain}
        AND "endpointANamespaceId" = ${key.endpointA.namespaceId}
        AND "endpointBType" = 'USER'
        AND "endpointBAccount" = ${key.endpointB.account}
        AND "endpointBDomain" = ${key.endpointB.domain}
        AND "endpointBNamespaceId" = ${key.endpointB.namespaceId}
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
    await this.lockIntentRowsInTx(tx, pair.id);
    return {
      pair,
      localSide: key.localSide,
      remoteSide: key.remoteSide,
      localIntent: await this.readIntentInTx(tx, pair.id, key.localSide),
      remoteIntent: await this.readIntentInTx(tx, pair.id, key.remoteSide),
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
      pair.id,
      params.author === 'GROUP' ? 'A' : 'B',
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
    return this.writeLockedGroupAuthoredIntentInTx(tx, {
      pairId: pair.id,
      threadId: params.threadId,
      threadLock: pair.threadLock,
      authorSide: params.author === 'GROUP' ? 'A' : 'B',
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
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      authorSide: 'A' | 'B';
      status: RelationshipIntentStatus;
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
      pair: { id: params.pairId, threadId: params.threadId },
      authorSide: params.authorSide,
      status: params.status,
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
      firstIntent: await this.readIntentInTx(tx, pair.id, firstSide),
      secondIntent: await this.readIntentInTx(tx, pair.id, secondSide),
      shouldBeActive: await this.shouldBeActiveInTx(tx, pair.id),
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
    const pair = await this.lockGroupMutationInTx(tx, params);
    const changed = await this.setLockedGroupPairActiveInTx(tx, {
      pairId: pair.id,
      threadId: params.threadId,
      threadLock: pair.threadLock,
      memberDomain: pair.endpointB.domain,
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
      memberDomain: string;
      active: boolean;
    },
  ): Promise<boolean> {
    this.assertThreadLock(tx, params.threadId, params.threadLock);
    const changed = await this.updateLockedGroupPairActiveInTx(
      tx,
      params.pairId,
      params.active,
    );
    if (changed && params.active && params.memberDomain === 'local')
      await tx.execute(sql`
        UPDATE "MessageThread"
        SET "federationRoundsEnabled" = true, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${params.threadId}
      `);
    if (changed && !params.active && params.memberDomain === 'local')
      await tx.execute(sql`
        UPDATE "MessageThread" thread
        SET "authorizationEpoch" = thread."authorizationEpoch" + 1,
          "federationRoundsEnabled" = false,
          "updatedAt" = CURRENT_TIMESTAMP
        FROM ${groupStateSql} group_profile
        WHERE thread.id = ${params.threadId}
          AND thread.id = group_profile.id
          AND group_profile.domain <> 'local'
            AND NOT EXISTS (
            SELECT 1
            FROM "RelationshipPair" remaining_pair
            WHERE remaining_pair."threadId" = thread.id
              AND remaining_pair.kind = 'GROUP_MEMBER'
              AND remaining_pair.active = true
              AND (
                (remaining_pair."endpointAType" = 'GROUP'
                  AND remaining_pair."endpointAAccount" = group_profile.account
                  AND remaining_pair."endpointADomain" = group_profile.domain
                  AND remaining_pair."endpointBType" = 'USER'
                  AND remaining_pair."endpointBDomain" = 'local')
                OR
                (remaining_pair."endpointBType" = 'GROUP'
                  AND remaining_pair."endpointBAccount" = group_profile.account
                  AND remaining_pair."endpointBDomain" = group_profile.domain
                  AND remaining_pair."endpointAType" = 'USER'
                  AND remaining_pair."endpointADomain" = 'local')
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
    return this.readLockedGroupMemberProfileRevInTx(tx, {
      pairId: pair.id,
      threadId: params.threadId,
      threadLock: pair.threadLock,
    });
  }

  async readLockedGroupMemberProfileRevInTx(
    tx: DatabaseTransaction,
    params: {
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
    },
  ): Promise<number> {
    this.assertThreadLock(tx, params.threadId, params.threadLock);
    const intent = await this.readIntentInTx(tx, params.pairId, 'B');
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
    },
  ): Promise<LockedPair & { threadLock: ThreadContentLock }> {
    const member = await accountAddressInTx(tx, params.memberUserId);
    const located = await tx.execute<{
      groupAccount: string;
      groupDomain: string;
      groupNamespaceId: number;
      memberAccount: string;
      memberDomain: string;
      memberNamespaceId: number;
    }>(sql`
      SELECT group_profile.account AS "groupAccount",
        group_profile.domain AS "groupDomain",
        group_profile."namespaceId" AS "groupNamespaceId",
        ${member.account}::text AS "memberAccount",
        ${member.domain}::text AS "memberDomain",
        ${member.namespaceId}::integer AS "memberNamespaceId"
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

    const relationshipNamespaceId = this.relationshipNamespaceId(
      row.groupNamespaceId,
      row.memberNamespaceId,
    );
    const pair = await this.lockCanonicalPairInTx(tx, {
      kind: 'GROUP_MEMBER',
      endpointA: {
        type: 'GROUP',
        account: row.groupAccount,
        domain: row.groupDomain,
        namespaceId: relationshipNamespaceId,
      },
      endpointB: {
        type: 'USER',
        account: row.memberAccount,
        domain: row.memberDomain,
        namespaceId: relationshipNamespaceId,
      },
      threadId: params.threadId,
    });
    await this.lockIntentRowsInTx(tx, pair.id);

    const projectionUserIds = [...new Set(params.projectionUserIds ?? [])];
    await tx.execute(sql`
      SELECT participant.id FROM "AccountThreadState" participant
      JOIN "Account" owner ON owner.id = participant."accountId"
      WHERE participant."threadId" = ${params.threadId}
        AND ((owner.account = ${member.account} AND ${member.domain} = 'local')
          OR owner.id = ANY(${sql.param(projectionUserIds)}::integer[]))
      ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
    `);
    return { ...pair, threadLock };
  }

  async lockGroupBusinessScopeInTx(
    tx: DatabaseTransaction,
    address: { account: string; domain: string },
  ): Promise<void> {
    await lockBusinessAccountsInTx(tx, [address]);
  }

  private async writeAuthoredIntentOnPairInTx(
    tx: DatabaseTransaction,
    params: {
      pair: Pick<LockedPair, 'id' | 'threadId'>;
      authorSide: 'A' | 'B';
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
      validatedPairActive?: boolean;
    },
  ) {
    let status = params.status;
    if (params.validatedPairActive === undefined) {
      const reverseSide = params.authorSide === 'A' ? 'B' : 'A';
      const reverse = await this.readIntentInTx(
        tx,
        params.pair.id,
        reverseSide,
      );
      const current = await this.readIntentInTx(
        tx,
        params.pair.id,
        params.authorSide,
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
    const written = await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${status}::"RelationshipIntentStatus",
        COALESCE((
          SELECT CASE
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointAAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointBAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointAAccount" LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointBAccount" LIMIT 1)
          END
          FROM "RelationshipPair" pair WHERE pair.id = ${params.pair.id}
         ), 0), ${(params.note ?? '').slice(0, 255)},
        COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${params.pair.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${params.pair.threadId} AND d."sourceNamespaceId" = 0), 0),
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
        "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
        "profileRev" = CASE
          WHEN "RelationshipIntent".status = 'REVOKED'
            AND EXCLUDED.status = 'REQUESTED' THEN EXCLUDED."profileRev"
          ELSE "RelationshipIntent"."profileRev"
        END,
        "requestedAt" = CASE
          WHEN EXCLUDED.status IN ('REQUESTED', 'ACCEPTED') THEN EXCLUDED."requestedAt"
          ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING 1
    `);
    const raw = await this.readIntentInTx(
      tx,
      params.pair.id,
      params.authorSide,
    );
    if (!raw) throw new Error('relationship intent write disappeared');
    return {
      request: raw,
      shouldBeActive:
        params.validatedPairActive ??
        (await this.shouldBeActiveInTx(tx, params.pair.id)),
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
    await lockBusinessAccountsInTx(tx, [key.endpointA, key.endpointB]);
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
    await this.lockIntentRowsInTx(tx, pair.id);
    return pair;
  }

  private async prepareP2PAddressKeyInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
  ): Promise<PairKey & { localSide: 'A' | 'B'; remoteSide: 'A' | 'B' }> {
    const local = await tx.query.account.findFirst({
      where: and(eq(user.id, localUserId), eq(user.domain, 'local')),
      columns: { account: true, domain: true, namespaceId: true },
    });
    if (!local) throw new Error('local relationship endpoint does not exist');
    const key = this.prepareP2PKey(local, remote, null);
    return { ...key, localSide: key.firstSide, remoteSide: key.secondSide };
  }

  /** Build the same canonical identity for lookups and mutations, without creating rows or locking. */
  private prepareP2PKey(
    first: { account: string; domain: string; namespaceId: number },
    second: { account: string; domain: string; namespaceId: number },
    threadId: number | null,
  ): PairKey & { firstSide: 'A' | 'B'; secondSide: 'A' | 'B' } {
    const namespaceId = this.relationshipNamespaceId(
      first.namespaceId,
      second.namespaceId,
    );
    const endpoint = (address: typeof first): RelationshipEndpoint => ({
      type: 'USER',
      account: normalizeAccount(address.account),
      domain: address.domain.trim().toLowerCase(),
      namespaceId,
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
      threadId,
      firstSide,
      secondSide: firstSide === 'A' ? 'B' : 'A',
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
        endpointADomain: key.endpointA.domain,
        endpointANamespaceId: key.endpointA.namespaceId,
        endpointBType: key.endpointB.type,
        endpointBAccount: key.endpointB.account,
        endpointBDomain: key.endpointB.domain,
        endpointBNamespaceId: key.endpointB.namespaceId,
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
            eq(relationshipPair.endpointADomain, key.endpointA.domain),
            eq(
              relationshipPair.endpointANamespaceId,
              key.endpointA.namespaceId,
            ),
            eq(relationshipPair.endpointBType, key.endpointB.type),
            eq(relationshipPair.endpointBAccount, key.endpointB.account),
            eq(relationshipPair.endpointBDomain, key.endpointB.domain),
            eq(
              relationshipPair.endpointBNamespaceId,
              key.endpointB.namespaceId,
            ),
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
        AND "endpointADomain" = ${key.endpointA.domain}
        AND "endpointANamespaceId" = ${key.endpointA.namespaceId}
        AND "endpointBType" = ${key.endpointB.type}
        AND "endpointBAccount" = ${key.endpointB.account}
        AND "endpointBDomain" = ${key.endpointB.domain}
        AND "endpointBNamespaceId" = ${key.endpointB.namespaceId}
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
    pairId: bigint,
  ): Promise<void> {
    await tx
      .select({ id: relationshipIntent.id })
      .from(relationshipIntent)
      .where(eq(relationshipIntent.pairId, pairId))
      .orderBy(relationshipIntent.authorSide)
      .for('no key update');
  }

  private async readIntentInTx(
    tx: DatabaseTransaction,
    pairId: bigint,
    authorSide: 'A' | 'B',
  ): Promise<RawIntent | undefined> {
    return tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, pairId),
        eq(relationshipIntent.authorSide, authorSide),
      ),
      columns: {
        id: true,
        status: true,
        profileRev: true,
        note: true,
        messageEndSeq: true,
        tombstoneEndSeq: true,
        requestedAt: true,
        expiresAt: true,
      },
    });
  }

  private async shouldBeActiveInTx(
    tx: DatabaseTransaction,
    pairId: bigint,
  ): Promise<boolean> {
    const intents = await tx
      .select({
        id: relationshipIntent.id,
        authorSide: relationshipIntent.authorSide,
        status: relationshipIntent.status,
        profileRev: relationshipIntent.profileRev,
        note: relationshipIntent.note,
        requestedAt: relationshipIntent.requestedAt,
        expiresAt: relationshipIntent.expiresAt,
      })
      .from(relationshipIntent)
      .where(eq(relationshipIntent.pairId, pairId));
    const bySide = new Map(
      intents.map((intent) => [intent.authorSide, intent]),
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
      pair.endpointA.account === normalizeAccount(identity.account) &&
      pair.endpointA.domain === identity.domain.trim().toLowerCase()
    )
      return 'A';
    if (
      pair.endpointB.type === 'USER' &&
      pair.endpointB.account === normalizeAccount(identity.account) &&
      pair.endpointB.domain === identity.domain.trim().toLowerCase()
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

  private compareEndpoints(
    left: RelationshipEndpoint,
    right: RelationshipEndpoint,
  ): number {
    return (
      left.type.localeCompare(right.type) ||
      left.domain.localeCompare(right.domain) ||
      left.account.localeCompare(right.account) ||
      left.namespaceId - right.namespaceId
    );
  }

  private relationshipNamespaceId(
    firstNamespaceId: number,
    secondNamespaceId: number,
  ): number {
    const federationNamespaceIds = new Set(
      [firstNamespaceId, secondNamespaceId].filter(
        (namespaceId) => namespaceId !== 0,
      ),
    );
    if (federationNamespaceIds.size > 1) {
      throw new Error('relationship endpoints span federation namespaces');
    }
    return federationNamespaceIds.values().next().value ?? 0;
  }
}
