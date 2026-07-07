import { Component, ElementRef, EventEmitter, OnDestroy, OnInit, Output, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { firstValueFrom } from 'rxjs';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { prefersReducedMotion } from '../../lib/motion-utils';

/** Enter timing — matches the app's overlaySlide rhythm so this card enters in step. */
const ENTER_MS = 300;
const EASING = 'cubic-bezier(0.32,0.72,0,1)';

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
 * Centering: rather than flex-centering on the whole viewport, a `.ivd-frame` is pinned at runtime to
 * the `.chat-slot` pane rect (the region the invite row lives in), so the card centers on the chat
 * pane. The frame's `pointer-events:none` lets empty-pane taps fall through to the backdrop; the card
 * re-enables its own. A WAAPI scale+fade enter animation plays once on mount (snapped under reduced
 * motion), and the frame re-pins on window resize for the dialog's transient lifetime.
 *
 * Join flow: call group/join → nav.openChat(tid). The nav state machine clears the pane stack, so this
 * dialog's entry is removed and the TransientOverlayService effect disposes the CDK overlay. The A/B
 * chat-pane buffer then resets the target thread in its background pane and reveals it with a circular
 * clip-path once ready. Reduced motion is handled inside the buffer (instant swap).
 */
@Component({
  selector: 'app-invite-detail',
  imports: [MatButtonModule, UserAvatarComponent, TranslocoPipe],
  templateUrl: './invite-detail.component.html',
  styleUrl: './invite-detail.component.scss',
})
export class InviteDetailComponent implements OnInit, OnDestroy {
  readonly UserAvatarType = UserAvatarType;
  /** Raw JSON body of the GROUP_INVITE message (set by InviteDetailService.open). */
  readonly raw = input<string>('');
  /** Emitted on X / backdrop / Cancel — the overlay base wires it to its close(). */
  @Output() close = new EventEmitter<void>();

  private readonly groupService = inject(GroupService);
  private readonly convList = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
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

  /** Positioning frame aligned to .chat-slot's rect (set in positionFrame) so the card centers on the
   *  chat pane — where the invite row lives — instead of the whole viewport. */
  readonly frame = viewChild<ElementRef<HTMLElement>>('frame');

  constructor() {
    // Center on the chat pane once the frame renders, and play the enter animation. The effect re-runs
    // only when the viewChild signal resolves (undefined→element), so the enter animation plays once.
    effect(() => {
      const f = this.frame();
      if (!f) return;
      this.positionFrame(f.nativeElement);
      this.playEnter(f.nativeElement.querySelector('.ivd-card'));
    });
    window.addEventListener('resize', this.onResize);
  }

  ngOnInit(): void {
    const parsed = this.parseInvite(this.raw());
    this.invite.set(parsed);
    this.expiryLabel.set(parsed.expiryDate ? dayjs(parsed.expiryDate).format('YYYY-MM-DD HH:mm') : '');
    this.status.set(parsed.expiryDate && dayjs().isAfter(dayjs(parsed.expiryDate)) ? 1 : 0);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  private readonly onResize = (): void => {
    const f = this.frame();
    if (f) this.positionFrame(f.nativeElement);
  };

  /** Pin the frame to .chat-slot's viewport rect (fallback: full viewport when the slot can't be
   *  found), so the card centers in the chat pane — the same region the invite row was opened from. */
  private positionFrame(frame: HTMLElement): void {
    const slot = document.querySelector<HTMLElement>('.chat-slot');
    const r = slot ? slot.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    frame.style.top = `${r.top}px`;
    frame.style.left = `${r.left}px`;
    frame.style.width = `${r.width}px`;
    frame.style.height = `${r.height}px`;
  }

  /** Card enter: scale 0.92→1 + fade in the app ENTER cadence; snaps to the end state when the user
   *  prefers reduced motion. The SCSS pre-state (opacity:0, scale .92) matches the first keyframe. */
  private playEnter(card: HTMLElement | null): void {
    if (!card) return;
    if (prefersReducedMotion()) {
      card.style.opacity = '1';
      card.style.transform = 'none';
      return;
    }
    card.animate(
      [
        { opacity: 0, transform: 'scale(0.92)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: ENTER_MS, easing: EASING, fill: 'forwards' },
    );
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
    // openChat clears the pane stack → the invite-detail entry is removed → the TransientOverlayService
    // effect disposes the CDK overlay. No explicit close needed.
    if (tid != null) {
      this.nav.openChat(tid);
    }
  }

  /** Already joined → open the group. openChat clears the pane stack → overlay disposed. */
  async onOpen(): Promise<void> {
    const gid = this.invite().groupId;
    const tid = this.convList.items().find((t) => t.group?.id === gid)?.threadId;
    if (tid == null) return;
    this.nav.openChat(tid);
  }
}
