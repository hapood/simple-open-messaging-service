import type { ScrollerApi } from '../../lib/chat-box/chat-box-scroller';

export type MessageJumpAnchor = 'top' | 'center' | 'bottom';

/** Feature-level jump entry point; keeps highlight policy out of the thread component. */
export async function jumpToMessage(
  scroller: ScrollerApi | undefined,
  id: number,
  anchor: MessageJumpAnchor = 'center',
): Promise<boolean | undefined> {
  return scroller?.scrollToIndex(id, anchor, true);
}
