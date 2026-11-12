import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData, ChatMsgData } from './chat-item';
import { computeRowFlags } from './create-item';

function message(
  msgId: number,
  creator: number,
  contentType: ChatMsgData['contentType'] = 'PURE_TEXT',
): CbItem<ChatItemData> {
  if (contentType === 'SYSTEM')
    return {
      id: msgId,
      data: {
        type: 'system',
        msgId,
        isSelf: false,
        name: '',
        text: '{}',
        time: '12:00',
        contentType: 'SYSTEM',
        images: null,
        file: null,
        createdAtMs: 1700000000000 + msgId,
      },
    };
  return {
    id: msgId,
    data: {
      type: 'msg',
      msgId,
      creator: JSON.stringify([0, 'local', `user-${creator}`]),
      isSelf: false,
      name: 'Alice',
      text: 'hello',
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

  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'keeps a mounted %s notice anonymous while preserving date context and breaking the sender run',
    (deletionType) => {
      const before = message(1, 2);
      const tomb: CbItem<ChatItemData> = {
        id: 2,
        boundary: 'oldest',
        data: {
          ...message(2, 2, 'SYSTEM').data,
          type: 'system',
          contentType: 'SYSTEM',
          text: '',
          time: '',
          createdAtMs: before.data.createdAtMs,
          deletionType,
        },
      };
      const after = message(3, 2);
      expect(computeRowFlags(tomb, before, after)).toEqual({
        isShowHead: false,
        isGroupStart: false,
        showDate: false,
        groupPosition: 'single',
      });
      expect(computeRowFlags(tomb, null).showDate).toBe(true);
      expect(computeRowFlags(before, null, tomb).groupPosition).toBe('single');
      expect(computeRowFlags(after, tomb)).toMatchObject({
        isShowHead: true,
        showDate: false,
        groupPosition: 'single',
      });
      expect(computeRowFlags(after, null).showDate).toBe(false);
    },
  );

  it('uses dated system events for date context independently of sender grouping', () => {
    const system = { ...message(1, 2, 'SYSTEM'), boundary: 'oldest' as const };
    const next = message(2, 2);
    expect(computeRowFlags(system, null).showDate).toBe(true);
    expect(computeRowFlags(next, system)).toMatchObject({
      isShowHead: true,
      showDate: false,
    });
    next.data.createdAtMs = system.data.createdAtMs! + 86400000;
    expect(computeRowFlags(next, system).showDate).toBe(true);
  });

  it('keeps consecutive ordinary messages from the same creator grouped', () => {
    expect(computeRowFlags(message(2, 2), message(1, 2)).isShowHead).toBe(
      false,
    );
  });

  it.each([
    'IMAGE',
    'VIDEO',
    'FILE',
    'AUDIO',
    'GALLERY',
    'LINK',
    'CONTACT_CARD',
      'FORWARD',
  ] as const)(
    'keeps a %s message and the following text message out of compact grouping',
    (contentType) => {
      const textBefore = message(1, 2);
      const card = message(2, 2, contentType);
      const textAfter = message(3, 2);

      expect(computeRowFlags(card, textBefore, textAfter)).toMatchObject({
        isShowHead: true,
        isGroupStart: true,
        groupPosition: 'single',
      });
      expect(computeRowFlags(textAfter, card)).toMatchObject({
        isShowHead: true,
        isGroupStart: true,
        groupPosition: 'single',
      });
    },
  );

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

  it('shows the date for a sole message spanning both timeline boundaries', () => {
    const sole = { ...message(1, 2), boundary: 'both' as const };

    expect(computeRowFlags(sole, null, null).showDate).toBe(true);
  });

  it('breaks the four-state group across a sender change', () => {
    expect(
      computeRowFlags(message(2, 3), message(1, 2), message(3, 2))
        .groupPosition,
    ).toBe('single');
  });
});
