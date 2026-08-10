import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';

export interface FederationResetPreview {
  domain: string;
  identityLostReason: string | null;
  foreignUserCount: number;
  participantCount: number;
  affectedThreadCount: number;
  authoredMessageCount: number;
  inviteCount: number;
  userBlockCount: number;
  deletionCursorCount: number;
  keyCacheCount: number;
  nonceCount: number;
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
  'domain' | 'identityLostReason' | 'warning'
>;

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

@Injectable()
export class FederationResetService implements OnModuleInit {
  private readonly logger = new Logger(FederationResetService.name);
  private cleanupWorker: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly threadRevisions: ThreadRevisionService,
  ) {}

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
        identityLostReason: string | null;
      }>(sql`
        SELECT "trustLevel", "identityLostReason"
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
      if (peer.trustLevel !== 'identity_lost') {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'only an identity_lost peer can be reset',
          HttpStatus.CONFLICT,
        );
      }

      const result = await tx.execute<PreviewRow>(sql`
        WITH remote_users AS (
          SELECT id FROM "User" WHERE domain = ${normalized} AND "isForeigner" = true
        ), affected_threads AS (
          SELECT DISTINCT tp."threadId"
          FROM "ThreadParticipant" tp
          JOIN remote_users ru ON ru.id = tp."userId"
        )
        SELECT
          (SELECT count(*)::int FROM remote_users) AS "foreignUserCount",
          (SELECT count(*)::int FROM "ThreadParticipant" tp JOIN remote_users ru ON ru.id = tp."userId") AS "participantCount",
          (SELECT count(*)::int FROM affected_threads) AS "affectedThreadCount",
          (SELECT count(*)::int FROM "Message" m JOIN remote_users ru ON ru.id = m.creator) AS "authoredMessageCount",
          ((SELECT count(*)::int FROM "FriendRequest" r
             WHERE r."requesterUserId" IN (SELECT id FROM remote_users)
                OR r."targetUserId" IN (SELECT id FROM remote_users))
           + (SELECT count(*)::int FROM "GroupMembershipRequest" r
             WHERE r."groupUserId" IN (SELECT id FROM remote_users)
                OR r."memberUserId" IN (SELECT id FROM remote_users))) AS "inviteCount",
          (SELECT count(*)::int FROM "UserBlock" b WHERE b."blockerId" IN (SELECT id FROM remote_users)
             OR b."blockedId" IN (SELECT id FROM remote_users)) AS "userBlockCount",
          (SELECT count(*)::int FROM "FederationDeletedCursor" WHERE "peerDomain" = ${normalized}) AS "deletionCursorCount",
          (SELECT count(*)::int FROM "S2SKeyCache" WHERE domain = ${normalized}) AS "keyCacheCount",
          (SELECT count(*)::int FROM "S2SIdentityNonce" WHERE "originDomain" = ${normalized}) AS "nonceCount",
          0::int AS "friendOperationCount"
      `);
      const counts = result.rows[0];
      if (!counts) throw new Error('federation reset preview returned no row');
      return {
        domain: normalized,
        identityLostReason: peer.identityLostReason,
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
      WHERE "trustLevel" = 'reset_in_progress'
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
        WHERE domain = ${domain} AND "isForeigner" = true
      ), affected_threads AS (
        SELECT tp."threadId"
        FROM "ThreadParticipant" tp
        JOIN remote_users ru ON ru.id = tp."userId"
        UNION
        SELECT m."threadId"
        FROM "Message" m
        JOIN remote_users ru ON ru.id = m.creator
        UNION
        SELECT mt.id
        FROM "MessageThread" mt
        JOIN remote_users ru ON ru.id = mt."groupUserId"
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
    const revisions = await this.database.db.execute<{
      userId: number;
      revision: number;
    }>(sql`
      WITH candidates AS (
        SELECT DISTINCT tp."userId"
        FROM "ThreadParticipant" tp
        JOIN "User" u ON u.id = tp."userId"
        WHERE tp."threadId" = ${threadId}
          AND u."isForeigner" = false
          AND NOT EXISTS (
            SELECT 1 FROM "ThreadRevision" tr
            WHERE tr."userId" = tp."userId"
              AND tr."threadId" = ${threadId}
              AND tr.direction = 'DELETE'
          )
      ), bumped AS (
        UPDATE "User" u
        SET "threadRevision" = u."threadRevision" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        FROM candidates c
        WHERE u.id = c."userId"
        RETURNING u.id AS "userId", u."threadRevision" AS revision
      )
      INSERT INTO "ThreadRevision" ("userId", "threadId", direction, revision, "isDelete")
      SELECT "userId", ${threadId}, 'DELETE', revision, false FROM bumped
      ON CONFLICT ("userId", "threadId", direction)
      DO UPDATE SET revision = EXCLUDED.revision
      RETURNING "userId", revision
    `);
    await this.database.db.execute(sql`
      UPDATE "ThreadRevision" SET "isDelete" = true
      WHERE "threadId" = ${threadId} AND direction = 'ADD'
    `);
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
    await this.database.db.execute(sql`
      DELETE FROM "GroupMembershipRequest"
      WHERE "groupUserId" = (
        SELECT "groupUserId" FROM "MessageThread" WHERE id = ${threadId}
      )
    `);
    await this.database.db.execute(
      sql`DELETE FROM "Message" WHERE "threadId" = ${threadId}`,
    );
    await this.database.db.execute(sql`
      DELETE FROM "Group" g
      USING "MessageThread" mt
      WHERE mt.id = ${threadId} AND g."groupUserId" = mt."groupUserId"
    `);
    await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM "ThreadParticipant" WHERE "threadId" = ${threadId}`,
      );
      await tx.execute(sql`
        UPDATE "MessageThread"
        SET "federationTruncated" = true,
            "federationVersion" = "federationVersion" + 1,
            "curSeq" = -1,
            "pullUntil" = -1,
            "lastMessageSeq" = NULL,
            "lastMessagePreview" = NULL,
            "lastMessageAt" = NULL,
            "groupUserId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${threadId} AND "federationTruncated" = false
      `);
    });
    for (const revision of revisions.rows) {
      this.threadRevisions.notifyThreadRevision(revision);
    }
  }

  private async finalizeDomainReset(domain: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('federation-reset-global', 0))`,
      );
      const peerResult = await tx.execute<{
        trustLevel: string;
        resetGeneration: number;
      }>(sql`
        SELECT "trustLevel", "resetGeneration"
        FROM "FederatedPeer"
        WHERE domain = ${domain}
        FOR UPDATE
      `);
      const peer = peerResult.rows[0];
      if (!peer || peer.trustLevel !== 'reset_in_progress') return;

      const pending = await this.countPendingThreads(tx, domain);
      if (pending !== 0) return;
      const generation = peer.resetGeneration + 1;
      await tx.execute(sql`
        WITH remote_users AS (
          SELECT id FROM "User"
          WHERE domain = ${domain} AND "isForeigner" = true
        )
        DELETE FROM "FriendRequest"
        WHERE "requesterUserId" IN (SELECT id FROM remote_users)
           OR "targetUserId" IN (SELECT id FROM remote_users)
      `);
      await tx.execute(sql`
        WITH remote_users AS (
          SELECT id FROM "User"
          WHERE domain = ${domain} AND "isForeigner" = true
        )
        DELETE FROM "GroupMembershipRequest"
        WHERE "groupUserId" IN (SELECT id FROM remote_users)
           OR "memberUserId" IN (SELECT id FROM remote_users)
      `);
      await tx.execute(sql`
        WITH remote_users AS (
          SELECT id FROM "User"
          WHERE domain = ${domain} AND "isForeigner" = true
        )
        DELETE FROM "UserBlock"
        WHERE "blockerId" IN (SELECT id FROM remote_users)
           OR "blockedId" IN (SELECT id FROM remote_users)
      `);
      await tx.execute(sql`
        DELETE FROM "UploadSession"
        WHERE "creatorId" IN (
          SELECT id FROM "User"
          WHERE domain = ${domain} AND "isForeigner" = true
        )
      `);
      await tx.execute(sql`
        DELETE FROM "PushToken" WHERE "userId" IN (
          SELECT id FROM "User" WHERE domain = ${domain} AND "isForeigner" = true
        )
      `);
      await tx.execute(sql`
        DELETE FROM "LoginCode" WHERE "userId" IN (
          SELECT id FROM "User" WHERE domain = ${domain} AND "isForeigner" = true
        )
      `);
      await tx.execute(sql`
        DELETE FROM "SessionToken" WHERE "userId" IN (
          SELECT id FROM "User" WHERE domain = ${domain} AND "isForeigner" = true
        )
      `);
      await tx.execute(sql`
        DELETE FROM "DiagnosticsReport" WHERE "reporterUserId" IN (
          SELECT id FROM "User" WHERE domain = ${domain} AND "isForeigner" = true
        )
      `);
      await tx.execute(
        sql`DELETE FROM "FederatedMessageTombstone" WHERE "sourceDomain" = ${domain} OR "authorityDomain" = ${domain}`,
      );
      await tx.execute(
        sql`DELETE FROM "FederationDeletedCursor" WHERE "peerDomain" = ${domain}`,
      );
      await tx.execute(
        sql`DELETE FROM "S2SIdentityNonce" WHERE "originDomain" = ${domain}`,
      );
      await tx.execute(sql`DELETE FROM "S2SKeyCache" WHERE domain = ${domain}`);
      await tx.execute(
        sql`DELETE FROM "QuotaDailyUsage" WHERE domain = ${domain}`,
      );
      // Authorization and the peer's delivery index are removed before its identity anchor.
      // DiscoveryTarget owns DiscoveryChange and FederationServeCursor through ON DELETE CASCADE.
      // The GC worker uses row-level SKIP LOCKED on the same target/cursor, so it cannot race this
      // destructive reset into deleting another peer's rows.
      await tx.execute(
        sql`DELETE FROM "ThreadAudience" WHERE "targetDomain" = ${domain}`,
      );
      await tx.execute(
        sql`DELETE FROM "DiscoveryTarget" WHERE "targetDomain" = ${domain} AND "localUserId" IS NULL`,
      );
      await tx.execute(sql`
        DELETE FROM "User"
        WHERE domain = ${domain} AND "isForeigner" = true
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
   * Freezes one identity-lost peer and snapshots its current thread set into the retained thread
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
          }>(sql`
        SELECT domain, "trustLevel"
        FROM "FederatedPeer"
        WHERE domain = ${normalized} OR "trustLevel" = 'reset_in_progress'
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
          const active = peers.rows.find(
            (row) => row.trustLevel === 'reset_in_progress',
          );
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
          if (peer.trustLevel !== 'identity_lost') {
            throw new BusinessException(
              BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
              'only an identity_lost peer can be reset',
              HttpStatus.CONFLICT,
            );
          }

          const marked = await tx.execute<{ threadId: number }>(sql`
        WITH remote_users AS (
          SELECT id
          FROM "User"
          WHERE domain = ${normalized} AND "isForeigner" = true
        ), affected_threads AS (
          SELECT tp."threadId"
          FROM "ThreadParticipant" tp
          JOIN remote_users ru ON ru.id = tp."userId"
          UNION
          SELECT m."threadId"
          FROM "Message" m
          JOIN remote_users ru ON ru.id = m.creator
          UNION
          SELECT mt.id
          FROM "MessageThread" mt
          JOIN remote_users ru ON ru.id = mt."groupUserId"
        )
        UPDATE "MessageThread" mt
        SET "federationTruncated" = false,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE mt.id IN (SELECT "threadId" FROM affected_threads)
        RETURNING mt.id AS "threadId"
      `);
          await tx.execute(sql`
        UPDATE "FederatedPeer"
        SET "trustLevel" = 'reset_in_progress',
            "resetAt" = CURRENT_TIMESTAMP
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
        WHERE domain = ${domain} AND "isForeigner" = true
      ), affected_threads AS (
        SELECT tp."threadId"
        FROM "ThreadParticipant" tp
        JOIN remote_users ru ON ru.id = tp."userId"
        UNION
        SELECT m."threadId"
        FROM "Message" m
        JOIN remote_users ru ON ru.id = m.creator
        UNION
        SELECT mt.id
        FROM "MessageThread" mt
        JOIN remote_users ru ON ru.id = mt."groupUserId"
      )
      SELECT count(*)::int AS count
      FROM "MessageThread" mt
      WHERE mt.id IN (SELECT "threadId" FROM affected_threads)
        AND mt."federationTruncated" = false
    `);
    return result.rows[0]?.count ?? 0;
  }
}
