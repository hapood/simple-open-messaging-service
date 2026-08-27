import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';

export interface FederationResetPreview {
  domain: string;
  haltReason: string | null;
  foreignUserCount: number;
  participantCount: number;
  affectedThreadCount: number;
  authoredMessageCount: number;
  inviteCount: number;
  deletionCursorCount: number;
  keyCacheCount: number;
  friendOperationCount: number;
  warning: string;
}

export interface FederationResetStartResult {
  domain: string;
  status: 'reset_in_progress';
  affectedThreadCount: number;
}

type PreviewRow = Omit<
  FederationResetPreview,
  'domain' | 'haltReason' | 'warning'
>;

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

@Injectable()
export class FederationResetService implements OnModuleInit {
  private readonly logger = new Logger(FederationResetService.name);
  private cleanupWorker: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    this.startCleanupWorker();
  }

  /**
   * Computes the destructive reset boundary under the same peer-scoped transaction lock that the
   * future executor will use. This endpoint deliberately performs no deletion and grants no re-init.
   */
  async preview(domain: string): Promise<FederationResetPreview> {
    const normalized = normalizeDomain(domain);
    if (!normalized || normalized.length > 63) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid federation domain',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'federation-reset:' + normalized}, 0))`,
      );
      const peerResult = await tx.execute<{
        trustLevel: string;
        haltCode: number | null;
        resetInProgress: boolean;
        haltReason: string | null;
      }>(sql`
        SELECT "trustLevel", "haltCode", "resetInProgress", "haltReason"
        FROM "FederatedPeer"
        WHERE domain = ${normalized}
        FOR UPDATE
      `);
      const peer = peerResult.rows[0];
      if (!peer) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'peer not found',
          HttpStatus.NOT_FOUND,
        );
      }
      if (
        peer.trustLevel !== 'halted' ||
        peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
        peer.resetInProgress
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'only an idle identity-mismatch halted peer can be reset',
          HttpStatus.CONFLICT,
        );
      }

      const result = await tx.execute<PreviewRow>(sql`
        WITH remote_users AS (
          SELECT id FROM "User" WHERE "sourceDomain" = ${normalized}
        ), affected_threads AS (
          SELECT DISTINCT member."threadId"
          FROM "ThreadMember" member
          JOIN remote_users ru ON ru.id = member."userId"
        )
        SELECT
          (SELECT count(*)::int FROM remote_users) AS "foreignUserCount",
          (SELECT count(*)::int FROM "ThreadMember" member JOIN remote_users ru ON ru.id = member."userId") AS "participantCount",
          (SELECT count(*)::int FROM affected_threads) AS "affectedThreadCount",
          (SELECT count(*)::int FROM "Message" m WHERE m."creatorDomain" = ${normalized}) AS "authoredMessageCount",
          (SELECT count(*)::int FROM "RelationshipIntent" intent
             JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
             WHERE pair."endpointADomain" = ${normalized}
                OR pair."endpointBDomain" = ${normalized}) AS "inviteCount",
          (SELECT count(*)::int FROM "FederationDeletedCursor" WHERE "peerDomain" = ${normalized}) AS "deletionCursorCount",
          (SELECT count(*)::int FROM "S2SKeyCache" WHERE domain = ${normalized}) AS "keyCacheCount",
          0::int AS "friendOperationCount"
      `);
      const counts = result.rows[0];
      if (!counts) throw new Error('federation reset preview returned no row');
      return {
        domain: normalized,
        haltReason: peer.haltReason,
        ...counts,
        warning:
          'Preview only. A later reset will permanently remove this peer identity and associated authorization data.',
      };
    });
  }

  /**
   * Starts at most one in-process worker. PostgreSQL's partial unique index guarantees that every
   * process observes the same reset domain; each thread becomes undiscoverable only after its final
   * marker is written, so repeating the idempotent deletes after a crash is safe.
   */
  private startCleanupWorker(): void {
    if (this.cleanupWorker) return;
    this.cleanupWorker = this.cleanupPendingThreads()
      .catch((error: unknown) => {
        this.logger.error(
          'Federation reset thread cleanup stopped; it will resume after restart or reset retry',
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.cleanupWorker = null;
      });
  }

  private async cleanupPendingThreads(): Promise<void> {
    const active = await this.database.db.execute<{ domain: string }>(sql`
      SELECT domain
      FROM "FederatedPeer"
      WHERE "resetInProgress" = true
      LIMIT 1
    `);
    const domain = active.rows[0]?.domain;
    if (!domain) return;
    for (;;) {
      const threadId = await this.findNextPendingThread(domain);
      if (threadId === null) {
        await this.finalizeDomainReset(domain);
        return;
      }
      await this.truncateThread(threadId);
    }
  }

  private async findNextPendingThread(domain: string): Promise<number | null> {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      WITH remote_users AS (
        SELECT id
        FROM "User"
        WHERE "sourceDomain" = ${domain}
      ), affected_threads AS (
        SELECT member."threadId"
        FROM "ThreadMember" member
        JOIN remote_users ru ON ru.id = member."userId"
        UNION
        SELECT m."threadId"
        FROM "Message" m
        WHERE m."creatorDomain" = ${domain}
        UNION
        SELECT mt.id
        FROM "MessageThread" mt
        JOIN "Group" group_profile ON group_profile.id = mt."groupId"
        WHERE group_profile.domain = ${domain}
      )
      SELECT mt.id AS "threadId"
      FROM "MessageThread" mt
      WHERE mt.id IN (SELECT "threadId" FROM affected_threads)
        AND mt."federationTruncated" = false
      ORDER BY mt.id
      LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  /**
   * The large deletes are intentionally idempotent and outside a long transaction. A crash leaves
   * federationTruncated=false and the worker repeats them. Only the final removal of the discoverable
   * participant link and the generation marker flip form one short transaction.
   */
  private async truncateThread(threadId: number): Promise<void> {
    await this.database.db.execute(
      sql`DELETE FROM "MessageReport" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "MessageAsset" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(sql`
      DELETE FROM "ForwardMessage" fm USING "Message" m
      WHERE fm."messageId" = m.id AND m."threadId" = ${threadId}
    `);
    await this.database.db.execute(
      sql`DELETE FROM "DeletedMessage" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "FederatedMessageTombstone" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "FederationDeletedCursor" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "PendingMedia" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "RelationshipPair" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(
      sql`DELETE FROM "Message" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.transaction(async (tx) => {
      const group = await tx.execute<{ groupId: number | null }>(sql`
        SELECT "groupId" FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE
      `);
      await tx.execute(
        sql`DELETE FROM "ThreadParticipant" WHERE "threadId" = ${threadId}`,
      );
      await tx.execute(
        sql`DELETE FROM "ThreadMember" WHERE "threadId" = ${threadId}`,
      );
      await tx.execute(sql`
        UPDATE "MessageThread"
        SET "federationTruncated" = true,
            "federationVersion" = "federationVersion" + 1,
            "curSeq" = 0,
            "pullUntil" = 0,
            "lastMessageSeq" = NULL,
            "lastMessagePreview" = NULL,
            "lastMessageAt" = NULL,
            "groupId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${threadId} AND "federationTruncated" = false
      `);
      if (group.rows[0]?.groupId != null) {
        await tx.execute(
          sql`DELETE FROM "Group" WHERE id = ${group.rows[0].groupId}`,
        );
      }
    });
  }

  private async finalizeDomainReset(domain: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('federation-reset-global', 0))`,
      );
      const peerResult = await tx.execute<{
        trustLevel: string;
        resetInProgress: boolean;
        resetGeneration: number;
      }>(sql`
        SELECT "trustLevel", "resetInProgress", "resetGeneration"
        FROM "FederatedPeer"
        WHERE domain = ${domain}
        FOR UPDATE
      `);
      const peer = peerResult.rows[0];
      if (!peer || peer.trustLevel !== 'halted' || !peer.resetInProgress)
        return;

      const pending = await this.countPendingThreads(tx, domain);
      if (pending !== 0) return;
      const generation = peer.resetGeneration + 1;
      await tx.execute(sql`
        DELETE FROM "RelationshipPair"
        WHERE "endpointADomain" = ${domain} OR "endpointBDomain" = ${domain}
      `);
      await tx.execute(
        sql`DELETE FROM "FederatedMessageTombstone" WHERE "sourceDomain" = ${domain} OR "authorityDomain" = ${domain}`,
      );
      await tx.execute(
        sql`DELETE FROM "FederationDeletedCursor" WHERE "peerDomain" = ${domain}`,
      );
      await tx.execute(sql`DELETE FROM "S2SKeyCache" WHERE domain = ${domain}`);
      await tx.execute(
        sql`DELETE FROM "QuotaDailyUsage" WHERE domain = ${domain}`,
      );
      // Authorization and the peer's small cursor/reconstruction state are removed before its
      // identity anchor. Peer deletion cascades the federation serve/pull cursors.
      await tx.execute(
        sql`DELETE FROM "ThreadAudience" WHERE "targetDomain" = ${domain}`,
      );
      await tx.execute(sql`
        DELETE FROM "User"
        WHERE "sourceDomain" = ${domain}
      `);
      await tx.execute(sql`
        INSERT INTO "FederatedPeerReset" (domain, "resetGeneration", "reinitPending", "resetAt")
        VALUES (${domain}, ${generation}, true, CURRENT_TIMESTAMP)
        ON CONFLICT (domain) DO UPDATE
        SET "resetGeneration" = GREATEST("FederatedPeerReset"."resetGeneration", EXCLUDED."resetGeneration"),
            "reinitPending" = true,
            "resetAt" = CURRENT_TIMESTAMP
      `);
      await tx.execute(sql`
        INSERT INTO "FederatedPeerEvent" (domain, type, reason)
        VALUES (${domain}, 'reset_completed', 'federation data and authorization were destructively reset')
      `);
      await tx.execute(
        sql`DELETE FROM "FederatedPeer" WHERE domain = ${domain}`,
      );
    });
  }

  /**
   * Freezes one identity-mismatch halted peer and snapshots its current thread set into the retained thread
   * shells. Cleanup itself is deliberately outside this short transaction and is safely resumable by
   * repeatedly selecting related rows where federationTruncated=false.
   */
  async start(
    domain: string,
    confirmDomain: string,
  ): Promise<FederationResetStartResult> {
    const normalized = this.requireDomain(domain);
    if (this.requireDomain(confirmDomain) !== normalized) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'confirmation domain does not match',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result =
      await this.database.db.transaction<FederationResetStartResult>(
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended('federation-reset-global', 0))`,
          );
          const peers = await tx.execute<{
            domain: string;
            trustLevel: string;
            haltCode: number | null;
            resetInProgress: boolean;
          }>(sql`
        SELECT domain, "trustLevel", "haltCode", "resetInProgress"
        FROM "FederatedPeer"
        WHERE domain = ${normalized} OR "resetInProgress" = true
        FOR UPDATE
      `);
          const peer = peers.rows.find((row) => row.domain === normalized);
          if (!peer) {
            throw new BusinessException(
              BusinessCode.NOT_FOUND,
              'peer not found',
              HttpStatus.NOT_FOUND,
            );
          }
          const active = peers.rows.find((row) => row.resetInProgress);
          if (active) {
            if (active.domain === normalized) {
              const pending = await this.countPendingThreads(tx, normalized);
              return {
                domain: normalized,
                status: 'reset_in_progress',
                affectedThreadCount: pending,
              };
            }
            throw new BusinessException(
              BusinessCode.VALIDATION_FAILED,
              `federation reset already in progress for ${active.domain}`,
              HttpStatus.CONFLICT,
            );
          }
          if (
            peer.trustLevel !== 'halted' ||
            peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
              'only an identity-mismatch halted peer can be reset',
              HttpStatus.CONFLICT,
            );
          }

          const marked = await tx.execute<{ threadId: number }>(sql`
        WITH remote_users AS (
          SELECT id
          FROM "User"
          WHERE "sourceDomain" = ${normalized}
        ), affected_threads AS (
          SELECT member."threadId"
          FROM "ThreadMember" member
          JOIN remote_users ru ON ru.id = member."userId"
          UNION
          SELECT m."threadId"
          FROM "Message" m
          WHERE m."creatorDomain" = ${normalized}
          UNION
          SELECT mt.id
          FROM "MessageThread" mt
          JOIN "Group" group_profile ON group_profile.id = mt."groupId"
          WHERE group_profile.domain = ${normalized}
        )
        UPDATE "MessageThread" mt
        SET "federationTruncated" = false,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE mt.id IN (SELECT "threadId" FROM affected_threads)
        RETURNING mt.id AS "threadId"
      `);
          await tx.execute(sql`
        UPDATE "FederatedPeer"
        SET "resetInProgress" = true,
            "resetAt" = CURRENT_TIMESTAMP,
            "haltReason" = COALESCE("haltReason", 'destructive reset in progress')
        WHERE domain = ${normalized}
      `);
          await tx.execute(sql`
        INSERT INTO "FederatedPeerEvent" (domain, type, reason)
        VALUES (${normalized}, 'reset_started', 'administrator confirmed destructive federation reset')
      `);
          return {
            domain: normalized,
            status: 'reset_in_progress',
            affectedThreadCount: marked.rows.length,
          };
        },
      );
    this.startCleanupWorker();
    return result;
  }

  private requireDomain(value: string): string {
    const normalized = normalizeDomain(value);
    if (!normalized || normalized.length > 63) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid federation domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    return normalized;
  }

  private async countPendingThreads(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<number> {
    const result = await tx.execute<{ count: number }>(sql`
      WITH remote_users AS (
        SELECT id
        FROM "User"
        WHERE "sourceDomain" = ${domain}
      ), affected_threads AS (
        SELECT member."threadId"
        FROM "ThreadMember" member
        JOIN remote_users ru ON ru.id = member."userId"
        UNION
        SELECT m."threadId"
        FROM "Message" m
        WHERE m."creatorDomain" = ${domain}
        UNION
        SELECT mt.id
        FROM "MessageThread" mt
        JOIN "Group" group_profile ON group_profile.id = mt."groupId"
        WHERE group_profile.domain = ${domain}
      )
      SELECT count(*)::int AS count
      FROM "MessageThread" mt
      WHERE mt.id IN (SELECT "threadId" FROM affected_threads)
        AND mt."federationTruncated" = false
    `);
    return result.rows[0]?.count ?? 0;
  }
}
