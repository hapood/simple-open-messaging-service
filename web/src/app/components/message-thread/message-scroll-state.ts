import type { CbScrollInfo } from '../../lib/chat-box/chat-box-scroller';

/** UI-level bottom proximity. The kernel's `atBottom` uses a much wider prefetch edge, so it is unsuitable
 * for deciding whether the user can still see the newest messages. */
const MESSAGE_BOTTOM_THRESHOLD_PX = 96;

export function isMessageViewportAtBottom(
  info: Pick<CbScrollInfo, 'scrollTop' | 'scrollHeight' | 'viewportHeight'>,
): boolean {
  return info.scrollHeight - info.scrollTop - info.viewportHeight <= MESSAGE_BOTTOM_THRESHOLD_PX;
}
