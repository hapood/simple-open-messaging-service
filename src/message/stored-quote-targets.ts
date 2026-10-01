import { and, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  parseTextMessageContent,
  storedQuoteCoordinate,
} from '../../shared/text-message-content.js';

type Message = typeof tables.message.$inferSelect;
type QuoteMessage = Pick<
  Message,
  'id' | 'threadId' | 'contentType' | 'content' | 'publisherNamespaceId'
>;

/** Resolve scoped coordinates for republication, including deleted targets and receipt aliases. */
export async function findStoredQuoteTargets(
  db: Pick<Database, 'query'>,
  messages: QuoteMessage[],
): Promise<Map<bigint, Message>> {
  const refs = messages.flatMap((m) => {
    const quote =
      m.contentType === 'PURE_TEXT'
        ? parseTextMessageContent(m.content)?.quote
        : undefined;
    if (!quote) return [];
    const c = storedQuoteCoordinate(quote, m.publisherNamespaceId);
    return c.seq > 0 ? [{ m, c }] : [];
  });
  const result = new Map<bigint, Message>();
  if (!refs.length) return result;
  const targets = await db.query.message.findMany({
    where: or(
      ...refs.map(({ m, c }) =>
        and(
          eq(tables.message.threadId, m.threadId),
          c.namespaceId === 0
            ? eq(tables.message.seq, c.seq)
            : and(
                eq(tables.message.publisherNamespaceId, c.namespaceId),
                eq(tables.message.originSeq, c.seq),
              ),
        ),
      ),
    ),
  });
  for (const { m, c } of refs) {
    const target = targets.find(
      (t) =>
        t.threadId === m.threadId &&
        (c.namespaceId === 0
          ? t.seq === c.seq
          : t.publisherNamespaceId === c.namespaceId && t.originSeq === c.seq),
    );
    if (target) result.set(m.id, target);
  }
  const missing = refs.filter(
    ({ m, c }) => c.namespaceId > 0 && !result.has(m.id),
  );
  if (!missing.length) return result;
  const receipts = await db.query.federationMessageReceipt.findMany({
    where: or(
      ...missing.map(({ m, c }) =>
        and(
          eq(tables.federationMessageReceipt.threadId, m.threadId),
          eq(tables.federationMessageReceipt.namespaceId, c.namespaceId),
          eq(tables.federationMessageReceipt.peerSeq, c.seq),
        ),
      ),
    ),
  });
  if (!receipts.length) return result;
  const originals = await db.query.message.findMany({
    where: inArray(
      tables.message.id,
      receipts.map((r) => r.messageId),
    ),
  });
  for (const { m, c } of missing) {
    const receipt = receipts.find(
      (r) =>
        r.threadId === m.threadId &&
        r.namespaceId === c.namespaceId &&
        r.peerSeq === c.seq,
    );
    const target = originals.find(
      (t) => t.id === receipt?.messageId && t.threadId === m.threadId,
    );
    if (target) result.set(m.id, target);
  }
  return result;
}
