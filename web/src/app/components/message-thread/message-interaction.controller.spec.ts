import { describe, expect, it } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatMsgData } from '../message-cards/chat-item';
import { MessageInteractionController } from './message-interaction.controller';

function message(id: number, ids?: number[]): CbItem<ChatMsgData> {
  return {
    id,
    ids,
    data: {
      type: 'msg',
      msgId: id,
      contentType: 'PURE_TEXT',
    },
  } as CbItem<ChatMsgData>;
}

function systemMessage(id: number): CbItem<ChatMsgData> {
  return {
    id,
    data: {
      type: 'system',
      msgId: id,
      contentType: 'SYSTEM',
    },
  } as CbItem<ChatMsgData>;
}

describe('MessageInteractionController', () => {
  it('owns whole-message and album-member selection transitions', () => {
    const controller = new MessageInteractionController();
    const album = message(10, [10, 11]);

    controller.toggle(album);
    expect(controller.selectionMode()).toBe(true);
    expect(controller.selectedMessageIds()).toEqual(new Set([10, 11]));

    controller.toggle(album, 11);
    expect(controller.selectedMessageIds()).toEqual(new Set([10]));
    expect(controller.selectedItems().map((item) => item.id)).toEqual([10]);

    controller.resetSelection();
    expect(controller.selectionMode()).toBe(false);
    expect(controller.selectedCount()).toBe(0);
  });

  it('moves a context target into selection and removes deleted messages', () => {
    const controller = new MessageInteractionController();
    const item = message(4);

    controller.openContextMenu(
      item,
      undefined,
      { x: 30, y: 40 },
      { left: 0, top: 0, right: 300, bottom: 400 },
      3,
    );
    expect(controller.contextMenu()?.targetSeq).toBe(4);
    expect(controller.selectContextMessage()).toBe(true);
    expect(controller.selectedMessageIds()).toEqual(new Set([4]));

    controller.removeMessage(4);
    expect(controller.selectedCount()).toBe(0);
  });

  it('does not select system or deletion placeholder messages', () => {
    const controller = new MessageInteractionController();
    const system = systemMessage(7);
    const deleted = {
      ...systemMessage(8),
      data: { ...systemMessage(8).data, deletionType: 'MODERATION_REMOVAL' },
    } as CbItem<ChatMsgData>;

    controller.toggle(system);
    controller.toggle(deleted);
    expect(controller.selectionMode()).toBe(false);
    expect(controller.selectedCount()).toBe(0);

    controller.openContextMenu(
      deleted,
      undefined,
      { x: 30, y: 40 },
      { left: 0, top: 0, right: 300, bottom: 400 },
      3,
    );
    expect(controller.selectContextMessage()).toBe(false);
    expect(controller.selectedCount()).toBe(0);
  });

  it('does not select a pending optimistic row whose id is still a placeholder', () => {
    const controller = new MessageInteractionController();
    const pending = message(-3);

    controller.toggle(pending);
    expect(controller.selectionMode()).toBe(false);
    expect(controller.selectedCount()).toBe(0);

    controller.openContextMenu(
      pending,
      undefined,
      { x: 30, y: 40 },
      { left: 0, top: 0, right: 300, bottom: 400 },
      3,
    );
    expect(controller.selectContextMessage()).toBe(false);
    expect(controller.selectedCount()).toBe(0);
  });

  it('consumes a quote exactly once', () => {
    const controller = new MessageInteractionController();
    const quote = {
      seq: 7,
      author: 'Ada',
      body: 'hello',
    } as ChatMsgData['quote'];

    controller.setQuote(quote);
    expect(controller.consumeQuote()).toBe(quote);
    expect(controller.consumeQuote()).toBeNull();
  });
});
