import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/business/locks/thread-content-lock.js';
import {
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { applyReadPositionInTx } from './business/thread-read-position.service.js';
import { enqueueMessageFanoutsInTx } from './thread-fanout-task.js';
import { threadPreviewLimit } from './thread-preview-limit.js';
import type { MessageDeleteType } from '../database/enums.js';

/** Database-backed preview references and source message publication. */
@Injectable()
export class ThreadPreviewService {
  readonly limit = threadPreviewLimit();
  constructor(private readonly database: DatabaseService) {}

  /** Activation starts empty at the current read boundary, in the owning transaction. */
  async initializeReadWindowsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    targets: readonly AccountTarget[],
    threadLock?: ThreadContentLock,
  ): Promise<void> {
    const lock = await requireThreadContentLockInTx(tx, threadId, threadLock);
    if (targets.length === 0) return;
    const accounts = await localAccountsForTargetsInTx(tx, targets);
    if (accounts.length === 0) return;
    const owners = await tx.execute<{
      accountId: number;
      lastReadSeq: number;
    }>(sql`
      SELECT a.id AS "accountId",
        LEAST(t."curSeq", COALESCE(s."messageVisibleThroughSeq", t."curSeq"))::integer AS "lastReadSeq"
      FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
      JOIN "MessageThread" t ON t.id = s."threadId"
      WHERE t.id = ${threadId} AND a.id IN (${sql.join(
        accounts.map((a) => sql`${a.id}`),
        sql`, `,
      )})
        AND a.domain = 'local' AND a."namespaceId" = 0 AND a.availability = 'AVAILABLE'
      ORDER BY a.id`);
    for (const owner of owners.rows) {
      await applyReadPositionInTx(tx, lock, owner.accountId, {
        threadId,
        localReadHwm: owner.lastReadSeq,
      });
      await tx.execute(sql`UPDATE "AccountThreadState" SET "previewSeqs" = '{}'
        WHERE "accountId" = ${owner.accountId} AND "threadId" = ${threadId} AND "previewSeqs" <> '{}'::integer[]`);
    }
  }

  /** Read exactly the stored slots in the caller's snapshot; never refill history here. */
  async readInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
    take: number,
  ) {
    const result = await tx.execute<{
      seq: number;
      createdAt: string;
      creatorAccount: string | null;
      creatorDomain: string | null;
      isDeleted: boolean;
      deletionType: MessageDeleteType | null;
      contentType: string | null;
      content: string | null;
    }>(sql`
      SELECT m.seq, m."createdAt"::text AS "createdAt", m."creatorAccount", m."creatorDomain",
        m."isDeleted", d.type AS "deletionType",
        CASE WHEN m."isDeleted" THEN NULL ELSE m."contentType" END AS "contentType",
        CASE WHEN m."isDeleted" THEN NULL ELSE m.content::text END AS content
      FROM "AccountThreadState" s
      JOIN "Message" m ON m."threadId" = s."threadId" AND m.seq = ANY(s."previewSeqs"[1:${take}])
      LEFT JOIN "DeletedMessage" d ON d."threadId" = m."threadId" AND d."messageSeq" = m.seq
      WHERE s."accountId" = ${accountId} AND s."threadId" = ${threadId} AND NOT s.blocked
      ORDER BY m.seq ASC`);
    for (const row of result.rows) {
      if (row.isDeleted && row.deletionType === null)
        throw new Error('Deleted preview message has no deletion fact');
    }
    return result.rows;
  }

  /** Commit one message and both independently coalescible fanout tasks atomically. */
  async commitMessage<T extends { seq: number; threadId: number } | null>(
    threadId: number,
    write: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, threadId);
      const result = await write(tx);
      if (result === null) return result;
      if (result.threadId !== threadId)
        throw new Error('Message thread mismatch');
      const heads = await tx.execute<{
        curSeq: number;
        tombstoneEndSeq: number;
      }>(sql`
        SELECT "curSeq", "tombstoneEndSeq" FROM "MessageThread" WHERE id = ${threadId}`);
      const head = heads.rows[0];
      if (!head) throw new Error('Message thread disappeared');
      await enqueueMessageFanoutsInTx(tx, lock, {
        threadId,
        messageEndSeq: head.curSeq,
        tombstoneEndSeq: head.tombstoneEndSeq,
      });
      return result;
    });
  }
}
