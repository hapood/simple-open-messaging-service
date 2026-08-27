import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  group,
  relationshipIntent,
  relationshipPair,
  user,
} from '../database/schema.js';
import {
  isEffectiveRelationshipIntent,
  type RelationshipIntentStatus,
} from './relationship-intent-state.js';

export type { RelationshipIntentStatus } from './relationship-intent-state.js';

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RelationshipIntentState extends Record<string, unknown> {
  id: bigint;
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
}

type RelationshipEndpoint = {
  type: 'USER' | 'GROUP';
  account: string;
  domain: string;
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
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
};

/** Serializes the two authored directions on a canonical Pair row. Pair.active is updated by the
 * owning relationship transaction after all state-machine side effects have been determined. */
@Injectable()
export class RelationshipIntentService {
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
    const pair = await this.lockP2PPairInTx(
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
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ) {
    const pair = await this.lockP2PPairInTx(
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

  async hasValidInviteInTx(
    tx: DatabaseTransaction,
    authorUserId: number,
    subjectUserId: number,
  ): Promise<boolean> {
    const pair = await this.lockP2PPairInTx(
      tx,
      authorUserId,
      subjectUserId,
      null,
    );
    const authorSide = await this.userSideInPair(tx, pair, authorUserId);
    const intent = await this.readIntentInTx(tx, pair.id, authorSide);
    return isEffectiveRelationshipIntent(intent, new Date());
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
    const pair = await this.lockGroupPairInTx(tx, params);
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
    const pair = await this.lockGroupPairInTx(tx, params);
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
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ): Promise<{
    changed: boolean;
    shouldBeActive: boolean;
    publishAccepted: boolean;
  }> {
    const pair = await this.lockGroupPairInTx(tx, params);
    const authorSide = params.author === 'GROUP' ? 'A' : 'B';
    return this.applyRemoteIntentOnPairInTx(tx, {
      pair,
      authorSide,
      status: params.status,
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
    return this.lockP2PPairInTx(tx, firstUserId, secondUserId, threadId);
  }

  async readP2PRelationshipInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
  ) {
    const pair = await this.lockP2PPairInTx(
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
    const pair = await this.lockP2PPairInTx(
      tx,
      firstUserId,
      secondUserId,
      null,
    );
    return this.setLockedPairActiveInTx(tx, pair.id, active);
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
    const pair = await this.lockGroupPairInTx(tx, params);
    return this.setLockedPairActiveInTx(tx, pair.id, params.active);
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
        "pairId", "authorSide", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${status}::"RelationshipIntentStatus", ${(params.note ?? '').slice(0, 255)},
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
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
        "pairId", "authorSide", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${params.status}::"RelationshipIntentStatus", ${params.note.slice(0, 255)},
        ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
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

  private async lockP2PPairInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
    threadId: number | null,
  ): Promise<LockedPair> {
    const identities = await tx
      .select({ id: user.id, account: user.account, domain: user.domain })
      .from(user)
      .where(sql`${user.id} IN (${firstUserId}, ${secondUserId})`);
    const first = identities.find((identity) => identity.id === firstUserId);
    const second = identities.find((identity) => identity.id === secondUserId);
    if (!first || !second || first.id === second.id)
      throw new Error('relationship user endpoint does not exist');
    const endpoints = [
      { type: 'USER' as const, account: first.account, domain: first.domain },
      { type: 'USER' as const, account: second.account, domain: second.domain },
    ].sort((left, right) => this.compareEndpoints(left, right));
    return this.lockCanonicalPairInTx(tx, {
      kind: 'P2P',
      endpointA: endpoints[0]!,
      endpointB: endpoints[1]!,
      threadId,
    });
  }

  private async lockGroupPairInTx(
    tx: DatabaseTransaction,
    params: { groupId: number; memberUserId: number; threadId: number },
  ): Promise<LockedPair> {
    const [row] = await tx
      .select({
        groupAccount: group.account,
        groupDomain: group.domain,
        memberAccount: user.account,
        memberDomain: user.domain,
      })
      .from(group)
      .innerJoin(user, eq(user.id, params.memberUserId))
      .where(eq(group.id, params.groupId))
      .limit(1);
    if (!row) throw new Error('group relationship endpoint does not exist');
    return this.lockCanonicalPairInTx(tx, {
      kind: 'GROUP_MEMBER',
      endpointA: {
        type: 'GROUP',
        account: row.groupAccount,
        domain: row.groupDomain,
      },
      endpointB: {
        type: 'USER',
        account: row.memberAccount,
        domain: row.memberDomain,
      },
      threadId: params.threadId,
    });
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
        endpointBType: key.endpointB.type,
        endpointBAccount: key.endpointB.account,
        endpointBDomain: key.endpointB.domain,
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
            eq(relationshipPair.endpointBType, key.endpointB.type),
            eq(relationshipPair.endpointBAccount, key.endpointB.account),
            eq(relationshipPair.endpointBDomain, key.endpointB.domain),
          ),
        );
    const locked = await tx.execute<{
      id: bigint;
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT id, active, "threadId" FROM "RelationshipPair"
      WHERE "endpointAType" = ${key.endpointA.type}
        AND "endpointAAccount" = ${key.endpointA.account}
        AND "endpointADomain" = ${key.endpointA.domain}
        AND "endpointBType" = ${key.endpointB.type}
        AND "endpointBAccount" = ${key.endpointB.account}
        AND "endpointBDomain" = ${key.endpointB.domain}
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
      SET active = ${active}, revision = revision + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${pairId} AND active IS DISTINCT FROM ${active}
      RETURNING revision
    `);
    return (changed.rowCount ?? 0) > 0;
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
    return `${left.type}\u0000${left.domain}\u0000${left.account}`.localeCompare(
      `${right.type}\u0000${right.domain}\u0000${right.account}`,
    );
  }
}
