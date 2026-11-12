import type { ConversationItem } from './model';

/** Pins use last-set time; ordinary page rows use the account feed's update order. */
export function compareThreadItems(
  left: ConversationItem,
  right: ConversationItem,
): number {
  const leftVisible = left.visible !== false;
  const rightVisible = right.visible !== false;
  if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
  if (!leftVisible) return 0;
  return (
    Number(right.pinned) - Number(left.pinned) ||
    (left.pinned
      ? (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) ||
        right.threadId - left.threadId
      : right.threadFeedId! - left.threadFeedId!)
  );
}

/** Apply one committed page without sorting the existing list.
 * Ordinary rows are sorted within the page and prepended as a batch. Pins are
 * inserted individually by last-set time, independent of feed update order.
 * Remove replaced IDs from both sections first so pin transitions cannot duplicate rows.
 * Hidden structural rows are retained outside the two display sections.
 */
export function mergeThreadItems(
  items: ConversationItem[],
  updates: ConversationItem[],
): ConversationItem[] {
  const pending = new Map(updates.map((item) => [item.threadId, item]));
  const pins: ConversationItem[] = [];
  const ordinary: ConversationItem[] = [];
  const hidden: ConversationItem[] = [];
  const incomingOrdinary: ConversationItem[] = [];
  for (const item of items) {
    const replacement = pending.get(item.threadId);
    if (replacement) {
      if (
        item.visible !== false &&
        item.pinned &&
        replacement.visible !== false &&
        replacement.pinned &&
        item.pinnedAt === replacement.pinnedAt
      ) {
        // The pin ordering key is unchanged: replace in place, without searching again.
        pins.push(replacement);
        pending.delete(item.threadId);
      }
      continue;
    }
    if (item.visible === false) hidden.push(item);
    else if (item.pinned) pins.push(item);
    else ordinary.push(item);
  }
  for (const item of pending.values()) {
    if (item.visible === false) {
      hidden.push(item);
    } else if (!item.pinned) {
      incomingOrdinary.push(item);
    } else {
      // Most changed pins are newly set and belong at the head, so search head-first.
      let index = 0;
      while (index < pins.length && compareThreadItems(pins[index], item) <= 0)
        index++;
      pins.splice(index, 0, item);
    }
  }
  if (incomingOrdinary.length > 1) incomingOrdinary.sort(compareThreadItems);
  const result = [...pins, ...incomingOrdinary, ...ordinary, ...hidden];
  const feedIds = new Set<number>();
  for (const item of result) {
    if (item.visible === false) continue;
    if (!Number.isSafeInteger(item.threadFeedId) || item.threadFeedId! < 1)
      throw new Error(`Visible thread ${item.threadId} has no threadFeedId`);
    if (feedIds.has(item.threadFeedId!))
      throw new Error(`Duplicate threadFeedId ${item.threadFeedId}`);
    feedIds.add(item.threadFeedId!);
  }
  return result;
}
