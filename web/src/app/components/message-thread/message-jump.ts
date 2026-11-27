import type { ScrollerApi } from '../../lib/chat-box/chat-box-scroller';

/** Feature navigation adds context reveal and highlighting to message identity. */
export async function jumpToMessage(
  scroller: ScrollerApi | undefined,
  id: number,
  overscroll = 20,
): Promise<boolean | undefined> {
  return scroller?.smoothScrollToMessage(id, overscroll, true);
}
