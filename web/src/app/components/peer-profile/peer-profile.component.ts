import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import { ConversationItem } from '../../services/model';

/**
 * P2P (friend) profile panel — the one-to-one analog of GroupInfoComponent. Dual-host like
 * group-info: the desktop InfoPaneComponent embeds it in the side panel (closeFn closes the panel),
 * and mobile opens it as a stacked popup (PopupType.PEER_PROFILE) from the chat header.
 *
 * Surfaces the friendship-management action the backend already supported but the UI lacked —
 * Unfriend (delete-friend). The two-step inline confirm mirrors group-info's confirmAction. A future
 * custom-name/alias feature would also live here (set + display), which is why this is its own
 * component rather than inline markup in the info pane.
 */
@Component({
  selector: 'app-peer-profile',
  imports: [MatButtonModule, UserAvatarComponent, FitDialogDirective],
  template: `
    <div [appFitDialog]="fitOpts">
      <div class="msg-header">
        <button class="icon-btn" (click)="goBack()" aria-label="Back">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span class="title">Profile</span>
        <span></span>
      </div>

      <div class="body">
        <div class="identity">
          <app-user-avatar [type]="UserAvatarType.OTHER" [name]="peer()?.uniqName ?? ''" />
          <div class="name">{{ peer()?.uniqName }}</div>
        </div>

        @if (confirmUnfriend()) {
          <div class="confirm-row">
            <span>Remove {{ peer()?.uniqName }} from friends?</span>
            <div class="confirm-actions">
              <button mat-stroked-button [disabled]="busy()" (click)="cancelUnfriend()">Cancel</button>
              <button mat-raised-button color="warn" [disabled]="busy()" (click)="doUnfriend()">Unfriend</button>
            </div>
          </div>
        } @else {
          <button class="danger" [disabled]="busy()" (click)="askUnfriend()">Unfriend</button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .msg-header {
      height: 56px; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 0 8px;
      border-bottom: 1px solid var(--app-border); box-sizing: border-box;
    }
    .msg-header .title { font-size: 16px; font-weight: 600; flex: 1 1 auto; }
    .icon-btn {
      display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
      border: none; background: transparent; color: var(--app-text); cursor: pointer;
      border-radius: var(--app-radius-sm);
    }
    .icon-btn:hover { background: var(--app-hover); }
    .body { display: flex; flex-direction: column; gap: 20px; padding: 28px 16px; }
    .identity { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .identity app-user-avatar { width: 72px; height: 72px; }
    .name { font-size: 18px; font-weight: 600; }
    .danger {
      width: 100%; height: 40px; border: 1px solid var(--app-border-strong); background: var(--app-surface);
      color: #e53935; border-radius: var(--app-radius-md); cursor: pointer; font-size: 14px;
    }
    .danger:hover { background: var(--app-hover); }
    .danger:disabled { color: var(--app-text-faint); cursor: default; }
    .confirm-row {
      display: flex; flex-direction: column; gap: 12px; padding: 14px;
      border: 1px solid var(--app-border-strong); border-radius: var(--app-radius-md);
      background: var(--app-bg-muted);
    }
    .confirm-row > span { font-size: 14px; }
    .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  `],
})
export class PeerProfileComponent {
  readonly UserAvatarType = UserAvatarType
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const

  /** The P2P conversation this profile describes. */
  readonly userMsgTrd = input<ConversationItem>()
  /** Optional close handler; when set (desktop panel host), goBack() calls it instead of closeDlg. */
  readonly closeFn = input<(() => void) | undefined>(undefined)

  private readonly userService = inject(UserService)
  private readonly convList = inject(ConversationListService)
  private readonly routeService = inject(RouteService)

  readonly busy = signal(false)
  /** Two-step destructive confirm gate for Unfriend (mirrors group-info's confirmAction). */
  readonly confirmUnfriend = signal(false)

  readonly peer = computed(() => this.userMsgTrd()?.peerUser)
  readonly threadId = computed(() => this.userMsgTrd()?.threadId)

  askUnfriend() { this.confirmUnfriend.set(true) }
  cancelUnfriend() { this.confirmUnfriend.set(false) }

  doUnfriend() {
    const peer = this.peer()
    const threadId = this.threadId()
    if (!peer || threadId === undefined) return
    this.busy.set(true)
    this.userService.deleteFriend({ userId: peer.id }).subscribe({
      next: (res) => {
        this.busy.set(false)
        if (res.code !== 0) return // keep the panel + confirm visible so a server-side failure is observable
        // Drop the now-deleted thread from the shared list (instant removal + clears openThreadId),
        // then close the profile. The desktop chat pane empties via desktop-home's openThreadId effect.
        this.convList.removeThread(threadId)
        this.goBack()
      },
      error: () => this.busy.set(false),
    })
  }

  goBack() {
    const fn = this.closeFn()
    if (fn) fn()
    else this.routeService.closeDlg()
  }
}
