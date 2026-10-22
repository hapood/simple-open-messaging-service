import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ContentType } from '../database/enums.js';
import { DatabaseService } from '../database/database.service.js';
import { forwardMessage, messageAsset } from '../database/schema.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';

/** Object-level authorization for the single contextual CAS URL shape. */
@Injectable()
export class MediaAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly visibility: MessageVisibilityService,
  ) {}

  async canReadMessageAsset(
    userId: number,
    threadId: number,
    seq: number,
    digest: string,
  ): Promise<boolean> {
    const visible = await this.visibility.findVisibleByThreadSeq(
      userId,
      threadId,
      seq,
    );
    if (!visible) return false;

    if (
      visible.contentType === ContentType.IMAGE ||
      visible.contentType === ContentType.FILE ||
      visible.contentType === ContentType.VIDEO ||
      visible.contentType === ContentType.AUDIO ||
      visible.contentType === ContentType.LINK ||
      visible.contentType === ContentType.GALLERY
    ) {
      const direct = await this.database.db.query.messageAsset.findFirst({
        where: and(
          eq(messageAsset.messageId, visible.id),
          eq(messageAsset.digest, digest),
        ),
        columns: { messageId: true },
      });
      return Boolean(direct);
    }
    if (visible.contentType !== ContentType.FORWARD) return false;

    const root = await this.database.db.query.forwardMessage.findFirst({
      where: eq(forwardMessage.messageId, visible.id),
      columns: { bundleId: true },
    });
    if (!root) return false;
    const result = await this.database.db.execute(sql<{ allowed: boolean }>`
      WITH RECURSIVE bundle_closure("bundleId") AS (
        SELECT ${root.bundleId}::bigint
        UNION
        SELECT dependency."childBundleId"
        FROM bundle_closure closure
        JOIN "ForwardBundleDependency" dependency
          ON dependency."parentBundleId" = closure."bundleId"
      )
      SELECT EXISTS (
        SELECT 1
        FROM bundle_closure closure
        JOIN "ForwardBundleAsset" asset
          ON asset."bundleId" = closure."bundleId"
        JOIN "MediaAsset" media
          ON media.digest = asset.digest
         AND media."isDeleted" = false
        WHERE asset.digest = ${digest}
      ) AS allowed
    `);
    return Boolean(result.rows[0]?.allowed);
  }
}
