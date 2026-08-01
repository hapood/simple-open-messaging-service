import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import {
  albumMemberItem,
  applyMessageSelectionState,
  messageMemberIds,
  messageSelectionState,
} from './message-selection';

function album(): CbItem<ChatItemData> {
  return {
    id: 10,
    ids: [10, 11],
    data: {
      type: 'msg',
      msgId: 10,
      contentType: 'IMAGE',
      images: [{ msgId: 10 }, { msgId: 11 }],
    } as ChatItemData,
  };
}

describe('message selection', () => {
  it('derives album member state and materializes one selected member', () => {
    const item = album();
    expect(messageMemberIds(item)).toEqual([10, 11]);
    expect(messageSelectionState(item, new Set([11]))).toBe('some');
    expect(messageSelectionState(item, new Set([10, 11]))).toBe('all');
    expect(albumMemberItem(item, 11).data.images?.map((x) => x.msgId)).toEqual([
      11,
    ]);
  });

  it('writes row and member classes through one host-state function', () => {
    const host = document.createElement('div');
    const first = document.createElement('div');
    first.dataset['mediaMessageId'] = '10';
    const second = document.createElement('div');
    second.dataset['mediaMessageId'] = '11';
    host.append(first, second);

    applyMessageSelectionState(host, [10, 11], true, new Set([11]));

    expect(host.classList.contains('cb-message--partially-selected')).toBe(
      true,
    );
    expect(second.classList.contains('msg-media-cell--selected')).toBe(true);
    expect(host.getAttribute('aria-selected')).toBe('false');
  });
});
