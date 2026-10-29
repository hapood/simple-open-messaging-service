import { ConflictException, Injectable } from '@nestjs/common';
import { opendir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { UploadService } from '../upload/upload.service.js';
import { FederationDownloadScheduler } from '../federation/federation-download-scheduler.js';

/** Explicit maintenance only. Neither user/message references nor authorization are removed. */
@Injectable()
export class MediaMaintenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly scheduler: FederationDownloadScheduler,
  ) {}

  async reclaim(digest: string) {
    if (this.scheduler.hasDigest(digest))
      throw new ConflictException('stop active downloads first');
    return this.upload.withCasDigestLock(digest, async () =>
      this.database.db.transaction(async (tx) => {
        // Rare administrative reclamation must exclude reference admission, staged publication and
        // progress claims across API instances. Existing tables have no per-digest reference lock;
        // table write exclusion is deliberate, short-lived, and requires no schema changes.
        await tx.execute(
          sql`LOCK TABLE "MessageAsset", "ForwardBundleAsset", "UploadSession", "FileSyncProgress", "MediaAsset" IN SHARE ROW EXCLUSIVE MODE`,
        );
        const refs = await tx.execute<{ busy: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM "MessageAsset" WHERE digest = ${digest})
          OR EXISTS (SELECT 1 FROM "ForwardBundleAsset" WHERE digest = ${digest})
          OR EXISTS (SELECT 1 FROM "UploadSession" WHERE digest = ${digest} AND status IN ('UPLOADING', 'COMPLETING'))
          OR EXISTS (SELECT 1 FROM "FileSyncProgress" WHERE digest = ${digest}) AS busy
      `);
        if (refs.rows[0].busy)
          throw new ConflictException(
            'file still has references or active transfers',
          );
        const row = await tx.execute(
          sql`UPDATE "MediaAsset" SET "isDeleted" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE digest = ${digest} RETURNING digest`,
        );
        if (row.rows.length === 0) return { reclaimed: false };
        await unlink(this.upload.casPath(digest)!).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        return { reclaimed: true };
      }),
    );
  }

  async temporary(query: { skip?: number; take?: number; digest?: string }) {
    const sizes = new Map<string, number>();
    const directory = await opendir(this.upload.casTmpDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (directory)
      for await (const entry of directory) {
        const match =
          /^([a-f0-9]{64})\.(?:part|resume\.json(?:\.tmp)?|complete(?:\.tmp)?)$/.exec(
            entry.name,
          );
        if (
          !entry.isFile() ||
          !match ||
          !match[1].startsWith(query.digest ?? '')
        )
          continue;
        const info = await stat(join(this.upload.casTmpDir, entry.name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (info) sizes.set(match[1], (sizes.get(match[1]) ?? 0) + info.size);
      }
    const digests = [...sizes.keys()].sort();
    return {
      total: digests.length,
      bytes: [...sizes.values()]
        .reduce((sum, size) => sum + BigInt(size), 0n)
        .toString(),
      list: digests
        .slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? 50))
        .map((digest) => ({
          digest,
          bytes: String(sizes.get(digest)),
          status: 'temporary',
          users: [],
          userCount: 0,
        })),
    };
  }

  async cleanTemporary(digest: string) {
    await this.scheduler.waitForDigest(digest);
    if (this.scheduler.hasDigest(digest)) return { cleaned: false };
    return this.upload.withCasDigestLock(digest, async () =>
      this.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`LOCK TABLE "FileSyncProgress" IN SHARE ROW EXCLUSIVE MODE`,
        );
        const refs = await tx.execute(
          sql`SELECT 1 FROM "FileSyncProgress" WHERE digest = ${digest} LIMIT 1`,
        );
        if (refs.rows.length > 0) return { cleaned: false };
        await this.upload.removeCasTemporary(digest);
        return { cleaned: true };
      }),
    );
  }
}
