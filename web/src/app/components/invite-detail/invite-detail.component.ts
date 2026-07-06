import { Component, EventEmitter, OnInit, Output, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { firstValueFrom } from 'rxjs';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ChatTransitionService } from '../../services/chat-transition.service';
import { InviteDetailService } from './invite-detail.service';

interface ParsedInvite {
  groupName: string;
  groupAvatar?: string;
  groupId?: number;
  fromUserId?: number;
  token: string;
  expiryDate?: string;
}

/**
 * Fullscreen Material dialog that shows the details of a group invite — group avatar, name, the
 * inviter, the token's expiry, and the Join action. Mounted as a transient overlay by
 * {@link InviteDetailService} (sentinel history → system-back closes it; the `close` output is wired
 * to the base close()).
 *
 * Join flow: call group/join → wait for the group thread to land in the conversation list →
 * {@link InviteDetailService.closeForReplace} (pops this dialog's sentinel) → fire the hero
 * {@link ChatTransitionService.transitionToThread} with replaceUrl, so back from the new group lands
 * on the conversation list (the P2P invite thread is dropped from the stack). The services are root
 * singletons, so the transition still runs to completion after this component is disposed by
 * closeForReplace. Reduced motion is handled inside the transition service.
 */
@Component({
  selector: 'app-invite-detail',
  imports: [MatButtonModule, UserAvatarComponent, TranslocoPipe],
  templateUrl: './invite-detail.component.html',
  styleUrl: './invite-detail.component.scss',
})
export class InviteDetailComponent implements OnInit {
  readonly UserAvatarType = UserAvatarType;
  /** Raw JSON body of the GROUP_INVITE message (set by InviteDetailService.open). */
  readonly raw = input<string>('');
  /** Emitted on X / backdrop / Cancel — the overlay base wires it to its close(). */
  @Output() close = new EventEmitter<void>();

  private readonly groupService = inject(GroupService);
  private readonly convList = inject(ConversationListService);
  private readonly chatTransition = inject(ChatTransitionService);
  private readonly inviteDetail = inject(InviteDetailService);
  private readonly transloco = inject(TranslocoService);

  readonly invite = signal<ParsedInvite>({ groupName: '', token: '' });
  readonly expiryLabel = signal('');
  /** 0 = valid (can join), 1 = expired. */
  readonly status = signal(0);
  readonly busy = signal(false);
  readonly errorMsg = signal('');

  /** Inviter display name — resolved from the P2P thread with fromUserId (the inviter is a friend). */
  readonly inviterName = computed(() => {
    const fid = this.invite().fromUserId;
    if (fid == null) return '';
    const item = this.convList.items().find((t) => t.type === 'P2P' && t.peerUser?.id === fid);
    return item?.peerUser?.userExtra?.name ?? '';
  });

  /** Already a member? The group thread is present in the conversation list (resolved by group id). */
  readonly joined = computed(() => {
    const gid = this.invite().groupId;
    return gid != null && this.convList.items().some((t) => t.group?.id === gid);
  });

  ngOnInit(): void {
    const parsed = this.parseInvite(this.raw());
    this.invite.set(parsed);
    this.expiryLabel.set(parsed.expiryDate ? dayjs(parsed.expiryDate).format('YYYY-MM-DD HH:mm') : '');
    this.status.set(parsed.expiryDate && dayjs().isAfter(dayjs(parsed.expiryDate)) ? 1 : 0);
  }

  private parseInvite(raw: string): ParsedInvite {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return {
        groupName: (o['groupName'] as string) ?? '',
        groupAvatar: o['groupAvatar'] as string | undefined,
        groupId: o['groupId'] as number | undefined,
        fromUserId: o['fromUserId'] as number | undefined,
        token: (o['token'] as string) ?? '',
        expiryDate: o['expiryDate'] as string | undefined,
      };
    } catch {
      return { groupName: '', token: '' };
    }
  }

  onClose(): void {
    this.close.emit();
  }

  async onJoin(): Promise<void> {
    if (this.busy() || this.status() !== 0 || this.joined()) return;
    this.busy.set(true);
    this.errorMsg.set('');
    const res = await firstValueFrom(this.groupService.joinGroup({ token: this.invite().token }));
    if (res.code !== 0) {
      this.busy.set(false);
      if ((res.message ?? '').toLowerCase().includes('expired')) this.status.set(1);
      this.errorMsg.set(res.message || this.transloco.translate('chat.failedToJoin'));
      return;
    }
    const tid = (res.data as { threadId?: number } | undefined)?.threadId;
    const item = tid != null ? await this.convList.ensureThread(tid) : undefined;
    // Pop this dialog's sentinel BEFORE the hero replaces the P2P entry (clean back→list stack).
    await this.inviteDetail.closeForReplace();
    if (tid != null) {
      await this.chatTransition.transitionToThread(tid, item, { replaceUrl: true });
    }
  }

  /** Already joined → open the group with the same replaceUrl semantics (back→list). */
  async onOpen(): Promise<void> {
    const gid = this.invite().groupId;
    const item = this.convList.items().find((t) => t.group?.id === gid);
    if (item?.threadId == null) return;
    await this.inviteDetail.closeForReplace();
    await this.chatTransition.transitionToThread(item.threadId, item, { replaceUrl: true });
  }
}
