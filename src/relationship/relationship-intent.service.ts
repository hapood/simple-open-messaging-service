import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  messageThread,
  relationshipIntent,
  relationshipPair,
  user,
} from '../database/schema.js';
import {
  isEffectiveRelationshipIntent,
  type RelationshipIntentStatus,
} from './relationship-intent-state.js';
import { lockBusinessAccountsInTx } from './business-scope-lock.js';

export type { RelationshipIntentStatus } from './relationship-intent-state.js';

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RelationshipIntentState extends Record<string, unknown> {
  id: bigint;
  status: RelationshipIntentStatus;
  profileRev: number;
  note: string;
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
  requestedAt: Date | null;
  expiresAt: Date | null;
};

/** Serializes the two authored directions on a canonical Pair row. Pair.active is updated by the
 * owning relationship transaction after all state-machine side effects have been determined. */
@Injectable()
export class RelationshipIntentService {
  /** Apply a remote-authored P2P fact without requiring a materialized remote User. */
  async applyRemoteP2PIntentByAddressInTx(
    tx: DatabaseTransaction,
    params: {
      localUserId: number;
      remote: { account: string; domain: string; namespaceId: number };
      status: RelationshipIntentStatus;
      profileRev: number;
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ) {
    const located = await this.lockP2PAddressPairInTx(
      tx,
      params.localUserId,
      params.remote,
    );
    const result = await this.applyRemoteIntentOnPairInTx(tx, {
      pair: located.pair,
      authorSide: located.remoteSide,
      status: params.status,
      profileRev: params.profileRev,
      note: params.note,
      requestedAt: params.requestedAt,
      expiresAt: params.expiresAt,
    });
    return {
      ...result,
      ...located,
      localIntent: await this.readIntentInTx(
        tx,
        located.pair.id,
        located.localSide,
      ),
      remoteIntent: await this.readIntentInTx(
        tx,
        located.pair.id,
        located.remoteSide,
      ),
    };
  }

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
      FOR UPDATE
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

  async writeP2PAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      authorUserId: number;
      subjectUserId: number;
      threadId: number | null;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
      confirmReverseRequested?: boolean;
    },
  ) {
    const pair = await this.lockUserPairMutationInTx(
      tx,
      params.authorUserId,
      params.subjectUserId,
      params.threadId,
    );
    const authorSide = await this.userSideInPair(tx, pair, params.authorUserId);
    const result = await this.writeAuthoredIntentOnPairInTx(tx, {
      pair,
      authorSide,
      status: params.status,
      note: params.note,
      expiresAt: params.expiresAt,
    });
    if (
      params.confirmReverseRequested &&
      result.request.status === 'ACCEPTED'
    ) {
      const reverseSide = authorSide === 'A' ? 'B' : 'A';
      await tx.execute(sql`
        UPDATE "RelationshipIntent"
        SET status = 'ACCEPTED', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "pairId" = ${pair.id} AND "authorSide" = ${reverseSide}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
      `);
    }
    return {
      ...result,
      pair,
      authorSide,
      shouldBeActive: await this.shouldBeActiveInTx(tx, pair.id),
    };
  }

  async applyRemoteP2PIntentInTx(
    tx: DatabaseTransaction,
    params: {
      authorUserId: number;
      subjectUserId: number;
      threadId: number | null;
      status: RelationshipIntentStatus;
      profileRev: number;
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ) {
    const pair = await this.lockUserPairMutationInTx(
      tx,
      params.authorUserId,
      params.subjectUserId,
      params.threadId,
    );
    const authorSide = await this.userSideInPair(tx, pair, params.authorUserId);
    const result = await this.applyRemoteIntentOnPairInTx(tx, {
      pair,
      authorSide,
      status: params.status,
      profileRev: params.profileRev,
      note: params.note,
      requestedAt: params.requestedAt,
      expiresAt: params.expiresAt,
    });
    let reverseChanged = false;
    if (params.status === 'REVOKED' && result.changed) {
      const reverseSide = authorSide === 'A' ? 'B' : 'A';
      const closed = await tx.execute(sql`
        UPDATE "RelationshipIntent"
        SET status = 'REVOKED', note = '', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "pairId" = ${pair.id} AND "authorSide" = ${reverseSide}
          AND status <> 'REVOKED'
        RETURNING 1
      `);
      reverseChanged = (closed.rowCount ?? 0) > 0;
    }
    return {
      ...result,
      pair,
      authorSide,
      reverseChanged,
      shouldBeActive: await this.shouldBeActiveInTx(tx, pair.id),
    };
  }

  async hasValidGroupInviteInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: number;
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
      memberUserId: number;
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
    return this.writeAuthoredIntentOnPairInTx(tx, {
      pair,
      authorSide: params.author === 'GROUP' ? 'A' : 'B',
      status: params.status,
      note: params.note,
      expiresAt: params.expiresAt,
    });
  }

  async applyRemoteGroupIntentInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: number;
      threadId: number;
      author: 'GROUP' | 'MEMBER';
      status: RelationshipIntentStatus;
      profileRev: number;
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ): Promise<{
    changed: boolean;
    shouldBeActive: boolean;
    publishAccepted: boolean;
  }> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const authorSide = params.author === 'GROUP' ? 'A' : 'B';
    return this.applyRemoteIntentOnPairInTx(tx, {
      pair,
      authorSide,
      status: params.status,
      profileRev: params.profileRev,
      note: params.note,
      requestedAt: params.requestedAt,
      expiresAt: params.expiresAt,
    });
  }

  /** Callers still identify P2P endpoints by User id, but storage is always address-based. */
  async lockPairInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
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
    firstUserId: number,
    secondUserId: number,
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
    firstUserId: number,
    secondUserId: number,
    active: boolean,
  ): Promise<boolean> {
    const pair = await this.lockUserPairMutationInTx(
      tx,
      firstUserId,
      secondUserId,
      null,
    );
    const changed = await this.setLockedPairActiveInTx(tx, pair.id, active);
    if (changed && !active && pair.threadId !== null)
      await this.incrementThreadAuthorizationEpochInTx(tx, pair.threadId);
    return changed;
  }

  async setGroupPairActiveInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: number;
      threadId: number;
      active: boolean;
    },
  ): Promise<boolean> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const changed = await this.setLockedPairActiveInTx(
      tx,
      pair.id,
      params.active,
    );
    if (changed && !params.active)
      await tx.execute(sql`
        UPDATE "MessageThread" thread
        SET "authorizationEpoch" = thread."authorizationEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "Group" group_profile, "User" member
        WHERE thread.id = ${params.threadId}
          AND thread."groupId" = group_profile.id
          AND group_profile.id = ${params.groupId}
          AND group_profile.domain <> 'local'
          AND member.id = ${params.memberUserId}
          AND member.domain = 'local'
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
      memberUserId: number;
      threadId: number;
    },
  ): Promise<number> {
    const pair = await this.lockGroupMutationInTx(tx, params);
    const intent = await this.readIntentInTx(tx, pair.id, 'B');
    if (!intent)
      throw new Error('active group member has no member-authored intent');
    if (!Number.isSafeInteger(intent.profileRev) || intent.profileRev < 0)
      throw new Error('active group member has an invalid profile revision');
    return intent.profileRev;
  }

  /** Acquires the canonical lock set for every local or federated group-relationship mutation. */
  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    params: {
      groupId: number;
      memberUserId: number;
      threadId: number;
      projectionUserIds?: readonly number[];
    },
  ): Promise<LockedPair> {
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
        member.account AS "memberAccount",
        member.domain AS "memberDomain",
        member."namespaceId" AS "memberNamespaceId"
      FROM "Group" group_profile
      CROSS JOIN "User" member
      WHERE group_profile.id = ${params.groupId}
        AND member.id = ${params.memberUserId}
    `);
    const location = located.rows[0];
    if (!location)
      throw new Error('group relationship endpoint does not exist');
    await this.lockGroupBusinessScopeInTx(tx, {
      account: location.groupAccount,
      domain: location.groupDomain,
    });

    const endpoint = await tx.execute<{
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
        member.account AS "memberAccount",
        member.domain AS "memberDomain",
        member."namespaceId" AS "memberNamespaceId"
      FROM "Group" group_profile
      CROSS JOIN "User" member
      WHERE group_profile.id = ${params.groupId}
        AND member.id = ${params.memberUserId}
      FOR UPDATE OF group_profile
    `);
    const row = endpoint.rows[0];
    if (!row) throw new Error('group relationship endpoint does not exist');

    const thread = await tx.execute<{ id: number }>(sql`
      SELECT id FROM "MessageThread"
      WHERE id = ${params.threadId} AND "groupId" = ${params.groupId}
      FOR UPDATE
    `);
    if (!thread.rows[0])
      throw new Error('group relationship thread does not exist');

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

    const projectionUserIds = [
      ...new Set([params.memberUserId, ...(params.projectionUserIds ?? [])]),
    ].sort((left, right) => left - right);
    const userIds = sql.join(
      projectionUserIds.map((userId) => sql`${userId}`),
      sql`, `,
    );
    await tx.execute(sql`
      SELECT id FROM "AccountThreadState"
      WHERE "threadId" = ${params.threadId} AND "accountId" IN (${userIds})
      ORDER BY "accountId"
      FOR UPDATE
    `);
    return pair;
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
      pair: LockedPair;
      authorSide: 'A' | 'B';
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
    },
  ) {
    const reverseSide = params.authorSide === 'A' ? 'B' : 'A';
    const reverse = await this.readIntentInTx(tx, params.pair.id, reverseSide);
    const current = await this.readIntentInTx(
      tx,
      params.pair.id,
      params.authorSide,
    );
    const reverseIsCurrent = isEffectiveRelationshipIntent(reverse, new Date());
    if (
      params.status === 'ACCEPTED' &&
      !reverseIsCurrent &&
      current?.status !== 'ACCEPTED'
    )
      throw new Error('cannot accept without a current reverse relationship');

    const status: RelationshipIntentStatus =
      params.status === 'REQUESTED' && reverseIsCurrent
        ? 'ACCEPTED'
        : params.status;
    const requestedAt = status !== 'REVOKED' ? new Date() : null;
    const expiresAt =
      status === 'REQUESTED'
        ? (params.expiresAt ??
          new Date(requestedAt!.getTime() + REQUEST_TTL_MS))
        : null;
    const written = await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${status}::"RelationshipIntentStatus",
        COALESCE((
          SELECT CASE
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "User" profile
                WHERE profile.account = pair."endpointAAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "User" profile
                WHERE profile.account = pair."endpointBAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "Group" profile
                WHERE profile.account = pair."endpointAAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "Group" profile
                WHERE profile.account = pair."endpointBAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
          END
          FROM "RelationshipPair" pair WHERE pair.id = ${params.pair.id}
        ), 0), ${(params.note ?? '').slice(0, 255)},
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
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
      shouldBeActive: await this.shouldBeActiveInTx(tx, params.pair.id),
      changed: (written.rowCount ?? 0) > 0,
    };
  }

  private async applyRemoteIntentOnPairInTx(
    tx: DatabaseTransaction,
    params: {
      pair: LockedPair;
      authorSide: 'A' | 'B';
      status: RelationshipIntentStatus;
      profileRev: number;
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ) {
    const reverseSide = params.authorSide === 'A' ? 'B' : 'A';
    const localBefore = await this.readIntentInTx(
      tx,
      params.pair.id,
      reverseSide,
    );
    if (
      params.status === 'ACCEPTED' &&
      !this.isValidRequest(localBefore) &&
      localBefore?.status !== 'ACCEPTED'
    )
      return {
        changed: false,
        shouldBeActive: await this.shouldBeActiveInTx(tx, params.pair.id),
        publishAccepted: false,
      };

    const applied = await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${params.status}::"RelationshipIntentStatus", ${params.profileRev}, ${params.note.slice(0, 255)},
        ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "profileRev" = CASE
          WHEN "RelationshipIntent".status = 'REVOKED'
            AND EXCLUDED.status = 'REQUESTED' THEN EXCLUDED."profileRev"
          ELSE "RelationshipIntent"."profileRev"
        END,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING 1
    `);
    let publishAccepted = false;
    if (params.status === 'REQUESTED' || params.status === 'ACCEPTED') {
      const upgraded = await tx.execute(sql`
        UPDATE "RelationshipIntent"
        SET status = 'ACCEPTED', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "pairId" = ${params.pair.id}
          AND "authorSide" = ${reverseSide}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING 1
      `);
      publishAccepted =
        (upgraded.rowCount ?? 0) > 0 ||
        (params.status === 'REQUESTED' && localBefore?.status === 'ACCEPTED');
    }
    return {
      changed: (applied.rowCount ?? 0) > 0,
      shouldBeActive: await this.shouldBeActiveInTx(tx, params.pair.id),
      publishAccepted,
    };
  }

  private async lockUserPairMutationInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
    threadId: number | null,
  ): Promise<LockedPair> {
    const identities = await tx
      .select({
        id: user.id,
        account: user.account,
        domain: user.domain,
        namespaceId: user.namespaceId,
      })
      .from(user)
      .where(sql`${user.id} IN (${firstUserId}, ${secondUserId})`);
    const first = identities.find((identity) => identity.id === firstUserId);
    const second = identities.find((identity) => identity.id === secondUserId);
    if (!first || !second || first.id === second.id)
      throw new Error('relationship user endpoint does not exist');
    const relationshipNamespaceId = this.relationshipNamespaceId(
      first.namespaceId,
      second.namespaceId,
    );
    const endpoints = [
      {
        type: 'USER' as const,
        account: first.account,
        domain: first.domain,
        namespaceId: relationshipNamespaceId,
      },
      {
        type: 'USER' as const,
        account: second.account,
        domain: second.domain,
        namespaceId: relationshipNamespaceId,
      },
    ].sort((left, right) => this.compareEndpoints(left, right));
    await lockBusinessAccountsInTx(tx, [endpoints[0]!, endpoints[1]!]);
    const pair = await this.lockCanonicalPairInTx(tx, {
      kind: 'P2P',
      endpointA: endpoints[0]!,
      endpointB: endpoints[1]!,
      threadId,
    });
    if (pair.threadId !== null) {
      const thread = await tx
        .select({ id: messageThread.id })
        .from(messageThread)
        .where(eq(messageThread.id, pair.threadId))
        .for('update')
        .limit(1);
      if (!thread[0]) throw new Error('P2P relationship thread does not exist');
    }
    await this.lockIntentRowsInTx(tx, pair.id);
    return pair;
  }

  private async lockP2PAddressPairInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
  ): Promise<{
    pair: LockedPair;
    localSide: 'A' | 'B';
    remoteSide: 'A' | 'B';
  }> {
    const key = await this.prepareP2PAddressKeyInTx(tx, localUserId, remote);
    await lockBusinessAccountsInTx(tx, [key.endpointA, key.endpointB]);
    const pair = await this.lockCanonicalPairInTx(tx, key);
    await this.lockIntentRowsInTx(tx, pair.id);
    return {
      pair,
      localSide: key.localSide,
      remoteSide: key.remoteSide,
    };
  }

  private async prepareP2PAddressKeyInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
  ): Promise<PairKey & { localSide: 'A' | 'B'; remoteSide: 'A' | 'B' }> {
    const local = await tx.query.user.findFirst({
      where: and(eq(user.id, localUserId), eq(user.domain, 'local')),
      columns: { account: true, domain: true, namespaceId: true },
    });
    if (!local) throw new Error('local relationship endpoint does not exist');
    const relationshipNamespaceId = this.relationshipNamespaceId(
      local.namespaceId,
      remote.namespaceId,
    );
    const localEndpoint: RelationshipEndpoint = {
      type: 'USER',
      account: local.account,
      domain: local.domain,
      namespaceId: relationshipNamespaceId,
    };
    const remoteEndpoint: RelationshipEndpoint = {
      type: 'USER',
      account: normalizeAccount(remote.account),
      domain: remote.domain.trim().toLowerCase(),
      namespaceId: relationshipNamespaceId,
    };
    const endpoints = [localEndpoint, remoteEndpoint].sort((left, right) =>
      this.compareEndpoints(left, right),
    );
    const localSide = endpoints[0] === localEndpoint ? 'A' : 'B';
    return {
      kind: 'P2P',
      endpointA: endpoints[0]!,
      endpointB: endpoints[1]!,
      threadId: null,
      localSide,
      remoteSide: localSide === 'A' ? 'B' : 'A',
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
      FOR UPDATE
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

  private async setLockedPairActiveInTx(
    tx: DatabaseTransaction,
    pairId: bigint,
    active: boolean,
  ): Promise<boolean> {
    const changed = await tx.execute(sql`
      UPDATE "RelationshipPair"
      SET active = ${active}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${pairId} AND active IS DISTINCT FROM ${active}
      RETURNING id
    `);
    return (changed.rowCount ?? 0) > 0;
  }

  private async incrementThreadAuthorizationEpochInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<void> {
    const incremented = await tx.execute(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${threadId}
      RETURNING id
    `);
    if ((incremented.rowCount ?? 0) !== 1)
      throw new Error('relationship thread disappeared during deactivation');
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
      .for('update');
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
    userId: number,
  ): Promise<'A' | 'B'> {
    const identity = await tx.query.user.findFirst({
      where: eq(user.id, userId),
      columns: { account: true, domain: true },
    });
    if (!identity) throw new Error('relationship user endpoint does not exist');
    if (
      pair.endpointA.type === 'USER' &&
      pair.endpointA.account === identity.account &&
      pair.endpointA.domain === identity.domain
    )
      return 'A';
    if (
      pair.endpointB.type === 'USER' &&
      pair.endpointB.account === identity.account &&
      pair.endpointB.domain === identity.domain
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
