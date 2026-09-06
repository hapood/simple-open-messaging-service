import { federationLabNodes } from '../topology.mjs';
import { parseContent } from './message-operations.mjs';

export function messageAuthor(node, message) {
  return (
    message.creatorAddress ??
    `${message.creatorAccount}@${message.creatorDomain === 'local' ? node.domain : message.creatorDomain}`
  );
}

// Message identity uses the author's immutable local seq, never a provisional originSeq.
export function authorIdentity(node, message, messages, key) {
  const actor = messageAuthor(node, message);
  let seq = message.originSeq;
  if (actor.endsWith(`@${node.domain}`)) seq = message.seq;
  else if (key?.startsWith('!') && !key.endsWith(`@${node.domain}`)) {
    const authority = federationLabNodes.find(({ domain }) =>
      key.endsWith(`@${domain}`),
    );
    const original = messages?.[authority?.name]
      ?.get(key)
      ?.messages.find(
        (row) =>
          row.seq === message.originSeq &&
          messageAuthor(authority, row) === actor,
      );
    seq = original
      ? actor.endsWith(`@${authority.domain}`)
        ? original.seq
        : original.originSeq
      : null;
  }
  return {
    actor,
    seq,
  };
}

export function quoteIdentity(node, message, thread, messages, key) {
  const content = parseContent(message.content);
  const quote = content?.quote;
  if (!quote) return null;
  const namespaceId =
    quote.namespaceId ??
    (quote.sourceSeq === undefined ? 0 : message.sourceNamespaceId);
  const coordinateSeq =
    quote.namespaceId === undefined
      ? (quote.sourceSeq ?? quote.seq)
      : quote.seq;
  const target = thread.messages.find((row) =>
    namespaceId === 0
      ? row.seq === coordinateSeq
      : row.sourceNamespaceId === namespaceId &&
        row.originSeq === coordinateSeq,
  );
  if (target) return authorIdentity(node, target, messages, key);
  const sourceDomain =
    message.quoteSourceDomain ??
    (namespaceId === message.sourceNamespaceId
      ? message.sourceDomain
      : undefined);
  const publisher = federationLabNodes.find(
    ({ domain }) => domain === sourceDomain,
  );
  const source =
    namespaceId !== 0 &&
    publisher &&
    Number.isSafeInteger(coordinateSeq) &&
    coordinateSeq > 0
      ? messages?.[publisher.name]
          ?.get(key)
          ?.messages.find(({ seq }) => seq === coordinateSeq)
      : null;
  if (source) return authorIdentity(publisher, source, messages, key);
  // Preserve unresolved coordinates; never collapse different missing references.
  return {
    unresolved: true,
    node: node.name,
    seq: quote.seq,
    sourceDomain,
    sourceSeq: namespaceId === 0 ? undefined : coordinateSeq,
  };
}

export function permitsAbsentWithdrawal({
  nodeName,
  thread,
  messages,
  key,
  actor,
  authorSeq,
}) {
  const authorityDomain = key.startsWith('!')
    ? key.slice(key.lastIndexOf('@') + 1)
    : actor.slice(actor.lastIndexOf('@') + 1);
  const authority = federationLabNodes.find(
    ({ domain }) => domain === authorityDomain,
  );
  if (!authority || authority.name === nodeName) return false;
  const authorityThread = messages[authority.name]?.get(key);
  const original = authorityThread?.messages.find((row) => {
    const identity = authorIdentity(authority, row, messages, key);
    return identity.actor === actor && identity.seq === authorSeq;
  });
  const state = thread.syncState;
  return Boolean(
    original?.isDeleted &&
      authorityThread.deletedSeqs.has(original.seq) &&
      state?.historyBoundaryReached === true &&
      state.activeGapId === null &&
      Array.isArray(thread.historyGaps) &&
      thread.historyGaps.length === 0 &&
      state.messageProcessedThroughSeq >= state.messageTargetSeq &&
      state.messageProcessedThroughSeq >= original.seq &&
      state.deletionProcessedThroughSeq >= state.deletionTargetSeq &&
      state.deletionRecoveryThroughSeq == null,
  );
}
