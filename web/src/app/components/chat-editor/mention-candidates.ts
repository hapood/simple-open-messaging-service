/**
 * Mention-candidate rules shared by the web editor and the native composer (both resolve popups
 * through the host's `memberSearch` lookup, whose search lives in the member profile store).
 */

/**
 * The session's own identity is a roster member like any other, but a self chip must never be
 * offered: the server's mention scan ignores a recipient's own messages, so @-ing yourself can
 * never produce the badge the row appears to promise. Domain-aware on both sides (`local`
 * normalization matching the serialized chip id), so a same-named account on another federation
 * node stays mentionable.
 */
export function isSelfMentionMember(
  self: { account: string; domain?: string | null } | null | undefined,
  member: { account: string; domain?: string | null },
): boolean {
  if (!self) return false;
  return (
    member.account === self.account &&
    (member.domain || 'local') === (self.domain || 'local')
  );
}
