import { federationLabNodes } from '../topology.mjs';
import {
  authorIdentity,
  permitsAbsentWithdrawal,
} from './message-evidence.mjs';

function author(message) {
  return `${message.creatorAccount}@${message.creatorDomain}`;
}

function identity(node, message, messages, groupAddress) {
  const value = authorIdentity(node, message, messages, groupAddress);
  return JSON.stringify([value.actor, value.seq]);
}

// The source set is assembled from each CURRENT member's home database, not from the group origin.
export function compareCurrentMemberMessages({
  groupAddress,
  members,
  messages,
  nodeNames,
  signature,
}) {
  const failures = [];
  const source = new Map();
  const memberSet = new Set(members);
  const groupAuthority = groupAddress.startsWith('!')
    ? federationLabNodes.find(({ domain }) =>
        groupAddress.endsWith(`@${domain}`),
      )
    : null;
  const fail = (kind, node, details = {}) =>
    failures.push({ kind, group: groupAddress, node, ...details });
  for (const member of members) {
    const node = federationLabNodes.find(({ domain }) =>
      member.endsWith(`@${domain}`),
    );
    const thread = messages[node.name].get(groupAddress);
    if (!thread) {
      fail('AUTHOR_THREAD_MISSING', node.name, { member });
      continue;
    }
    for (const message of thread.messages) {
      if (message.contentType === 'SYSTEM' || author(message) !== member)
        continue;
      const key = identity(node, message, messages, groupAddress);
      if (source.has(key))
        fail('AUTHOR_MESSAGE_DUPLICATE', node.name, {
          member,
          originSeq: message.originSeq,
        });
      // A P2P processing receipt confirms the counterpart's local timeline,
      // not the author's own sequence. Same-server P2P still shares one timeline.
      const counterpart =
        !groupAuthority &&
        federationLabNodes.find(
          (peer) =>
            peer.name !== node.name &&
            groupAddress
              .split('|')
              .some((address) => address.endsWith(`@${peer.domain}`)),
        );
      const authority = groupAuthority ?? counterpart ?? node;
      const authorityCopy =
        authority?.name === node.name
          ? message
          : messages[authority?.name]
              ?.get(groupAddress)
              ?.messages.find(
                (row) =>
                  author(row) === member && row.originSeq === message.seq,
              );
      // Withdrawal can precede confirmation; a deleted submission is no longer returned by the feed.
      const unconfirmedWithdrawal =
        message.isDeleted &&
        message.originSeq === message.seq &&
        message.sourceDomain == null;
      const absentP2pWithdrawal =
        !groupAuthority &&
        !authorityCopy &&
        counterpart &&
        messages[counterpart.name]?.get(groupAddress) &&
        permitsAbsentWithdrawal({
          nodeName: counterpart.name,
          thread: messages[counterpart.name]?.get(groupAddress),
          messages,
          key: groupAddress,
          actor: member,
          authorSeq: message.seq,
        });
      if (
        !unconfirmedWithdrawal &&
        !absentP2pWithdrawal &&
        (!authorityCopy || message.originSeq !== authorityCopy.seq)
      )
        fail('AUTHOR_ORIGIN_SEQ', node.name, {
          member,
          seq: message.seq,
          originSeq: message.originSeq,
          expectedOriginSeq: authorityCopy?.seq ?? null,
        });
      source.set(key, { node, thread, message });
    }
  }
  const counts = {};
  for (const nodeName of nodeNames) {
    const node = federationLabNodes.find(({ name }) => name === nodeName);
    const thread = messages[nodeName].get(groupAddress);
    if (!thread) {
      fail('MESSAGE_THREAD_MISSING', nodeName);
      continue;
    }
    const selected = thread.messages.filter(
      (message) =>
        message.contentType !== 'SYSTEM' &&
        memberSet.has(
          authorIdentity(node, message, messages, groupAddress).actor,
        ),
    );
    counts[nodeName] = selected.length;
    const seen = new Set();
    const sequenceCounts = new Map();
    for (const { seq } of thread.messages)
      sequenceCounts.set(seq, (sequenceCounts.get(seq) ?? 0) + 1);
    for (const message of selected) {
      const key = identity(node, message, messages, groupAddress);
      if (seen.has(key)) fail('MIRROR_MESSAGE_DUPLICATE', nodeName, { key });
      seen.add(key);
      if (
        !Number.isSafeInteger(message.seq) ||
        message.seq < 1 ||
        message.seq > thread.curSeq ||
        !Number.isSafeInteger(message.originSeq) ||
        message.originSeq < 1 ||
        sequenceCounts.get(message.seq) !== 1
      )
        fail('MESSAGE_COORDINATE', nodeName, {
          key,
          seq: message.seq,
          originSeq: message.originSeq,
        });
      const original = source.get(key);
      if (!original) {
        fail('MESSAGE_NOT_AT_AUTHOR', nodeName, { key });
        continue;
      }
      // Receipts retain the author's local publisher. The authority imports
      // that submission from its author, then publishes it to other mirrors.
      const publisher =
        groupAuthority &&
        nodeName !== original.node.name &&
        nodeName !== groupAuthority.name
          ? groupAuthority.domain
          : original.node.domain;
      if (message.sourceDomain != null && message.sourceDomain !== publisher)
        fail('MESSAGE_SOURCE', nodeName, {
          key,
          expected: publisher,
          actual: message.sourceDomain,
        });
      if (Boolean(message.isDeleted) !== Boolean(original.message.isDeleted))
        fail('AUTHOR_DELETION_MISMATCH', nodeName, { key });
      if (message.isDeleted) {
        if (!thread.deletedSeqs.has(message.seq))
          fail('AUTHOR_TOMBSTONE_MISSING', nodeName, { key });
      } else if (
        message.localState !== 'READY' ||
        original.message.localState !== 'READY' ||
        JSON.stringify(signature(node, message, thread)) !==
          JSON.stringify(
            signature(original.node, original.message, original.thread),
          )
      )
        fail('AUTHOR_MESSAGE_CONTENT', nodeName, { key });
    }
    for (const [key, original] of source)
      if (
        !seen.has(key) &&
        !(
          original.message.isDeleted &&
          permitsAbsentWithdrawal({
            nodeName,
            thread,
            messages,
            key: groupAddress,
            actor: author(original.message),
            authorSeq: original.message.seq,
          })
        )
      )
        fail('AUTHOR_MESSAGE_MISSING', nodeName, { key });
  }
  return {
    failures,
    sourceMessages: source.size,
    nodes: counts,
    members: [...members],
  };
}
