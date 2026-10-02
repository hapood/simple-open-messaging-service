/**
 * Mention-candidate rules shared by the web editor and the native composer (both resolve popups
 * through the host's `memberSearch` lookup, whose search lives in the member profile store).
 */

/**
 * The session's own identity is a roster member like any other, but a self chip must never be
 * offered: the server's mention scan ignores a recipient's own messages, so @-ing yourself can
 * never produce the badge the row appears to promise. The comparison is namespace-aware so a
 * same-named account in a different namespace stays mentionable.
 */
export function isSelfMentionMember(
  self: { account: string; namespaceId: number } | null | undefined,
  member: { account: string; namespaceId: number },
): boolean {
  if (!self) return false;
  return self.account === member.account &&
    self.namespaceId === member.namespaceId;
}
