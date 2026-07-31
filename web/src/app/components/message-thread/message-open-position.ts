import type { CbInitOpts } from '../../lib/chat-box/chat-box-scroller';
import type { ChatOpenPosition } from '../../services/chat-appearance.service';

export function messageOpenOptions(
  position: ChatOpenPosition,
  firstUnreadSeq: number | null,
): CbInitOpts | undefined {
  if (position !== 'last-read' || firstUnreadSeq === null) return undefined;
  return {
    startMsgId: firstUnreadSeq,
    anchor: 'top',
    fallbackToLatest: true,
  };
}
