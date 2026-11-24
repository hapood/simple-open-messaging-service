import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { findStoredQuoteTargets } from './stored-quote-targets.js';
import type { Database } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  parseMessageContentQuote,
  storedQuoteCoordinate,
  withMessageContentQuote,
} from '../../shared/message-content-quote.js';

type Message = typeof tables.message.$inferSelect;

/** Resolve publisher references without rewriting durable content or inventing local coordinates. */
export async function resolveStoredQuotes<T extends Message>(
  db: Pick<Database, 'query'>,
  messages: T[],
): Promise<T[]> {
  const refs = messages.flatMap((m) => {
    const contentQuote = parseMessageContentQuote(m.content);
    if (!contentQuote) return [];
    const coordinate = storedQuoteCoordinate(
      contentQuote,
      m.publisherNamespaceId ?? 0,
    );
    return [
      {
        m: { ...m, publisherNamespaceId: coordinate.namespaceId },
        quote:
          coordinate.namespaceId === 0
            ? { seq: coordinate.seq }
            : { seq: 0, sourceSeq: coordinate.seq },
      },
    ];
  });
  if (!refs.length) return messages;
  const targets = await findStoredQuoteTargets(
    db,
    refs.map(({ m }) => m),
  );
  const threadIds = [...new Set(refs.map((r) => r.m.threadId))];
  const [gaps, states, threads] = await Promise.all([
    db.query.federationThreadHistoryGap.findMany({
      where: inArray(tables.federationThreadHistoryGap.threadId, threadIds),
    }),
    db.query.federationThreadSyncState.findMany({
      where: inArray(tables.federationThreadSyncState.threadId, threadIds),
    }),
    db.query.messageThread.findMany({
      where: inArray(tables.messageThread.id, threadIds),
      columns: { id: true, type: true, authorityNamespaceId: true },
    }),
  ]);
  const reverseKeys = new Map<
    string,
    { threadId: number; namespaceId: number }
  >();
  for (const state of states) {
    const thread = threads.find((t) => t.id === state.threadId);
    const isForward =
      thread?.type === 'GROUP' && thread.authorityNamespaceId === 0;
    if (!isForward && state.namespaceId > 0) {
      reverseKeys.set(`${state.threadId}:${state.namespaceId}`, {
        threadId: state.threadId,
        namespaceId: state.namespaceId,
      });
    }
  }
  const reverseMaxOriginSeq = new Map<string, number>();
  await Promise.all(
    [...reverseKeys.entries()].map(async ([key, pair]) => {
      const row = await db.query.message.findFirst({
        where: and(
          eq(tables.message.threadId, pair.threadId),
          eq(tables.message.publisherNamespaceId, pair.namespaceId),
          isNotNull(tables.message.originSeq),
        ),
        orderBy: [desc(tables.message.originSeq)],
        columns: { originSeq: true },
      });
      reverseMaxOriginSeq.set(key, row?.originSeq ?? 0);
    }),
  );
  const replacements = new Map<bigint, string>();
  for (const { m, quote } of refs) {
    const target = targets.get(m.id);
    const gap = gaps.find(
      (g) =>
        g.threadId === m.threadId &&
        (quote.sourceSeq === undefined
          ? quote.seq >= g.startSeq + g.messageSeqOffset &&
            quote.seq <= g.endSeq + g.messageSeqOffset
          : g.namespaceId === m.publisherNamespaceId &&
            quote.sourceSeq >= g.startSeq &&
            quote.sourceSeq <= g.endSeq),
    );
    const state = states.find(
      (s) =>
        s.threadId === m.threadId && s.namespaceId === m.publisherNamespaceId,
    );
    const thread = threads.find((t) => t.id === m.threadId);
    const isForward =
      thread?.type === 'GROUP' && thread.authorityNamespaceId === 0;
    const scannedThrough = !state
      ? 0
      : isForward
        ? state.messageProcessedThroughSeq
        : (reverseMaxOriginSeq.get(`${state.threadId}:${state.namespaceId}`) ??
          0);
    const pending = target
      ? false
      : gap
        ? gap.recoverable
        : quote.sourceSeq !== undefined &&
          (!state || quote.sourceSeq > scannedThrough);
    replacements.set(
      m.id,
      withMessageContentQuote(m.content, {
        seq: target?.seq ?? (quote.sourceSeq === undefined ? quote.seq : 0),
        ...(parseMessageContentQuote(m.content)?.digest
          ? { digest: parseMessageContentQuote(m.content)!.digest }
          : {}),
        ...(!target && quote.sourceSeq !== undefined
          ? { sourceSeq: quote.sourceSeq }
          : {}),
        ...(pending
          ? { status: 'PENDING' as const }
          : !target || target.isDeleted
            ? { status: 'NOT_FOUND' as const }
            : {}),
      }),
    );
  }
  return messages.map((m) =>
    replacements.has(m.id) ? { ...m, content: replacements.get(m.id)! } : m,
  );
}
