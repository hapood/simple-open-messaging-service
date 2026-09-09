import { parseCallEndedContent } from '../../../../../../shared/call-ended-content';
import {
  Component,
  computed,
  inject,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LanguageService } from '../../../services/language.service';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';

const LABEL_KEYS: Record<string, string> = {
  FRIEND_ADDED: 'friendAdded',
  FRIEND_REMOVED: 'friendRemoved',
  GROUP_JOINED: 'groupJoined',
  GROUP_LEFT: 'groupLeft',
  GROUP_ADMIN_GRANTED: 'groupAdminGranted',
  GROUP_ADMIN_REVOKED: 'groupAdminRevoked',
  GROUP_OWNER_TRANSFERRED: 'groupOwnerTransferred',
  MESSAGE_WITHDRAWN: 'messageWithdrawn',
  MESSAGES_MODERATED: 'messagesModerated',
  FEDERATION_NAMESPACE_ARCHIVED: 'federationNamespaceArchived',
};

@Component({
  selector: 'app-msg-system-row',
  standalone: true,
  imports: [DateRowComponent],
  template: `
    @if (showDate()) {
      <app-msg-date-row [ms]="data().createdAtMs" />
    }
    <div class="system-message" role="status">
      {{ label() }} <time>{{ data().time }}</time>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      box-sizing: border-box;
      padding: var(--chat-timeline-gap-item) var(--chat-timeline-inset-inline) 0;
    }
    .system-message {
      width: fit-content;
      max-width: min(32rem, 90%);
      margin: 0 auto;
      padding: 2px 10px;
      box-sizing: border-box;
      border-radius: 999px;
      color: var(--chat-system-text);
      background: var(--chat-system-bg);
      border: 1px solid var(--chat-system-border);
      font-size: 12px;
      line-height: 18px;
      text-align: center;
    }
    time {
      margin-left: 6px;
      opacity: 0.7;
    }
  `,
})
export class SystemRowComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);
  readonly label = computed(() => {
    this.language.lang();
    try {
      const body = JSON.parse(this.data().text) as {
        type?: string;
        subject?: { account?: string; domain?: string };
        actor?: { account?: string; domain?: string };
        count?: number;
        domain?: string;
      };
      if (body.type === 'CALL_ENDED') {
        const call = parseCallEndedContent(this.data().text);
        if (!call) return this.fallback('invalid call-ended system message');
        const media = this.transloco.translate(
          call.mediaType === 'VIDEO' ? 'call.videoCall' : 'call.audioCall',
        );
        const direction = this.transloco.translate(
          this.data().isSelf ? 'call.record.outgoing' : 'call.record.incoming',
        );
        const result = this.transloco.translate(
          call.outcome === 'completed'
            ? 'call.ended'
            : `call.record.${call.outcome}`,
        );
        const duration =
          call.connectedAt === undefined
            ? ''
            : ` · ${Math.floor((call.endedAt - call.connectedAt) / 60000)}:${String(Math.floor((call.endedAt - call.connectedAt) / 1000) % 60).padStart(2, '0')}`;
        const waitMs = (call.connectedAt ?? call.endedAt) - call.initiatedAt;
        const waiting = this.transloco.translate('call.record.waiting', {
          duration: `${Math.floor(waitMs / 60000)}:${String(Math.floor(waitMs / 1000) % 60).padStart(2, '0')}`,
        });
        const started = new Date(call.initiatedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        return `${direction} · ${media} · ${result} · ${started} · ${waiting}${duration}`;
      }
      const labelKey = LABEL_KEYS[body.type ?? ''];
      if (!labelKey) return this.fallback('unknown system message type');

      const name = body.subject?.account?.trim();
      if (body.type === 'FRIEND_ADDED')
        return this.transloco.translate('chat.systemMessage.friendAdded');
      if (body.type === 'MESSAGES_MODERATED')
        return this.transloco.translate(
          'chat.systemMessage.messagesModerated',
          { count: body.count },
        );
      if (body.type === 'FEDERATION_NAMESPACE_ARCHIVED')
        return this.transloco.translate(
          'chat.systemMessage.federationNamespaceArchived',
          { domain: body.domain },
        );
      if (!name) return this.fallback('system message subject is missing');
      if (body.type === 'MESSAGE_WITHDRAWN') {
        return this.transloco.translate(
          this.data().isSelf
            ? 'chat.systemMessage.messageWithdrawnSelf'
            : 'chat.systemMessage.messageWithdrawn',
          { name },
        );
      }
      if (body.type === 'FRIEND_REMOVED') {
        if (this.data().isSelf)
          return this.transloco.translate(
            'chat.systemMessage.friendRemovedSelf',
            { name },
          );
        if (!this.data().isSelf && this.data().name.trim())
          return this.transloco.translate(
            'chat.systemMessage.friendRemovedOther',
            { name: this.data().name.trim() },
          );
      }
      if (body.type === 'GROUP_LEFT' && this.data().isSelf)
        return this.transloco.translate('chat.systemMessage.groupLeftSelf');
      return this.transloco.translate(`chat.systemMessage.${labelKey}`, {
        name,
      });
    } catch (error) {
      return this.fallback('failed to parse or render system message', error);
    }
  });

  private fallback(reason: string, error?: unknown): string {
    console.error(`[system-message] ${reason}`, error ?? this.data().text);
    try {
      return this.transloco.translate('chat.systemMessage.updated');
    } catch (translationError) {
      console.error(
        '[system-message] failed to translate fallback',
        translationError,
      );
      return 'Conversation updated';
    }
  }
}
