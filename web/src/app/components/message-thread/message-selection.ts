import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';

export type MessageSelectionState = 'none' | 'some' | 'all';

export function messageMemberIds(item: CbItem<ChatItemData>): number[] {
  return (item.ids?.length ?? 0) > 1 ? [...item.ids!] : [item.id];
}

export function messageSelectionState(
  item: CbItem<ChatItemData>,
  selected: ReadonlySet<number>,
): MessageSelectionState {
  const ids = messageMemberIds(item);
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
}

export function albumMemberItem(
  item: CbItem<ChatItemData>,
  memberId: number,
): CbItem<ChatItemData> {
  if ((item.ids?.length ?? 0) < 2) return item;
  const media = item.data.images?.find((entry) => entry.msgId === memberId);
  return {
    ...item,
    id: memberId,
    ids: undefined,
    data: {
      ...item.data,
      msgId: memberId,
      images: media ? [media] : item.data.images,
    },
  };
}

/** Single writer for selection/context classes on a mounted virtual-row host. */
export function applyMessageSelectionState(
  host: HTMLElement,
  memberIds: readonly number[],
  active: boolean,
  selected: ReadonlySet<number>,
  contextId?: number,
): void {
  const selectedMembers = memberIds.filter((id) => selected.has(id)).length;
  const state: MessageSelectionState =
    selectedMembers === 0
      ? 'none'
      : selectedMembers === memberIds.length
        ? 'all'
        : 'some';
  host.classList.toggle('cb-message--selection-mode', active);
  host.classList.toggle('cb-message--selected', active && state === 'all');
  host.classList.toggle(
    'cb-message--partially-selected',
    active && state === 'some',
  );
  const hasContext = contextId !== undefined && memberIds.includes(contextId);
  host.classList.toggle(
    'cb-message--context-active',
    hasContext && memberIds.length === 1,
  );
  host.setAttribute('aria-selected', String(active && state === 'all'));
  host
    .querySelectorAll<HTMLElement>('[data-media-message-id]')
    .forEach((cell) => {
      const memberId = Number(cell.dataset['mediaMessageId']);
      cell.classList.toggle(
        'msg-media-cell--selected',
        active && selected.has(memberId),
      );
      cell.classList.toggle(
        'msg-media-cell--context-active',
        hasContext && memberId === contextId,
      );
    });
}
