import { firstValueFrom } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import { BusinessCode, translateBizResult } from '../../services/biz-code';
import { ConversationListService } from '../../services/conversation-list.service';
import { PopupType, RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';
import type { ChatMsgData } from '../message-cards/chat-item';
import type { ForwardDialogResult } from '../forward-dialog/forward-dialog.component';
import type { ForwardMessageItem } from '../forward-message-card/forward-message-card.component';
import { MessageThreadAdapter } from './message-thread-adapter';

/** Coordinates the forward dialog and fan-out requests independently of thread rendering. */
export class MessageForwardController {
  constructor(
    private readonly adapter: MessageThreadAdapter,
    private readonly conversations: ConversationListService,
    private readonly route: RouteService,
    private readonly toast: ToastService,
    private readonly transloco: TranslocoService,
    private readonly newClientMessageId: () => string,
  ) {}

  open(
    items: readonly CbItem<ChatMsgData>[],
    mode: 'DIRECT' | 'HISTORY',
    sourceThreadId: number,
    recordKind: 'group' | 'chat',
    onComplete: () => void,
  ): void {
    const messages = items
      .slice()
      .sort((a, b) => a.data.createdAtMs - b.data.createdAtMs)
      .map(
        (item): ForwardMessageItem => ({
          id: item.id,
          name: item.data.name,
          summary: this.summary(item.data),
          original: item.data,
        }),
      );
    this.route.popupDlg(
      PopupType.FORWARD,
      { messages, mode, recordKind },
      (result) => {
        if (result)
          void this.send(result, sourceThreadId).then((completed) => {
            if (completed) onComplete();
          });
      },
    );
  }

  summary(message: ChatMsgData): string {
    if (message.contentType === 'PURE_TEXT' || message.contentType === 'LINK')
      return (
        message.text.trim() || this.transloco.translate('forward.emptyMessage')
      );
    if (message.contentType === 'FILE')
      return (
        message.file?.name || this.transloco.translate('chat.preview.file')
      );
    const keys: Partial<Record<ChatMsgData['contentType'], string>> = {
      IMAGE: 'chat.preview.photo',
      VIDEO: 'chat.preview.video',
      AUDIO: 'chat.preview.voice',
      GALLERY: 'chat.fileGroup',
      CALL: 'forward.call',
    };
    return this.transloco.translate(
      keys[message.contentType] ?? 'forward.message',
    );
  }

  private async send(
    result: ForwardDialogResult,
    sourceThreadId: number,
  ): Promise<boolean> {
    const sourceMessages = result.messages.map((message) => ({
      threadId: sourceThreadId,
      seq: message.id,
    }));
    const outcomes = await Promise.all(
      result.threadIds.map(async (threadId) => {
        try {
          const response = await firstValueFrom(
            this.adapter.sendForward({
              threadId,
              sourceMessages,
              mode: result.mode,
              clientMessageId: this.newClientMessageId(),
            }),
          );
          if (response.code === BusinessCode.GROUP_DISSOLVED) {
            this.conversations.applyGroupUpdate(threadId, {
              dissolvedAt: Date.now(),
            });
          } else if (response.code === BusinessCode.FRIEND_NOT_FOUND) {
            this.conversations.applyThreadMeta(threadId, {
              friendshipActive: false,
            });
          }
          return { ok: response.code === BusinessCode.OK, response };
        } catch {
          return { ok: false, response: undefined };
        }
      }),
    );
    const sent = outcomes.filter((outcome) => outcome.ok).length;
    if (sent === outcomes.length) {
      this.toast.info(
        this.transloco.translate('forward.sent', { count: sent }),
      );
      return true;
    }
    if (sent > 0) {
      this.toast.warn(
        this.transloco.translate('forward.partiallySent', {
          sent,
          total: outcomes.length,
        }),
      );
      return true;
    }
    const businessFailure = outcomes.find(
      (outcome) => outcome.response,
    )?.response;
    this.toast.warn(
      businessFailure
        ? translateBizResult(businessFailure, this.transloco)
        : this.transloco.translate('forward.sendFailed'),
    );
    return false;
  }
}
