/**
 * Message grouping predicates (pure functions, no DOM/framework dependencies).
 *
 * Industry (WhatsApp)-style grouping: consecutive messages from the same sender are grouped (time windows are
 * no longer used — time gaps are broken by date separator rows instead). The group head shows avatar + name,
 * items inside a group hug the previous item, and each item still shows its own timestamp. Avatar visibility
 * directly determines a single item's rendered height, which is the foundation of virtual scrolling
 * (especially scrollTo(id) jump height calculations).
 *
 * Extracted from MsgGroupFactory._buildDispDict, functionalized for unified reuse by playground mock data and
 * the real message list.
 */

export interface GroupCtx {
  /** Sender identifier (user id). */
  creator: number | string;
}

export interface GroupFlags {
  /** Group head: show avatar + name (no prev / sender change → starts a new group). */
  isShowHead: boolean;
  /** In-group merge: hug the previous item (has next and same sender → each item still shows its own timestamp). */
  isDateShrink: boolean;
}

/**
 * Classify the group flags of a single message (consecutive grouping by sender, WhatsApp-style).
 *
 * @param prev Previous item (basis for group-head detection); pass null for the list's first item / right after a date separator.
 * @param cur  Current item.
 * @param next Next item (basis for in-group-merge detection); pass null for the list's last item.
 */
export function classifyGroupFlags(
  prev: GroupCtx | null,
  cur: GroupCtx,
  next: GroupCtx | null,
): GroupFlags {
  // Group head: no prev / sender change → starts a new group, shows avatar + name.
  const isShowHead = !prev || prev.creator !== cur.creator;
  // In-group merge: has next and same sender → hug the previous item (each item still shows its own timestamp).
  const isDateShrink = !!next && next.creator === cur.creator;
  return { isShowHead, isDateShrink };
}
