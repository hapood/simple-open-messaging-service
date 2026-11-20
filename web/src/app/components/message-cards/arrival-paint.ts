import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from './chat-item';

/** Paint only newly delivered self content; the kernel has already chosen bottom following. */
export function paintPinnedArrival(
  item: CbItem<ChatItemData>,
  host: HTMLElement,
  newSeqs: readonly number[],
): void {
  if (item.data.type !== 'msg' || !item.data.isSelf ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const members = new Set(newSeqs.map(String));
  const cells = Array.from(host.querySelectorAll<HTMLElement>('[data-media-message-id]'));
  const targets = cells.length
    ? cells.filter((cell) => members.has(cell.dataset['mediaMessageId'] ?? ''))
    : [host.querySelector<HTMLElement>('.msg-bubble') ?? host];
  for (const target of targets) {
    target.animate(
      [{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 180, easing: 'ease-out' },
    );
  }
}
