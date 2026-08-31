import { describe, expect, it } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatMsgData } from '../message-cards/chat-item';
import { MessageForwardController } from './message-forward.controller';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { ConversationListService } from '../../services/conversation-list.service';
import type { RouteService } from '../../services/route.service';
import type { ToastService } from '../../services/toast.service';
import type { TranslocoService } from '@jsverse/transloco';

function controller(
  onDialog?: (data: unknown) => void,
): MessageForwardController {
  return new MessageForwardController(
    {} as MessageThreadAdapter,
    {} as ConversationListService,
    {
      popupDlg: (_type: unknown, data: unknown) => onDialog?.(data),
    } as unknown as RouteService,
    {} as ToastService,
    { translate: (key: string) => key } as TranslocoService,
    () => 'client-id',
  );
}

describe('MessageForwardController', () => {
  it('builds a chronologically sorted forward-dialog model', () => {
    let dialogData: unknown;
    const item = (id: number, createdAtMs: number): CbItem<ChatMsgData> =>
      ({
        id,
        data: {
          type: 'msg',
          msgId: id,
          name: `user-${id}`,
          text: `message-${id}`,
          contentType: 'PURE_TEXT',
          createdAtMs,
        },
      }) as CbItem<ChatMsgData>;

    controller((data) => (dialogData = data)).open(
      [item(2, 20), item(1, 10)],
      'HISTORY',
      8,
      'group',
      () => undefined,
    );

    expect(dialogData).toMatchObject({
      mode: 'HISTORY',
      recordKind: 'group',
      messages: [{ id: 1 }, { id: 2 }],
    });
  });

  it('owns localized message summaries', () => {
    const forwarding = controller();
    expect(
      forwarding.summary({
        contentType: 'FILE',
        file: { name: 'notes.txt' },
      } as ChatMsgData),
    ).toBe('notes.txt');
    expect(forwarding.summary({ contentType: 'AUDIO' } as ChatMsgData)).toBe(
      'chat.preview.voice',
    );
  });
});
