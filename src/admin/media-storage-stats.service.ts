import { Injectable } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { count, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';
import { UploadService } from '../upload/upload.service.js';

/** Read-only database and filesystem totals. It makes no reclaimability decision. */
@Injectable()
export class MediaStorageStatsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
  ) {}

  async read() {
    const [aggregate] = await this.database.db
      .select({
        bytes: sql<bigint>`coalesce(sum(${mediaAsset.bytes}), 0)::bigint`,
        assetCount: count(),
        live: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = false)::int`,
        deleted: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = true)::int`,
      })
      .from(mediaAsset);

    let files = 0;
    let bytes = 0n;
    try {
      for (const first of await readdir(this.upload.casDir, {
        withFileTypes: true,
      })) {
        if (!first.isDirectory()) continue;
        const firstPath = join(this.upload.casDir, first.name);
        for (const second of await readdir(firstPath, {
          withFileTypes: true,
        })) {
          if (!second.isDirectory()) continue;
          const secondPath = join(firstPath, second.name);
          for (const name of await readdir(secondPath)) {
            if (!/^[0-9a-f]{64}$/.test(name)) continue;
            const file = await stat(join(secondPath, name)).catch(() => null);
            if (!file?.isFile()) continue;
            files += 1;
            bytes += BigInt(file.size);
          }
        }
      }
    } catch {
      // A missing CAS directory is an empty store.
    }

    return {
      db: {
        bytes: BigInt(aggregate.bytes),
        assetCount: aggregate.assetCount,
        live: aggregate.live,
        deleted: aggregate.deleted,
      },
      onDisk: { files, bytes },
    };
  }
}
