import {
  Component,
  ElementRef,
  EventEmitter,
  OnDestroy,
  OnInit,
  Output,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AppIconType, IconComponent } from '../icon/icon.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { UserService } from '../../services/user.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { prefersReducedMotion } from '../../lib/motion-utils';
import type { InviteDetail } from '../../services/model';

/** Enter timing — matches the app's overlaySlide rhythm so this card enters in step. */
const ENTER_MS = 300;
const EASING = 'cubic-bezier(0.32,0.72,0,1)';

type ViewState =
  | 'loading'
  | 'valid'
  | 'requested'
  | 'joined'
  | 'expired'
  | 'invalid';

/**
 * Fullscreen Material dialog for a group invite. Opened with the raw GROUP_INVITE message body; it
 * parses the group `!account` (the card's `group` field — no internal id), fetches the LIVE state via
 * /invite/detail (spinner while loading), and renders valid → Join (→ /invite/accept), already-joined →
 * Open group, expired, or invalid. The card carries inline display identity + the group's home domain (a
 * "Local server" label, or a globe + domain badge for a federated group). Mounted as a transient overlay
 * by {@link InviteDetailService}; its shared modal policy owns the backdrop/Escape lifecycle.
 *
 * Join flow: /invite/accept → nav.openChat(threadId). The nav state machine clears the pane stack, so
 * this dialog's entry is removed and the TransientOverlayService effect disposes the CDK overlay.
 */
@Component({
  selector: 'app-invite-detail',
  imports: [
    MatButtonModule,
    MatProgressSpinnerModule,
    UserAvatarComponent,
    FederatedBadgeComponent,
    IconComponent,
    TranslocoPipe,
  ],
  templateUrl: './invite-detail.component.html',
  styleUrl: './invite-detail.component.scss',
})
export class InviteDetailComponent implements OnInit, OnDestroy {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  /** Raw JSON body of the GROUP_INVITE message (set by InviteDetailService.open). */
  readonly raw = input<string>('');
  /** Emitted on X / Cancel — the overlay base also handles backdrop and Escape dismissal. */
  @Output() close = new EventEmitter<void>();

  private readonly userService = inject(UserService);
  private readonly nav = inject(NavStateMachineService);
  private readonly transloco = inject(TranslocoService);
  private readonly snackBar = inject(MatSnackBar);

  /** Fallback identity parsed from the card message (shown instantly while the detail loads). */
  readonly fallback = signal<{ groupName: string; groupAvatar?: string }>({
    groupName: '',
  });
  /** The invite-resolution key — the group `!account` parsed from the card (a BigInt id is NOT carried). */
  readonly inviteId = signal<string>('');
  readonly detail = signal<InviteDetail | null>(null);
  /** True when /invite/detail could not find the invite (→ "invalid" view). */
  readonly notFound = signal(false);
  readonly busy = signal(false);
  readonly errorMsg = signal('');

  readonly viewState = computed<ViewState>(() => {
    if (this.notFound()) return 'invalid';
    const d = this.detail();
    if (d === null) return 'loading';
    if (d.alreadyJoined) return 'joined';
    if (d.joinRequested) return 'requested';
    if (d.status !== 'PENDING') return 'invalid';
    if (Date.now() > d.expiresAt) return 'expired';
    return 'valid';
  });

  readonly groupName = computed(
    () => this.detail()?.groupName || this.fallback().groupName || '',
  );
  readonly groupAvatar = computed(
    () => this.detail()?.groupAvatar || this.fallback().groupAvatar,
  );

  /** Inviter display name — authoritative from /invite/detail (hidden while loading). */
  readonly inviterName = computed(() => this.detail()?.fromUser?.name ?? '');

  /** Positioning frame aligned to .chat-slot's rect so the card centers on the chat pane. */
  readonly frame = viewChild<ElementRef<HTMLElement>>('frame');

  constructor() {
    // Center on the chat pane once the frame renders, and play the enter animation.
    effect(() => {
      const f = this.frame();
      if (!f) return;
      this.positionFrame(f.nativeElement);
      this.playEnter(f.nativeElement.querySelector('.ivd-card'));
    });
    window.addEventListener('resize', this.onResize);
  }

  ngOnInit(): void {
    const parsed = this.parseRaw(this.raw());
    this.fallback.set({
      groupName: parsed.groupName,
      groupAvatar: parsed.groupAvatar,
    });
    this.inviteId.set(parsed.group ?? ''); // the group `!account` is the resolve key for /invite/detail + /invite/accept
    void this.loadDetail();
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  private async loadDetail(): Promise<void> {
    const id = this.inviteId();
    if (!id) {
      this.notFound.set(true);
      return;
    }
    const res = await firstValueFrom(
      this.userService.getInviteDetail({ inviteId: id }),
    );
    if (res.code === 0 && res.data) {
      this.detail.set(res.data);
      this.notFound.set(false);
    } else {
      // INVITE_NOT_FOUND (or any error) → invalid (the dialog shows "invite expired").
      this.notFound.set(true);
    }
  }

  private readonly onResize = (): void => {
    const f = this.frame();
    if (f) this.positionFrame(f.nativeElement);
  };

  private positionFrame(frame: HTMLElement): void {
    const slot = document.querySelector<HTMLElement>('.chat-slot');
    const r = slot
      ? slot.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    frame.style.top = `${r.top}px`;
    frame.style.left = `${r.left}px`;
    frame.style.width = `${r.width}px`;
    frame.style.height = `${r.height}px`;
  }

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

  /** Parse the GROUP_INVITE card body. `group` (the `!account`) is the resolve key; `from` is the inviter
   *  account; groupName/groupAvatar are inline display fallbacks. No internal ids on the card. */
  private parseRaw(raw: string): {
    groupName: string;
    groupAvatar?: string;
    from?: string;
    group?: string;
  } {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return {
        groupName: (o['groupName'] as string) ?? '',
        groupAvatar: o['groupAvatar'] as string | undefined,
        from: o['from'] as string | undefined,
        group: o['group'] as string | undefined,
      };
    } catch {
      return { groupName: '' };
    }
  }

  onClose(): void {
    this.close.emit();
  }

  async onJoin(): Promise<void> {
    if (this.busy() || this.viewState() !== 'valid') return;
    this.busy.set(true);
    this.errorMsg.set('');
    const threadId = this.detail()?.threadId;
    if (threadId == null) {
      this.busy.set(false);
      this.notFound.set(true);
      return;
    }
    const res = await firstValueFrom(
      this.userService.joinGroupRequest({ groupId: threadId }),
    );
    if (res.code !== 0) {
      this.busy.set(false);
      this.errorMsg.set(
        res.message || this.transloco.translate('chat.failedToJoin'),
      );
      // Re-fetch — the invite may now be expired/invalid.
      void this.loadDetail();
      return;
    }
    if (!this.detail()!.groupIsLocal) {
      this.snackBar.open(
        this.transloco.translate('chat.federatedJoinRequested'),
        undefined,
        { duration: 3500 },
      );
      await this.loadDetail();
      this.busy.set(false);
      return;
    }
    // A local-origin group confirms in this request, so it is safe to enter immediately.
    this.nav.openChat(threadId, 'group-joined');
  }

  /** Already joined → open the group. openChat clears the pane stack → overlay disposed. */
  async onOpen(): Promise<void> {
    const tid = this.detail()?.threadId;
    if (tid == null) return;
    this.nav.openChat(tid);
  }
}
