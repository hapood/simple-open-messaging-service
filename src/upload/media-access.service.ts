import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';

/**
 * Per-object media authorization. Answers the single question the /uploads/shards/* gate needs:
 * "may this user read this digest?" — true iff the user is an active participant (leftAt IS NULL) of
 * at least one thread whose messages reference the digest.
 *
 * Backed by one indexed query over MediaMessage JOIN ThreadParticipant (the digest index selects ~1
 * row; sha256 is near-unique). Covers P2P (2 participants) and GROUP (N) uniformly via the shared
 * ThreadParticipant table. Type-agnostic by design — membership is leftAt IS NULL regardless of role.
 *
 * Avatars (/uploads/avatars/*) never reach this service: the gate calls it only for
 * /uploads/shards/ paths. Avatars stay auth-n-only (they must render cross-thread in
 * lists/search/federation).
 */
@Injectable()
export class MediaAccessService {
  constructor(private readonly database: DatabaseService) {}

  /** True iff `userId` is an active member of a thread that contains a message referencing `digest`. */
  async canReadDigest(userId: number, digest: string): Promise<boolean> {
    const result = await this.database.db.execute(sql<{ allowed: boolean }>`
      WITH RECURSIVE visible_bundle("bundleId", depth) AS (
        SELECT fba."bundleId", 0
        FROM "ForwardBundleAsset" fba
        WHERE fba.digest = ${digest}
        UNION ALL
        SELECT dependency."parentBundleId", visible_bundle.depth + 1
        FROM visible_bundle
        JOIN "ForwardBundleDependency" dependency
          ON dependency."childBundleId" = visible_bundle."bundleId"
        WHERE visible_bundle.depth < 2
      )
      SELECT EXISTS (
        SELECT 1
        FROM "MediaMessage" media
        JOIN "ThreadParticipant" participant
          ON participant."threadId" = media."threadId"
         AND participant."userId" = ${userId}
         AND participant."leftAt" IS NULL
        WHERE media.digest = ${digest}
        UNION ALL
        SELECT 1
        FROM visible_bundle bundle
        JOIN "ForwardMessage" forwarded
          ON forwarded."bundleId" = bundle."bundleId"
        JOIN "Message" message ON message.id = forwarded."messageId"
        JOIN "ThreadParticipant" participant
          ON participant."threadId" = message."threadId"
         AND participant."userId" = ${userId}
         AND participant."leftAt" IS NULL
        WHERE message."isDeleted" = false
      ) AS allowed
    `);
    return Boolean(result.rows[0]?.allowed);
  }
}
