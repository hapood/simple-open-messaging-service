import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../database/database.service.js';
import * as tables from '../../database/schema.js';
import type { Message } from '../../message/message.service.js';
import { extractDigestEntries } from '../../upload/file-content.js';
import { federationFileSyncKind } from '../federation-inbound-file-sync.js';
import type { MessageMediaRoute } from './media-download-context.js';

/** Rebuild execution state from the retained message, preserving verified partials and completed files. */
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
    if (pending && pending.status !== 'failed') return null;
    const batchId = pending?.batchId ?? randomUUID();
    const values = {
      status: 'pending',
      failReason: null,
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
      const existing = await tx.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.digest, digest),
        ),
      });
      if (existing?.status === 'SUCCEEDED') continue;
      const file = {
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
