import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { BusinessCode } from '../../services/biz-code';
import type { StandardResponse } from '../../services/model';
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
  deps?: {
    adapter?: Partial<MessageThreadAdapter>;
    toast?: Partial<ToastService>;
  },
): MessageForwardController {
  return new MessageForwardController(
    (deps?.adapter ?? {}) as MessageThreadAdapter,
    {} as ConversationListService,
    {
      popupDlg: (_type: unknown, data: unknown) => onDialog?.(data),
    } as unknown as RouteService,
    (deps?.toast ?? {}) as ToastService,
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
      kind: 'HISTORY_FORWARD',
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

  it('sends direct forwards one source message per request', async () => {
    const sendForward = vi.fn(() =>
      of({
        code: BusinessCode.OK,
        message: 'successful',
        data: undefined,
      } satisfies StandardResponse<unknown>) as ReturnType<
        MessageThreadAdapter['sendForward']
      >,
    );
    const forwarding = controller(undefined, {
      adapter: { sendForward },
      toast: { info: vi.fn() },
    });

    const completed = await (
      forwarding as unknown as {
        send: (
          result: {
            threadIds: number[];
            messages: { id: number }[];
            mode: 'DIRECT';
          },
          sourceThreadId: number,
        ) => Promise<boolean>;
      }
    ).send(
      {
        threadIds: [9],
        messages: [{ id: 4 }, { id: 5 }],
        mode: 'DIRECT',
      },
      8,
    );

    expect(completed).toBe(true);
    expect(sendForward).toHaveBeenCalledTimes(2);
    expect(sendForward).toHaveBeenNthCalledWith(1, {
      threadId: 9,
      sourceMessages: [{ threadId: 8, seq: 4 }],
      mode: 'DIRECT',
      clientMessageId: 'client-id',
    });
    expect(sendForward).toHaveBeenNthCalledWith(2, {
      threadId: 9,
      sourceMessages: [{ threadId: 8, seq: 5 }],
      mode: 'DIRECT',
      clientMessageId: 'client-id',
    });
  });

  it('surfaces forward business failures through a warning toast', async () => {
    const warn = vi.fn();
    const forwarding = controller(undefined, {
      adapter: {
        sendForward: () =>
          of({
            code: BusinessCode.FORWARD_INVALID_BUNDLE,
            message: 'one or more source messages do not exist',
            data: undefined,
          } satisfies StandardResponse<unknown>) as ReturnType<
            MessageThreadAdapter['sendForward']
          >,
      },
      toast: { warn },
    });

    const completed = await (
      forwarding as unknown as {
        send: (
          result: { threadIds: number[]; messages: unknown[]; mode: 'HISTORY' },
          sourceThreadId: number,
        ) => Promise<boolean>;
      }
    ).send({ threadIds: [9], messages: [{ id: 4 }], mode: 'HISTORY' }, 8);

    expect(completed).toBe(false);
    expect(warn).toHaveBeenCalledWith('errors.biz.forwardInvalidBundle');
  });
});
