import { inArray } from 'drizzle-orm';
import { findStoredQuoteTargets } from './stored-quote-targets.js';
import type { Database } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  parseTextMessageContent,
  storedQuoteCoordinate,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';

type Message = typeof tables.message.$inferSelect;

/** Resolve publisher references without rewriting durable content or inventing local coordinates. */
export async function resolveStoredQuotes<T extends Message>(
  db: Pick<Database, 'query'>,
  messages: T[],
): Promise<T[]> {
  const refs = messages.flatMap((m) => {
    if (m.contentType !== 'PURE_TEXT') return [];
    const content = parseTextMessageContent(m.content);
    if (!content?.quote) return [];
    const coordinate = storedQuoteCoordinate(
      content.quote,
      m.sourceNamespaceId ?? 0,
    );
    return [
      {
        m: { ...m, sourceNamespaceId: coordinate.namespaceId },
        content,
        quote:
          coordinate.namespaceId === 0
            ? { seq: coordinate.seq }
            : { seq: 0, sourceSeq: coordinate.seq },
      },
    ];
  });
  if (!refs.length) return messages;
  const targets = await findStoredQuoteTargets(db, messages);
  const threadIds = [...new Set(refs.map((r) => r.m.threadId))];
  const [gaps, states] = await Promise.all([
    db.query.federationThreadHistoryGap.findMany({
      where: inArray(tables.federationThreadHistoryGap.threadId, threadIds),
    }),
    db.query.federationThreadSyncState.findMany({
      where: inArray(tables.federationThreadSyncState.threadId, threadIds),
    }),
  ]);
  const replacements = new Map<bigint, string>();
  for (const { m, content, quote } of refs) {
    const target = targets.get(m.id);
    const gap = gaps.find(
      (g) =>
        g.threadId === m.threadId &&
        (quote.sourceSeq === undefined
          ? quote.seq >= g.startSeq + g.messageSeqOffset &&
            quote.seq <= g.endSeq + g.messageSeqOffset
          : g.namespaceId === m.sourceNamespaceId &&
            quote.sourceSeq >= g.startSeq &&
            quote.sourceSeq <= g.endSeq),
    );
    const state = states.find(
      (s) => s.threadId === m.threadId && s.namespaceId === m.sourceNamespaceId,
    );
    const pending = target
      ? false
      : gap
        ? gap.recoverable
        : quote.sourceSeq !== undefined &&
          (!state || quote.sourceSeq > state.messageProcessedThroughSeq);
    replacements.set(
      m.id,
      stringifyTextMessageContent({
        text: content.text,
        quote: {
          seq: target?.seq ?? (quote.sourceSeq === undefined ? quote.seq : 0),
          ...(!target && quote.sourceSeq !== undefined
            ? { sourceSeq: quote.sourceSeq }
            : {}),
          ...(pending
            ? { status: 'PENDING' as const }
            : !target || target.isDeleted
              ? { status: 'NOT_FOUND' as const }
              : {}),
        },
      }),
    );
  }
  return messages.map((m) =>
    replacements.has(m.id) ? { ...m, content: replacements.get(m.id)! } : m,
  );
}
