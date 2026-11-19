import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../database/database.service.js';
import * as tables from '../../database/schema.js';
import type { Message } from '../../message/message.service.js';
import { extractDigestEntries } from '../../upload/file-content.js';
import { federationFileSyncKind } from '../federation-inbound-file-sync.js';
import type { MessageMediaRoute } from './media-download-context.js';

/** Rebuild execution state from the retained message, preserving checkpointed partials and completed files. */
export async function restageInboundMedia(
  database: DatabaseService,
  msg: Message,
  route: MessageMediaRoute,
) {
  const digests = extractDigestEntries(msg.content);
  if (!digests.length) return null;
  if (msg.publisherNamespaceId === 0 || msg.originSeq === null)
    throw new Error('failed inbound message has no federation source');
  return database.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        localState: tables.message.localState,
        isDeleted: tables.message.isDeleted,
        authorizationEpoch: tables.messageThread.authorizationEpoch,
      })
      .from(tables.message)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .where(eq(tables.message.id, msg.id))
      .for('no key update', { of: tables.message })
      .limit(1);
    if (!locked || locked.localState !== 'FAILED' || locked.isDeleted)
      return null;
    const pending = await tx.query.pendingMedia.findFirst({
      where: and(
        eq(tables.pendingMedia.messageId, msg.id),
        eq(tables.pendingMedia.direction, 'INBOUND'),
      ),
    });
    const tasks = await tx.query.fileSyncProgress.findMany({
      where: eq(tables.fileSyncProgress.messageId, msg.id),
    });
    const batchIds = new Set(tasks.map((task) => task.batchId));
    if (
      batchIds.size > 1 ||
      (pending && tasks.some((task) => task.batchId !== pending.batchId))
    )
      throw new Error(
        'inbound message has inconsistent download task ownership',
      );
    const batchId = pending?.batchId ?? tasks[0]?.batchId ?? randomUUID();
    const values = {
      fileCnt: digests.length,
      originDomain: route.peerDomain,
      publisherNamespaceId: msg.publisherNamespaceId,
      expectedAuthorizationEpoch: locked.authorizationEpoch,
      updatedAt: new Date(),
    };
    if (pending) {
      await tx
        .update(tables.pendingMedia)
        .set(values)
        .where(eq(tables.pendingMedia.id, pending.id));
    } else {
      await tx.insert(tables.pendingMedia).values({
        ...values,
        batchId,
        messageId: msg.id,
        direction: 'INBOUND',
      });
    }
    for (const { digest, size } of digests) {
      const existing = tasks.find((task) => task.digest === digest);
      if (existing?.status === 'COMPLETED') continue;
      const file = {
        messageId: msg.id,
        status: 'PENDING' as const,
        bytesTotal: BigInt(size ?? 0),
        originDomain: route.peerDomain,
        publisherNamespaceId: msg.publisherNamespaceId,
        payload: {
          fromAccount: route.fromAccount,
          fromDomain: route.fromDomain,
          toAccount: route.toAccount,
        },
        errorKind: null,
        updatedAt: new Date(),
      };
      if (existing) {
        await tx
          .update(tables.fileSyncProgress)
          .set(file)
          .where(eq(tables.fileSyncProgress.id, existing.id));
      } else {
        await tx.insert(tables.fileSyncProgress).values({
          ...file,
          batchId,
          digest,
          kind: federationFileSyncKind(msg.contentType),
        });
      }
    }
    await tx
      .update(tables.message)
      .set({ localState: 'STUB', updatedAt: new Date() })
      .where(eq(tables.message.id, msg.id));
    return { batchId, resetFiles: digests.length };
  });
}
