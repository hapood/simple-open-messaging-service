import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RelationshipIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

export interface RelationshipIntentState extends Record<string, unknown> {
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
}

type RawIntent = {
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | string | null;
  expiresAt: Date | string | null;
};

const asDate = (value: Date | string | null): Date | null =>
  value === null || value instanceof Date ? value : new Date(value);

/** Serializes and reconciles the two directed intents for any user pair. */
@Injectable()
export class RelationshipIntentService {
  async hasValidInviteInTx(
    tx: DatabaseTransaction,
    authorUserId: number,
    subjectUserId: number,
  ): Promise<boolean> {
    const result = await tx.execute<{ valid: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "RelationshipIntent"
        WHERE "authorUserId" = ${authorUserId}
          AND "subjectUserId" = ${subjectUserId}
          AND status <> 'REVOKED'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
      ) AS valid
    `);
    return result.rows[0]?.valid ?? false;
  }

  async writeAuthoredIntentInTx(
    tx: DatabaseTransaction,
    params: {
      groupUserId: number;
      memberUserId: number;
      authorUserId: number;
      status: RelationshipIntentStatus;
      note?: string;
      expiresAt?: Date | null;
    },
  ): Promise<{
    request: RelationshipIntentState;
    shouldBeActive: boolean;
    changed: boolean;
  }> {
    const subjectUserId = this.otherUser(params);
    await this.lockPairInTx(tx, params.authorUserId, subjectUserId);
    const reverse = await this.readIntentInTx(
      tx,
      subjectUserId,
      params.authorUserId,
    );
    const current = await this.readIntentInTx(
      tx,
      params.authorUserId,
      subjectUserId,
    );
    const reverseRequestIsValid = this.isValidRequest(reverse);
    const reverseRelationshipIsCurrent =
      reverseRequestIsValid || reverse?.status === 'ACCEPTED';
    if (
      params.status === 'ACCEPTED' &&
      !reverseRelationshipIsCurrent &&
      current?.status !== 'ACCEPTED'
    )
      throw new Error('cannot accept without a current reverse relationship');
    const status: RelationshipIntentStatus =
      params.status === 'REQUESTED' && reverseRequestIsValid
        ? 'ACCEPTED'
        : params.status;
    const requestedAt = status !== 'REVOKED' ? new Date() : null;
    const expiresAt =
      status === 'REQUESTED'
        ? (params.expiresAt ??
          new Date(requestedAt!.getTime() + REQUEST_TTL_MS))
        : null;
    const written = await tx.execute<RawIntent>(sql`
      INSERT INTO "RelationshipIntent" (
        "authorUserId", "subjectUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.authorUserId}, ${subjectUserId},
        ${status}::"RelationshipIntentStatus", ${(params.note ?? '').slice(0, 255)},
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "requestedAt" = CASE WHEN EXCLUDED.status = 'REQUESTED' THEN EXCLUDED."requestedAt"
                             ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING status, note, "requestedAt", "expiresAt"
    `);
    const raw =
      written.rows[0] ??
      (await this.readIntentInTx(tx, params.authorUserId, subjectUserId));
    if (!raw) throw new Error('relationship intent write disappeared');
    return {
      request: {
        ...raw,
        requestedAt: asDate(raw.requestedAt),
        expiresAt: asDate(raw.expiresAt),
      },
      shouldBeActive: await this.shouldBeActiveInTx(
        tx,
        params.authorUserId,
        subjectUserId,
      ),
      changed: written.rows.length > 0,
    };
  }

  async applyRemoteIntentInTx(
    tx: DatabaseTransaction,
    params: {
      groupUserId: number;
      memberUserId: number;
      authorUserId: number;
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
    const subjectUserId = this.otherUser(params);
    await this.lockPairInTx(tx, params.authorUserId, subjectUserId);
    const localBefore = await this.readIntentInTx(
      tx,
      subjectUserId,
      params.authorUserId,
    );
    if (
      params.status === 'ACCEPTED' &&
      !this.isValidRequest(localBefore) &&
      localBefore?.status !== 'ACCEPTED'
    ) {
      return {
        changed: false,
        shouldBeActive: await this.shouldBeActiveInTx(
          tx,
          params.authorUserId,
          subjectUserId,
        ),
        publishAccepted: false,
      };
    }
    const applied = await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "authorUserId", "subjectUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.authorUserId}, ${subjectUserId},
        ${params.status}::"RelationshipIntentStatus", ${params.note.slice(0, 255)},
        ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
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
        UPDATE "RelationshipIntent" SET status = 'ACCEPTED',
          "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "authorUserId" = ${subjectUserId}
          AND "subjectUserId" = ${params.authorUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING 1
      `);
      publishAccepted =
        (upgraded.rowCount ?? 0) > 0 ||
        (params.status === 'REQUESTED' && localBefore?.status === 'ACCEPTED');
    }
    return {
      changed: (applied.rowCount ?? 0) > 0,
      shouldBeActive: await this.shouldBeActiveInTx(
        tx,
        params.authorUserId,
        subjectUserId,
      ),
      publishAccepted,
    };
  }

  async setPairActiveInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
    active: boolean,
  ): Promise<boolean> {
    const [low, high] = this.canonicalPair(firstUserId, secondUserId);
    await this.lockPairInTx(tx, low, high);
    const changed = await tx.execute(sql`
      UPDATE "RelationshipPair" SET active = ${active}, revision = revision + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userLowId" = ${low} AND "userHighId" = ${high}
        AND active IS DISTINCT FROM ${active}
      RETURNING revision
    `);
    return (changed.rowCount ?? 0) > 0;
  }

  async lockPairInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
  ) {
    const [low, high] = this.canonicalPair(firstUserId, secondUserId);
    await tx.execute(sql`
      INSERT INTO "RelationshipPair" ("userLowId", "userHighId")
      VALUES (${low}, ${high}) ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      SELECT 1 FROM "RelationshipPair"
      WHERE "userLowId" = ${low} AND "userHighId" = ${high} FOR UPDATE
    `);
  }

  private async readIntentInTx(
    tx: DatabaseTransaction,
    authorUserId: number,
    subjectUserId: number,
  ): Promise<RawIntent | undefined> {
    const result = await tx.execute<RawIntent>(sql`
      SELECT status, note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorUserId" = ${authorUserId}
        AND "subjectUserId" = ${subjectUserId}
    `);
    return result.rows[0];
  }

  private async shouldBeActiveInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
  ) {
    const [low, high] = this.canonicalPair(firstUserId, secondUserId);
    const result = await tx.execute<{ active: boolean }>(sql`
      SELECT COUNT(*) FILTER (
        WHERE status <> 'REVOKED'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
      ) = 2 AND BOOL_OR(status = 'ACCEPTED') AS active
      FROM "RelationshipIntent"
      WHERE ("authorUserId" = ${low} AND "subjectUserId" = ${high})
         OR ("authorUserId" = ${high} AND "subjectUserId" = ${low})
    `);
    return result.rows[0]?.active ?? false;
  }

  private otherUser(params: {
    groupUserId: number;
    memberUserId: number;
    authorUserId: number;
  }) {
    return params.authorUserId === params.groupUserId
      ? params.memberUserId
      : params.groupUserId;
  }

  private isValidRequest(intent: RawIntent | undefined) {
    return (
      intent?.status === 'REQUESTED' &&
      intent.expiresAt !== null &&
      asDate(intent.expiresAt)!.getTime() > Date.now()
    );
  }

  private canonicalPair(firstUserId: number, secondUserId: number) {
    return firstUserId < secondUserId
      ? ([firstUserId, secondUserId] as const)
      : ([secondUserId, firstUserId] as const);
  }
}
