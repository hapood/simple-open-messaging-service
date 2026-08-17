import { Component, computed, inject, input, signal, OnInit } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { FederatedBadgeComponent } from '../../federated-badge/federated-badge.component';
import { InviteDetailService } from '../../invite-detail/invite-detail.service';

/**
 * Invite message row — a tappable preview card (group avatar + name + home-domain) that opens the full
 * {@link InviteDetailComponent} dialog. The Join + validity flow lives in that dialog.
 *
 * `data.text` is the raw JSON written by group/create|invite (the inviter's P2P thread; a federated
 * target receives it via the Step-2 P2P pull). Shape: `{ type:'GROUP_INVITE', from, group, groupName,
 * groupAvatar?, groupDomain, groupIsLocal }` — `from`/`group` are ACCOUNTS (the group `!account` is the
 * invite-resolution key the dialog uses with /invite/detail + /invite/accept); the display fields render
 * this row inline on both the inviter's + invitee's side with no fetch (no internal ids on the card). The
 * dialog fetches the live validity + the authoritative localized avatar via /invite/detail(group).
 *
 * `statusTick` / `isSending` are always inert for invites (invites are always "other") but are kept so
 * this component stays structurally aligned with TextRow/MediaRow.
 */
@Component({
  selector: 'app-msg-invite-row',
  standalone: true,
  imports: [UserAvatarComponent, DateRowComponent, TranslocoPipe, FederatedBadgeComponent],
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
  readonly showName = computed(
    () =>
      this.isShowHead() &&
      this.data().isGroupConversation === true &&
      !this.data().isSelf,
  );
  /** Render a status tick only for self-sent messages with a delivery status. Inert for invites. */
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  /** Dim while in flight (never true for invites). */
  readonly isSending = computed(() => this.data().isSelf && this.data().status === 'sending');

  readonly invite = signal<{
    groupName: string;
    groupAvatar?: string;
    groupDomain?: string;
    groupIsLocal?: boolean;
    /** The group `!account` — a globally-unique ULID; the avatar cache identity (no numeric id on a card). */
    group?: string;
  }>({ groupName: '' });

  private readonly inviteDetail = inject(InviteDetailService);

  ngOnInit() {
    this.invite.set(this.parseInvite(this.data().text));
  }

  private parseInvite(content: string): {
    groupName: string;
    groupAvatar?: string;
    groupDomain?: string;
    groupIsLocal?: boolean;
    group?: string;
  } {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      return {
        groupName: (obj['groupName'] as string) ?? '',
        groupAvatar: obj['groupAvatar'] as string | undefined,
        groupDomain: obj['groupDomain'] as string | undefined,
        groupIsLocal: obj['groupIsLocal'] as boolean | undefined,
        group: obj['group'] as string | undefined,
      };
    } catch {
      return { groupName: '' };
    }
  }

  /** Open the invite-detail dialog (transient overlay); the Join + validity flow lives there. */
  openDetail(): void {
    this.inviteDetail.open(this.data().text);
  }
}
