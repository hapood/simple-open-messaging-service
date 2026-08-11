import { Component, computed, inject, input } from '@angular/core';
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
      };
      const labelKey = LABEL_KEYS[body.type ?? ''];
      if (!labelKey) return this.fallback('unknown system message type');

      const name = body.subject?.account?.trim();
      if (body.type === 'FRIEND_ADDED')
        return this.transloco.translate('chat.systemMessage.friendAdded');
      if (!name) return this.fallback('system message subject is missing');
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
