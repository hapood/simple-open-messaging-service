import type { ChatMember } from './chat-editor.component';

/**
 * Match the text typed after `@`. Display-name prefix is the primary rule (`@张` → every `张…`
 * member); canonical-account prefix is a secondary route for federated/handle-oriented lookup.
 * There is deliberately no result cap: the popup scrolls, and "all matching users" is the contract.
 */
export function filterMentionCandidates(
  members: readonly ChatMember[],
  query: string,
): ChatMember[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...members];
  return members.filter(
    (member) =>
      member.label.toLocaleLowerCase().startsWith(normalized) ||
      member.id.toLocaleLowerCase().startsWith(normalized),
  );
}
