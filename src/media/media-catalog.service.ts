import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';

export interface MediaCatalogQuery {
  skip?: number;
  take?: number;
  userId?: number;
  digest?: string;
  status?: 'available' | 'reclaimed';
}

/** A user association means an author or completed uploader, never a viewer or exclusive owner. */
export interface MediaUser {
  account: string;
  namespaceId: number;
}

/** Explicit projections are a privacy boundary: no message payloads, names, MIME types or paths. */
@Injectable()
export class MediaCatalogService {
  constructor(private readonly database: DatabaseService) {}

  private usersFor(relation: SQL): SQL {
    return sql`
      SELECT requested.digest, m."creatorAccount" AS account, m."profileNamespaceId" AS "namespaceId"
        FROM ${relation} requested JOIN "MessageAsset" ma ON ma.digest = requested.digest
        JOIN "Message" m ON m.id = ma."messageId"
       WHERE NOT m."isDeleted" AND m."creatorAccount" IS NOT NULL
      UNION
      SELECT requested.digest, a.account, a."namespaceId"
        FROM ${relation} requested JOIN "UploadSession" u ON u.digest = requested.digest
        JOIN "Account" a ON a.id = u."creatorId" WHERE u.status = 'COMPLETED'
    `;
  }

  async files(query: MediaCatalogQuery) {
    const associations = this.usersFor(sql`page`);
    const filter = sql`
      (${query.digest ?? ''} = '' OR asset.digest LIKE ${`${query.digest ?? ''}%`})
      AND (${query.status ?? ''} = '' OR asset."isDeleted" = ${query.status === 'reclaimed'})
      AND (${query.userId ?? null}::int IS NULL OR asset.digest IN (SELECT digest FROM user_digests))
    `;
    // Count, logical bytes and page share a single MVCC snapshot, including an empty last page.
    const result = await this.database.db.execute<{
      total: number;
      bytes: string;
      list: Array<{
        digest: string;
        bytes: string;
        status: string;
        users: MediaUser[];
        userCount: number;
      }>;
    }>(sql`
      WITH user_digests AS (
        SELECT ma.digest FROM "MessageAsset" ma JOIN "Message" m ON m.id = ma."messageId"
          JOIN "Account" a ON a.account = m."creatorAccount" AND a."namespaceId" = m."profileNamespaceId"
         WHERE a.id = ${query.userId ?? null} AND NOT m."isDeleted"
        UNION
        SELECT digest FROM "UploadSession" WHERE "creatorId" = ${query.userId ?? null} AND status = 'COMPLETED' AND digest IS NOT NULL
      ), filtered AS NOT MATERIALIZED (
        SELECT asset.digest, asset.bytes, asset."isDeleted" FROM "MediaAsset" asset WHERE ${filter}
      ), page AS (
        SELECT * FROM filtered ORDER BY digest LIMIT ${query.take ?? 50} OFFSET ${query.skip ?? 0}
      ), users AS (${associations}), totals AS (
        SELECT count(*)::int AS total, coalesce(sum(bytes), 0)::text AS bytes FROM filtered
      )
      SELECT totals.total, totals.bytes,
             coalesce((SELECT jsonb_agg(item ORDER BY item->>'digest') FROM (
               SELECT jsonb_build_object(
                 'digest', asset.digest, 'bytes', asset.bytes::text,
                 'status', CASE WHEN asset."isDeleted" THEN 'reclaimed' ELSE 'available' END,
                 'users', (SELECT coalesce(jsonb_agg(u), '[]'::jsonb) FROM (
                   SELECT account, "namespaceId" FROM users WHERE users.digest = asset.digest ORDER BY "namespaceId", account LIMIT 3
                 ) u),
                 'userCount', (SELECT count(*)::int FROM users WHERE users.digest = asset.digest)
               ) AS item FROM page asset
             ) items), '[]'::jsonb) AS list FROM totals
    `);
    return result.rows[0];
  }

  /** Resolve only the current bounded runtime page; independent of physical transfer coalescing. */
  async annotateRuntime<T extends { digest: string }>(
    list: T[],
  ): Promise<Array<T & { users: MediaUser[]; userCount: number }>> {
    if (!list.length) return [];
    const values = sql.join(
      [...new Set(list.map((entry) => entry.digest))].map(
        (digest) => sql`(${digest})`,
      ),
      sql`, `,
    );
    const result = await this.database.db.execute<{
      digest: string;
      users: MediaUser[];
      userCount: number;
    }>(sql`
      WITH requested(digest) AS (VALUES ${values}), users AS (
        ${this.usersFor(sql`requested`)}
        UNION
        SELECT requested.digest, m."creatorAccount", m."profileNamespaceId"
          FROM requested JOIN "FileSyncProgress" f ON f.digest = requested.digest
          JOIN "PendingMedia" p ON p."batchId" = f."batchId" JOIN "Message" m ON m.id = p."messageId"
         WHERE m."creatorAccount" IS NOT NULL
      )
      SELECT requested.digest,
             (SELECT count(*)::int FROM users WHERE users.digest = requested.digest) AS "userCount",
             (SELECT coalesce(jsonb_agg(u), '[]'::jsonb) FROM (
               SELECT account, "namespaceId" FROM users WHERE users.digest = requested.digest
               ORDER BY "namespaceId", account LIMIT 3
             ) u) AS users FROM requested
    `);
    const metadata = new Map(result.rows.map((row) => [row.digest, row]));
    return list.map((entry) => ({
      ...entry,
      users: metadata.get(entry.digest)?.users ?? [],
      userCount: metadata.get(entry.digest)?.userCount ?? 0,
    }));
  }

  /** Historical file details were not retained; terminal bytes must be unknown, not zero. */
  async batches(query: {
    skip?: number;
    take?: number;
    status?: string;
    userId?: number;
  }) {
    const result = await this.database.db.execute<{
      total: number;
      list: unknown[];
    }>(sql`
      WITH filtered AS MATERIALIZED (
        SELECT p."batchId", p.status, p."fileCnt", p."updatedAt", m."creatorAccount", m."profileNamespaceId"
          FROM "PendingMedia" p JOIN "Message" m ON m.id = p."messageId"
         WHERE p.direction = 'INBOUND' AND (${query.status ?? ''} = '' OR p.status = ${query.status ?? ''})
           AND (${query.userId ?? null}::int IS NULL OR EXISTS (SELECT 1 FROM "Account" a WHERE a.id = ${query.userId ?? null} AND a.account = m."creatorAccount" AND a."namespaceId" = m."profileNamespaceId"))
      ), page AS (
        SELECT * FROM filtered ORDER BY "updatedAt" DESC, "batchId" LIMIT ${query.take ?? 50} OFFSET ${query.skip ?? 0}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total,
             coalesce((SELECT jsonb_agg(item ORDER BY updated DESC, batch) FROM (
               SELECT p."updatedAt" AS updated, p."batchId" AS batch, jsonb_build_object(
                 'batchId', p."batchId", 'status', p.status,
                 'users', jsonb_build_array(jsonb_build_object('account', p."creatorAccount", 'namespaceId', p."profileNamespaceId")),
                 'totalFiles', p."fileCnt",
                 'files', (SELECT coalesce(jsonb_agg(f), '[]'::jsonb) FROM (
                   SELECT digest, status, "bytesTotal"::text, "bytesReceived"::text FROM "FileSyncProgress"
                   WHERE "batchId" = p."batchId" ORDER BY id LIMIT 100
                 ) f),
                 'completedFiles', CASE WHEN p.status = 'ready' THEN p."fileCnt"
                   WHEN p.status = 'failed' AND NOT EXISTS (SELECT 1 FROM "FileSyncProgress" f WHERE f."batchId" = p."batchId") THEN NULL ELSE (SELECT count(*)::int FROM "FileSyncProgress" f WHERE f."batchId" = p."batchId" AND f.status = 'SUCCEEDED') END,
                 'bytesTotal', CASE WHEN p.status = 'ready' THEN NULL ELSE
                   (SELECT sum(f."bytesTotal")::text FROM "FileSyncProgress" f WHERE f."batchId" = p."batchId") END,
                 'bytesReceived', CASE WHEN p.status = 'ready' THEN NULL ELSE
                   (SELECT sum(f."bytesReceived")::text FROM "FileSyncProgress" f WHERE f."batchId" = p."batchId") END
               ) AS item FROM page p
             ) items), '[]'::jsonb) AS list
    `);
    return result.rows[0];
  }
}
