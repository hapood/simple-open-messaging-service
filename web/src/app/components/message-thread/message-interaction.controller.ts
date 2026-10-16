import { computed, signal } from '@angular/core';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  ChatItemData,
  ChatMsgData,
} from '../message-cards/chat-item';
import { isConfirmedMessage } from '../message-cards/chat-item';
import { albumMemberItem, messageMemberIds } from './message-selection';
import { positionMessageContextMenu } from './message-context-menu-position';

const CONTEXT_MENU_WIDTH = 192;
const CONTEXT_MENU_ITEM_HEIGHT = 40;
const CONTEXT_MENU_CHROME_HEIGHT = 14;
const CONTEXT_MENU_INSET = 8;

export interface MessageContextMenu {
  sourceItem: CbItem<ChatMsgData>;
  targetItem: CbItem<ChatMsgData>;
  targetSeq: number;
  memberId?: number;
  x: number;
  y: number;
}

export interface MessageContextBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Owns the interaction state machine for message selection, context menus and
 * quote composition. Rendering and side effects stay with the thread component.
 */
function canSelectMessage(message: ChatMsgData): boolean {
  return isConfirmedMessage(message) && message.type === 'msg';
}

export class MessageInteractionController {
  readonly selectionMode = signal(false);
  readonly selectedMessageIds = signal<ReadonlySet<number>>(new Set());
  readonly selectedCount = computed(() => this.selectedMessageIds().size);
  readonly contextMenu = signal<MessageContextMenu | null>(null);
  readonly composingQuote = signal<ChatMsgData['quote'] | null>(null);

  private readonly selectedMessageItems = new Map<
    number,
    CbItem<ChatMsgData>
  >();

  openContextMenu(
    item: CbItem<ChatItemData>,
    memberId: number | undefined,
    pointer: { x: number; y: number } | undefined,
    bounds: MessageContextBounds,
    menuItemCount: number,
  ): void {
    if (item.data.serverGap) return;
    const sourceItem = item as CbItem<ChatMsgData>;
    const targetItem = this.targetItem(sourceItem, memberId);
    const position = positionMessageContextMenu(
      pointer ?? { x: bounds.left, y: bounds.top },
      bounds,
      {
        width: CONTEXT_MENU_WIDTH,
        height:
          menuItemCount * CONTEXT_MENU_ITEM_HEIGHT + CONTEXT_MENU_CHROME_HEIGHT,
      },
      CONTEXT_MENU_INSET,
    );
    this.contextMenu.set({
      sourceItem,
      targetItem,
      targetSeq: targetItem.id,
      memberId,
      x: position.x,
      y: position.y,
    });
  }

  targetItem(
    item: CbItem<ChatMsgData>,
    memberId?: number,
  ): CbItem<ChatMsgData> {
    return memberId === undefined
      ? item
      : (albumMemberItem(item, memberId) as CbItem<ChatMsgData>);
  }

  closeContextMenu(): boolean {
    if (!this.contextMenu()) return false;
    this.contextMenu.set(null);
    return true;
  }

  selectContextMessage(): boolean {
    const context = this.contextMenu();
    if (!context || !canSelectMessage(context.targetItem.data)) return false;
    const next = new Set(this.selectedMessageIds());
    next.add(context.targetSeq);
    this.selectedMessageItems.set(context.targetSeq, context.targetItem);
    this.selectedMessageIds.set(next);
    this.selectionMode.set(true);
    this.contextMenu.set(null);
    return true;
  }

  toggle(item: CbItem<ChatItemData>, memberId?: number): void {
    if (item.data.serverGap) return;
    const messageItem = item as CbItem<ChatMsgData>;
    if (!canSelectMessage(messageItem.data)) return;
    this.closeContextMenu();
    this.selectionMode.set(true);
    if (memberId === undefined) this.toggleMessage(messageItem);
    else this.toggleAlbumMember(messageItem, memberId);
  }

  selectedItems(): CbItem<ChatMsgData>[] {
    return [...this.selectedMessageIds()]
      .map((id) => this.selectedMessageItems.get(id))
      .filter((item): item is CbItem<ChatMsgData> => item !== undefined);
  }

  setQuote(quote: ChatMsgData['quote']): void {
    this.composingQuote.set(quote);
    this.closeContextMenu();
  }

  cancelQuote(): void {
    this.composingQuote.set(null);
  }

  consumeQuote(): ChatMsgData['quote'] | null {
    const quote = this.composingQuote();
    this.composingQuote.set(null);
    return quote;
  }

  removeMessage(seq: number): void {
    if (this.contextMenu()?.targetSeq === seq) this.contextMenu.set(null);
    this.selectedMessageItems.delete(seq);
    this.selectedMessageIds.update((selected) => {
      if (!selected.has(seq)) return selected;
      const next = new Set(selected);
      next.delete(seq);
      return next;
    });
  }

  resetSelection(): void {
    this.selectionMode.set(false);
    this.selectedMessageIds.set(new Set());
    this.selectedMessageItems.clear();
  }

  reset(): void {
    this.closeContextMenu();
    this.cancelQuote();
    this.resetSelection();
  }

  private toggleMessage(item: CbItem<ChatMsgData>): void {
    const memberIds = messageMemberIds(item);
    const next = new Set(this.selectedMessageIds());
    const remove = memberIds.every((id) => next.has(id));
    for (const id of memberIds) {
      if (remove) {
        next.delete(id);
        this.selectedMessageItems.delete(id);
      } else {
        next.add(id);
        this.selectedMessageItems.set(
          id,
          albumMemberItem(item, id) as CbItem<ChatMsgData>,
        );
      }
    }
    this.selectedMessageIds.set(next);
  }

  private toggleAlbumMember(item: CbItem<ChatMsgData>, memberId: number): void {
    if (!messageMemberIds(item).includes(memberId)) return;
    const next = new Set(this.selectedMessageIds());
    if (next.has(memberId)) {
      next.delete(memberId);
      this.selectedMessageItems.delete(memberId);
    } else {
      next.add(memberId);
      this.selectedMessageItems.set(
        memberId,
        albumMemberItem(item, memberId) as CbItem<ChatMsgData>,
      );
    }
    this.selectedMessageIds.set(next);
  }
}
