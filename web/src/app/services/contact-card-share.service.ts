import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { ConversationItem } from './model';
import { MsgService } from './message.service';
import { UserService } from './user.service';
import { PopupType, RouteService } from './route.service';
import { ToastService } from './toast.service';
import type { ChatMsgData } from '../components/message-cards/chat-item';
import type { ForwardDialogResult } from '../components/forward-dialog/forward-dialog.component';
import { uuid } from '../lib/uuid';

/** Opens the contact-card picker and sends the selected conversation identity to its recipients. */
@Injectable({ providedIn: 'root' })
export class ContactCardShareService {
  private readonly messages = inject(MsgService);
  private readonly users = inject(UserService);
  private readonly route = inject(RouteService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);

  open(chat: ConversationItem): void {
    const isGroup = chat.type === 'GROUP';
    const target = isGroup ? chat.group : chat.peerUser;
    const bio = isGroup ? chat.group.description : chat.peerUser.bio;
    const content = JSON.stringify({
      account: target.account,
      domain: target.domain,
      displayName: target.name,
      bio: bio ?? '',
      ...(target.avatar ? { avatar: target.avatar } : {}),
    });
    const preview: ChatMsgData = {
      type: 'msg',
      msgId: -1,
      creator: this.users.sessionProfile()?.id ?? null,
      isSelf: true,
      name: this.users.sessionProfile()?.name ?? '',
      text: content,
      time: '',
      contentType: 'CONTACT_CARD',
      images: null,
      file: null,
      createdAtMs: Date.now(),
    };
    this.route.popupDlg(
      PopupType.FORWARD,
      {
        purpose: 'CHAT_CARD',
        mode: 'HISTORY',
        recordKind: isGroup ? 'group' : 'chat',
        messages: [
          {
            id: -1,
            name: target.name,
            summary: this.transloco.translate(
              isGroup ? 'contactCard.group' : 'contactCard.person',
            ),
            original: preview,
          },
        ],
      },
      (result) => {
        if (result) void this.send(result, chat);
      },
    );
  }

  private async send(
    result: ForwardDialogResult,
    chat: ConversationItem,
  ): Promise<void> {
    const outcomes = await Promise.all(
      result.threadIds.map(async (threadId) => {
        try {
          const response = await firstValueFrom(
            this.messages.sendContactCard({
              threadId,
              ...(chat.type === 'GROUP'
                ? { targetGroupId: chat.group.id }
                : { targetUserId: chat.peerUser.id }),
              clientMessageId: uuid(),
            }),
          );
          return response.code === 0;
        } catch {
          return false;
        }
      }),
    );
    const sent = outcomes.filter(Boolean).length;
    this.toast[sent === outcomes.length ? 'info' : 'warn'](
      sent > 0
        ? this.transloco.translate('forward.sent', { count: sent })
        : this.transloco.translate('forward.sendFailed'),
    );
  }
}
