import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData, ChatMsgData } from './chat-item';
import { computeRowFlags } from './create-item';

function message(
  msgId: number,
  creator: number,
  contentType: ChatMsgData['contentType'] = 'PURE_TEXT',
): CbItem<ChatItemData> {
  return {
    id: msgId,
    data: {
      type: 'msg',
      msgId,
      creator,
      isSelf: false,
      name: 'Alice',
      text: contentType === 'SYSTEM' ? '{}' : 'hello',
      time: '12:00',
      contentType,
      images: null,
      file: null,
      createdAtMs: 1700000000000 + msgId,
    },
  };
}

describe('computeRowFlags', () => {
  it('starts a visible sender group after a system event from the same creator', () => {
    const system = message(0, 2, 'SYSTEM');
    const firstChatMessage = message(1, 2);

    expect(computeRowFlags(firstChatMessage, system).isShowHead).toBe(true);
  });

  it('keeps consecutive ordinary messages from the same creator grouped', () => {
    expect(computeRowFlags(message(2, 2), message(1, 2)).isShowHead).toBe(
      false,
    );
  });

  it('classifies a same-sender run as head, body and tail', () => {
    const first = message(1, 2);
    const middle = message(2, 2);
    const last = message(3, 2);

    expect(computeRowFlags(first, null, middle).groupPosition).toBe('head');
    expect(computeRowFlags(middle, first, last).groupPosition).toBe('body');
    expect(computeRowFlags(last, middle, null).groupPosition).toBe('tail');
  });

  it('classifies an isolated message as single', () => {
    expect(computeRowFlags(message(1, 2), null, null).groupPosition).toBe(
      'single',
    );
  });

  it('breaks the four-state group across a sender change', () => {
    expect(
      computeRowFlags(message(2, 3), message(1, 2), message(3, 2))
        .groupPosition,
    ).toBe('single');
  });
});
