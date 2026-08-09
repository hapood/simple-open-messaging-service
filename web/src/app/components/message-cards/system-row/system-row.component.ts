import { Component, computed, input } from '@angular/core';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';

const LABELS: Record<string, string> = {
  FRIEND_REQUESTED: 'sent a friend request',
  FRIEND_ACCEPTED: 'accepted the friend request',
  FRIEND_ADDED: 'You are now friends',
  FRIEND_REMOVED: 'Friendship ended',
  GROUP_JOINED: 'A member joined the group',
  GROUP_LEFT: 'A member left the group',
  GROUP_ADMIN_GRANTED: 'A member became an administrator',
  GROUP_ADMIN_REVOKED: 'An administrator became a member',
  GROUP_OWNER_TRANSFERRED: 'Group ownership was transferred',
};

const SUBJECT_LABELS: Record<string, string> = {
  GROUP_JOINED: 'joined the group',
  GROUP_LEFT: 'left the group',
  GROUP_ADMIN_GRANTED: 'became an administrator',
  GROUP_ADMIN_REVOKED: 'became a member',
  GROUP_OWNER_TRANSFERRED: 'became the group owner',
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
      padding: 0.25rem 1rem;
    }
    .system-message {
      width: fit-content;
      max-width: min(32rem, 90%);
      margin: 0.25rem auto;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      color: var(--mat-sys-on-surface-variant);
      background: var(--mat-sys-surface-container);
      font-size: 0.75rem;
      text-align: center;
    }
    time {
      margin-left: 0.35rem;
      opacity: 0.7;
    }
  `,
})
export class SystemRowComponent {
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);
  readonly label = computed(() => {
    try {
      const body = JSON.parse(this.data().text) as {
        type?: string;
        subject?: { account?: string; domain?: string };
      };
      const action = LABELS[body.type ?? ''] ?? 'updated the conversation';
      if (body.type === 'FRIEND_REQUESTED' || body.type === 'FRIEND_ACCEPTED')
        return `${this.data().name} ${action}`;
      const subjectAction = SUBJECT_LABELS[body.type ?? ''];
      if (subjectAction && body.subject?.account)
        return `${body.subject.account} ${subjectAction}`;
      return action;
    } catch {
      return 'Conversation updated';
    }
  });
}
