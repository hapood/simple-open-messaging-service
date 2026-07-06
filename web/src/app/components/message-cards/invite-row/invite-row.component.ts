import { Component, computed, inject, input, signal, OnInit } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { InviteDetailService } from '../../invite-detail/invite-detail.service';

/**
 * Invite message row — a tappable Material preview card (group avatar + name + expiry) that opens the
 * full {@link InviteDetailComponent} dialog. The Join action lives in that dialog now, not inline.
 *
 * `data.text` is the raw JSON written by group/create|invite ({ fromUserId, groupId, groupName,
 * groupAvatar, expiryDate, token }); `ngOnInit` parses it for the preview. A dimmed presentation is
 * shown when the token is already past its expiry (the dialog re-checks on join).
 *
 * `statusTick` / `isSending` are always inert for invites (invites are always "other") but are kept
 * so this component stays structurally aligned with TextRow/MediaRow — createMsgCbElement picks the
 * component by contentType and relies on the shared shape.
 */
@Component({
  selector: 'app-msg-invite-row',
  standalone: true,
  imports: [UserAvatarComponent, DateRowComponent, TranslocoPipe],
  templateUrl: './invite-row.component.html',
  styleUrl: './invite-row.component.scss',
})
export class InviteRowComponent implements OnInit {
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Whether a date-separator pill should render above this row (it is the first message of its day). */
  readonly showDate = input<boolean>(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  /** Render a status tick only for self-sent messages with a delivery status. Inert for invites. */
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  /** Dim while in flight (never true for invites). */
  readonly isSending = computed(() => this.data().isSelf && this.data().status === 'sending');

  readonly invite = signal<{
    groupName: string;
    groupAvatar?: string;
    token: string;
    expiryDate?: string;
  }>({ groupName: '', token: '' });
  readonly expiryLabel = signal('');
  /** 0 = valid, 1 = expired — drives a dimmed preview (the dialog re-checks on join). */
  readonly status = signal(0);

  private readonly inviteDetail = inject(InviteDetailService);

  ngOnInit() {
    const parsed = this.parseInvite(this.data().text);
    this.invite.set(parsed);
    this.expiryLabel.set(
      parsed.expiryDate ? dayjs(parsed.expiryDate).format('YYYY-MM-DD HH:mm') : '',
    );
    this.status.set(
      parsed.expiryDate && dayjs().isAfter(dayjs(parsed.expiryDate)) ? 1 : 0,
    );
  }

  private parseInvite(content: string): {
    groupName: string;
    groupAvatar?: string;
    token: string;
    expiryDate?: string;
  } {
    try {
      const obj = JSON.parse(content);
      return {
        groupName: obj.groupName ?? '',
        groupAvatar: obj.groupAvatar,
        token: obj.token ?? '',
        expiryDate: obj.expiryDate,
      };
    } catch {
      return { groupName: '', token: '' };
    }
  }

  /** Open the Material invite-detail dialog (a transient overlay); the Join action lives there. */
  openDetail(): void {
    this.inviteDetail.open(this.data().text);
  }
}
