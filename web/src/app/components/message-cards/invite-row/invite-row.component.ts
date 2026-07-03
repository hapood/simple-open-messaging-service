import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import dayjs from 'dayjs';
import { GroupService } from '../../../services/group.service';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';

/**
 * Invite message row: the WhatsApp-style row shell with an embedded invite card + Join action.
 *
 * `data.text` is the raw JSON written by `group/invite` ({ fromUserId, groupId, groupName,
 * groupAvatar, expiryDate, token }); `ngOnInit` parses it.
 *
 * States: 0 = invited (Join enabled), 1 = expired. A successful join flips the card to a "Joined"
 * state with an "Open group" follow-through that opens the conversation (the join response carries the
 * threadId). An expired/invalid join reply surfaces as a status line / expired state.
 *
 * `dateLabel`: the createItem factory passes a per-day label; when non-null the template renders a
 * date pill above the row.
 */
@Component({
  selector: 'app-msg-invite-row',
  standalone: true,
  imports: [MatButtonModule, DateRowComponent, UserAvatarComponent],
  templateUrl: './invite-row.component.html',
  styleUrl: './invite-row.component.scss',
})
export class InviteRowComponent {
  readonly UserAvatarType = UserAvatarType
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Per-day date label (non-null = this row is the first of its day → render a date pill above). */
  readonly dateLabel = input<string | null>(null);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  /** Render a status tick only for self-sent messages with a delivery status. Invites are always
   *  "other" -> always false, but the member is required so this component stays structurally aligned
   *  with TextRow/MediaRow (createMsgCbElement picks the component by contentType and relies on the
   *  shared shape). */
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
  /** 0 = valid (can join); 1 = expired. */
  readonly status = signal(0);
  /** Set once a Join succeeds (covers first-time join and idempotent re-join) → the card flips to the
   *  "Joined" state with an "Open group" follow-through. */
  readonly joined = signal(false);
  /** The joined group's threadId (from the join response) — used to open the conversation. */
  readonly joinedThreadId = signal<number | undefined>(undefined);
  /** Error/status line from the last Join attempt (e.g. invalid token). Cleared on success. */
  readonly resultMsg = signal('');

  private readonly groupService = inject(GroupService);
  private readonly router = inject(Router);

  ngOnInit() {
    const parsed = this.parseInvite(this.data().text);
    this.invite.set(parsed);
    this.expiryLabel.set(
      parsed.expiryDate ? dayjs(parsed.expiryDate).format('YYYY-MM-DD HH:mm') : '',
    );
    // Expired when now is past expiryDate (the server re-checks on join, so a skewed client clock
    // is corrected by the join reply rather than silently mislabeling the card).
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

  joinGroup() {
    this.groupService.joinGroup({ token: this.invite().token }).subscribe((res) => {
      if (res.code === 0) {
        // Covers both a fresh join and the idempotent "already a member" reply. The join response
        // carries the threadId so the "Open group" follow-through can open the conversation directly.
        this.joined.set(true);
        this.joinedThreadId.set(
          (res.data as { threadId?: number } | undefined)?.threadId,
        );
        this.resultMsg.set('');
      } else {
        // Map an expired-token reply to the expired state; anything else (invalid / not-for-you) is a
        // transient status line so the card stays actionable.
        if ((res.message ?? '').includes('expired')) this.status.set(1);
        this.resultMsg.set(res.message || 'Failed to join');
      }
    });
  }

  /** Open the just-joined group conversation by navigating to its chat route. */
  openGroup() {
    const tid = this.joinedThreadId();
    if (tid !== undefined) this.router.navigate(['chat', tid]);
  }
}
