import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import {
  fileSyncProgress,
  mediaAsset,
  message,
  messageAsset,
} from '../database/schema.js';
import { dataDirectory } from '../common/data-directory.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { extractDigestFileRefs } from '../upload/file-content.js';

/** Message-owned fallback when a digest has no live physical download. */
@Injectable()
export class MediaProgressService {
  constructor(private readonly database: DatabaseService) {}

  async snapshot(threadId: number, seq: number, digest: string) {
    const [row] = await this.database.db
      .select({
        content: message.content,
        taskId: fileSyncProgress.id,
        taskStatus: fileSyncProgress.status,
        received: fileSyncProgress.bytesReceived,
        total: fileSyncProgress.bytesTotal,
        assetOwner: messageAsset.messageId,
        assetBytes: mediaAsset.bytes,
        assetDeleted: mediaAsset.isDeleted,
      })
      .from(message)
      .leftJoin(
        fileSyncProgress,
        and(
          eq(fileSyncProgress.messageId, message.id),
          eq(fileSyncProgress.digest, digest),
        ),
      )
      .leftJoin(
        messageAsset,
        and(
          eq(messageAsset.messageId, message.id),
          eq(messageAsset.digest, digest),
        ),
      )
      .leftJoin(mediaAsset, eq(mediaAsset.digest, messageAsset.digest))
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.seq, seq),
          eq(message.isDeleted, false),
        ),
      )
      .limit(1);
    if (!row || (row.taskId === null && row.assetOwner === null))
      throw new BusinessException(BusinessCode.NOT_FOUND, 'media not found');
    let ready = false;
    if (row.assetBytes !== null && row.assetDeleted === false) {
      const file = await lstat(
        join(
          dataDirectory('cas'),
          digest.slice(0, 2),
          digest.slice(2, 4),
          digest,
        ),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      ready =
        file !== null && file.isFile() && BigInt(file.size) === row.assetBytes;
    }
    const status = ready
      ? 'ready'
      : row.taskStatus === 'PENDING' ||
          (row.taskStatus === 'COMPLETED' && row.assetOwner === null)
        ? 'pending'
        : 'failed';
    return {
      threadId,
      seq,
      file: extractDigestFileRefs(row.content).find(
        (file) => file.digest === digest,
      ) ?? { digest, name: '' },
      status,
      loaded: Number(ready ? row.assetBytes : (row.received ?? 0n)),
      total:
        row.assetBytes !== null
          ? Number(row.assetBytes)
          : row.total !== null
            ? Number(row.total)
            : null,
    };
  }
}
