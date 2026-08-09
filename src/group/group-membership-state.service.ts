import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';

export type GroupMembershipDirection = 'INVITE' | 'JOIN';
export type GroupMembershipStatus = 'REQUESTED' | 'MEMBER' | 'NOT_MEMBER';

export interface GroupMembershipRequestState extends Record<string, unknown> {
  status: GroupMembershipStatus;
  note: string;
  revision: number;
  requestedAt: Date | null;
  expiresAt: Date | null;
}

type RawGroupMembershipRequestState = {
  status: GroupMembershipStatus;
  note: string;
  revision: number;
  requestedAt: Date | string | null;
  expiresAt: Date | string | null;
};

function asDate(value: Date | string | null): Date | null {
  return value === null || value instanceof Date ? value : new Date(value);
}

function normalizeRequest(
  request: RawGroupMembershipRequestState,
): GroupMembershipRequestState {
  return {
    ...request,
    requestedAt: asDate(request.requestedAt),
    expiresAt: asDate(request.expiresAt),
  };
}

@Injectable()
export class GroupMembershipStateService {
  async hasValidInviteInTx(
    tx: DatabaseTransaction,
    groupUserId: number,
    memberUserId: number,
  ): Promise<boolean> {
    const result = await tx.execute<{ valid: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "GroupMembershipRequest"
        WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
          AND direction = 'INVITE' AND status <> 'NOT_MEMBER'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
      ) AS valid
    `);
    return result.rows[0]?.valid ?? false;
  }

  async writeLocalDirectionInTx(
    tx: DatabaseTransaction,
    params: {
      groupUserId: number;
      memberUserId: number;
      direction: GroupMembershipDirection;
      requested: boolean;
      note?: string;
      expiresAt?: Date | null;
    },
  ): Promise<{
    request: GroupMembershipRequestState;
    shouldBeActive: boolean;
    changed: boolean;
  }> {
    await this.lockPairInTx(tx, params.groupUserId, params.memberUserId);
    const desired = params.requested ? 'REQUESTED' : 'NOT_MEMBER';
    const written = await tx.execute<RawGroupMembershipRequestState>(sql`
      INSERT INTO "GroupMembershipRequest" (
        "groupUserId", "memberUserId", direction, status, note, revision,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.groupUserId}, ${params.memberUserId},
        ${params.direction}::"GroupMembershipDirection",
        ${desired}::"GroupMembershipRequestStatus",
        ${params.requested ? (params.note ?? '').slice(0, 255) : ''}, 1,
        ${params.requested ? new Date() : null}, ${params.expiresAt ?? null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        revision = "GroupMembershipRequest".revision + 1,
        "requestedAt" = CASE WHEN EXCLUDED.status = 'REQUESTED' THEN CURRENT_TIMESTAMP
                             ELSE "GroupMembershipRequest"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "GroupMembershipRequest".status IS DISTINCT FROM EXCLUDED.status
         OR "GroupMembershipRequest".note IS DISTINCT FROM EXCLUDED.note
         OR "GroupMembershipRequest"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING status, note, revision, "requestedAt", "expiresAt"
    `);
    const rawRequest =
      written.rows[0] ??
      (await this.readDirectionInTx(
        tx,
        params.groupUserId,
        params.memberUserId,
        params.direction,
      ));
    if (!rawRequest)
      throw new Error('group membership request write disappeared');
    return {
      request: normalizeRequest(rawRequest),
      shouldBeActive: await this.shouldBeActiveInTx(
        tx,
        params.groupUserId,
        params.memberUserId,
      ),
      changed: written.rows.length > 0,
    };
  }

  async applyRemoteDirectionInTx(
    tx: DatabaseTransaction,
    params: {
      groupUserId: number;
      memberUserId: number;
      direction: GroupMembershipDirection;
      status: GroupMembershipStatus;
      note: string;
      revision: number;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ): Promise<{ changed: boolean; shouldBeActive: boolean }> {
    await this.lockPairInTx(tx, params.groupUserId, params.memberUserId);
    const applied = await tx.execute(sql`
      INSERT INTO "GroupMembershipRequest" (
        "groupUserId", "memberUserId", direction, status, note, revision,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.groupUserId}, ${params.memberUserId},
        ${params.direction}::"GroupMembershipDirection",
        ${params.status}::"GroupMembershipRequestStatus", ${params.note.slice(0, 255)},
        ${params.revision}, ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note, revision = EXCLUDED.revision,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "GroupMembershipRequest".revision < EXCLUDED.revision
      RETURNING revision
    `);
    return {
      changed: (applied.rowCount ?? 0) > 0,
      shouldBeActive: await this.shouldBeActiveInTx(
        tx,
        params.groupUserId,
        params.memberUserId,
      ),
    };
  }

  async setPairActiveInTx(
    tx: DatabaseTransaction,
    groupUserId: number,
    memberUserId: number,
    active: boolean,
  ): Promise<boolean> {
    await this.lockPairInTx(tx, groupUserId, memberUserId);
    const changed = await tx.execute(sql`
      UPDATE "GroupMembershipPair" SET active = ${active}, revision = revision + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
        AND active IS DISTINCT FROM ${active}
      RETURNING revision
    `);
    if (active)
      await tx.execute(sql`
        UPDATE "GroupMembershipRequest" SET status = 'MEMBER', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
          AND status <> 'NOT_MEMBER'
      `);
    return (changed.rowCount ?? 0) > 0;
  }

  private async lockPairInTx(
    tx: DatabaseTransaction,
    groupUserId: number,
    memberUserId: number,
  ) {
    await tx.execute(sql`
      INSERT INTO "GroupMembershipPair" ("groupUserId", "memberUserId")
      VALUES (${groupUserId}, ${memberUserId}) ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      SELECT 1 FROM "GroupMembershipPair"
      WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
      FOR UPDATE
    `);
  }

  private async readDirectionInTx(
    tx: DatabaseTransaction,
    groupUserId: number,
    memberUserId: number,
    direction: GroupMembershipDirection,
  ): Promise<RawGroupMembershipRequestState | undefined> {
    const row = await tx.execute<RawGroupMembershipRequestState>(sql`
      SELECT status, note, revision, "requestedAt", "expiresAt"
      FROM "GroupMembershipRequest"
      WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
        AND direction = ${direction}
    `);
    return row.rows[0];
  }

  private async shouldBeActiveInTx(
    tx: DatabaseTransaction,
    groupUserId: number,
    memberUserId: number,
  ) {
    const result = await tx.execute<{ active: boolean }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status <> 'NOT_MEMBER'
            AND (direction <> 'INVITE' OR "expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
        ) = 2 AS active
      FROM "GroupMembershipRequest"
      WHERE "groupUserId" = ${groupUserId} AND "memberUserId" = ${memberUserId}
    `);
    return result.rows[0]?.active ?? false;
  }
}
