import { Component, computed, effect, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { ThreadAliasEditorComponent } from '../thread-alias-editor/thread-alias-editor.component';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ConversationItem, displayUserName } from '../../services/model';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';

/**
 * P2P (friend) profile panel — rendered in the `aside` auxiliary outlet (`chat/:threadId/(aside:profile)`).
 * Resolves its conversation from the parent route's `:threadId` + the shared list (no input binding
 * needed — the aside child route carries no params of its own). Surfaces Unfriend (delete-friend) and
 * Block/Unblock — the destructive actions use a two-step inline confirm (mutually exclusive); Unblock is
 * a single tap. On unfriend it drops the thread and returns to the conversation list, which closes both
 * the chat and this panel. A future custom-name/alias feature would also live here.
 */
@Component({
  selector: 'app-peer-profile',
  imports: [MatButtonModule, UserAvatarComponent, TranslocoPipe, ThreadAliasEditorComponent, FederatedBadgeComponent],
  template: `
    <div class="panel">
      <div class="msg-header">
        <button class="icon-btn" (click)="goBack()" [attr.aria-label]="'common.back' | transloco">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span class="title">{{ 'profile.title' | transloco }}</span>
        <span></span>
      </div>

      <div class="body">
        <div class="identity">
          <app-user-avatar [type]="UserAvatarType.OTHER" [name]="peer()?.name ?? ''" />
          <app-federated-badge [domain]="peerDomain()"></app-federated-badge>
          <div class="name">{{ peerDisplayName() }}</div>
        </div>

        <app-thread-alias-editor [threadId]="threadId()!" />

        @if (confirmUnfriend()) {
          <div class="confirm-row">
            <span>{{ 'profile.removeFriendConfirm' | transloco:{ name: peerDisplayName() } }}</span>
            <div class="confirm-actions">
              <button mat-stroked-button [disabled]="busy()" (click)="cancelUnfriend()">{{ 'common.cancel' | transloco }}</button>
              <button mat-flat-button color="warn" [disabled]="busy()" (click)="doUnfriend()">{{ 'profile.unfriend' | transloco }}</button>
            </div>
          </div>
        } @else {
          <button mat-stroked-button color="warn" class="unfriend-btn" [disabled]="busy()" (click)="askUnfriend()">{{ 'profile.unfriend' | transloco }}</button>
        }

        @if (blocked()) {
          <button mat-stroked-button class="block-btn" [disabled]="busy()" (click)="doUnblock()">{{ 'profile.unblock' | transloco }}</button>
        } @else if (confirmBlock()) {
          <div class="confirm-row">
            <span>{{ 'profile.blockConfirm' | transloco:{ name: peerDisplayName() } }}</span>
            <div class="confirm-actions">
              <button mat-stroked-button [disabled]="busy()" (click)="cancelBlock()">{{ 'common.cancel' | transloco }}</button>
              <button mat-flat-button color="warn" [disabled]="busy()" (click)="doBlock()">{{ 'profile.block' | transloco }}</button>
            </div>
          </div>
        } @else {
          <button mat-stroked-button color="warn" class="block-btn" [disabled]="busy()" (click)="askBlock()">{{ 'profile.block' | transloco }}</button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; background: var(--app-surface); }
    .panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
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
    .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; padding: 28px 16px; }
    .identity { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .identity app-user-avatar { width: 72px; height: 72px; }
    .name { font-size: 18px; font-weight: 600; }
    // Full-width destructive action — real mat-stroked-button color="warn" (red outline + text, Material
    // state layer on hover, disabled styling built in). Matches the confirm-state unfriend button below.
    .unfriend-btn { width: 100%; }
    .block-btn { width: 100%; }
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

  private readonly nav = inject(NavStateMachineService)
  private readonly userService = inject(UserService)
  private readonly convList = inject(ConversationListService)

  constructor() {
    // Federated catch-up at view time: when the panel opens over a FOREIGN friend, silently refresh the
    // stub in the background — probe the peer /revision and re-localize avatar/name/bio only if newer
    // (all the heavy work is server-side). Fire-and-forget; the returned User flows back through
    // updatePeerUser and this panel's computed `peer` refreshes. Local peers are already kept fresh by
    // the chat-open probe + the PEER_PROFILE_UPDATED push, so this probe is federated-only. The server's
    // sinceUpdatedAt short-circuit keeps it from re-rendering: the in-flight refresh updates peer(), the
    // effect re-runs once, the next probe returns data:null, and it settles.
    effect(() => {
      const p = this.peer()
      const tid = this.threadId()
      if (!p || !p.isForeigner || tid === undefined) return
      this.userService
        .syncPeerProfile({ userId: p.id, sinceUpdatedAt: p.updatedAt })
        .subscribe({
          next: (res) => {
            if (res.code === 0 && res.data) this.convList.updatePeerUser(tid, res.data)
          },
          error: () => {
            /* best-effort — keep the cached profile on a transient peer outage */
          },
        })
    })
  }

  readonly busy = signal(false)
  /** Two-step destructive confirm gate for Unfriend. */
  readonly confirmUnfriend = signal(false)
  /** Two-step destructive confirm gate for Block (mirrors confirmUnfriend; mutually exclusive with it —
   *  starting one cancels the other so at most one confirm-row is ever visible). */
  readonly confirmBlock = signal(false)

  /** The panel is open over the currently-viewed chat — read its id + item from the shared list. */
  readonly threadId = this.convList.openThreadId
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.threadId()
    return id !== undefined ? this.convList.items().find((t) => t.threadId === id) : undefined
  })
  readonly peer = computed(() => this.userMsgTrd()?.peerUser)
  /** Display label for the peer — the nickname. The federated domain (if any) is shown via the badge
   *  directly under the avatar, not folded into the name. */
  readonly peerDisplayName = computed(() => {
    const p = this.peer();
    return p ? displayUserName(p) : '';
  })
  /** The peer's domain when federated, else null (the badge self-hides). */
  readonly peerDomain = computed(() => {
    const p = this.peer();
    return p && p.isForeigner ? p.domain : null;
  })
  /** Whether the caller has blocked this peer (hydrated on the conversation item by the backend's batched
   *  UserBlock lookup). Drives the Block ↔ Unblock label; patched in place by applyThreadMeta on toggle. */
  readonly blocked = computed(() => this.userMsgTrd()?.blocked ?? false)

  askUnfriend() {
    this.confirmBlock.set(false)
    this.confirmUnfriend.set(true)
  }
  cancelUnfriend() { this.confirmUnfriend.set(false) }
  askBlock() {
    this.confirmUnfriend.set(false)
    this.confirmBlock.set(true)
  }
  cancelBlock() { this.confirmBlock.set(false) }

  doUnfriend() {
    const peer = this.peer()
    const threadId = this.threadId()
    if (!peer || threadId === undefined) return
    this.busy.set(true)
    this.userService.deleteFriend({ userId: peer.id }).subscribe({
      next: (res) => {
        this.busy.set(false)
        if (res.code !== 0) return // keep the panel + confirm visible so a server-side failure is observable
        // Drop the now-deleted thread, then return to the list — navigating to '/' closes both the chat
        // (primary outlet) and this panel (aside outlet) in one step.
        this.convList.removeThread(threadId)
        this.nav.closeChat()
      },
      error: () => this.busy.set(false),
    })
  }

  /** Block the peer (two-step confirmed). Patches the conversation item's `blocked` flag in place via
   *  applyThreadMeta so the chat-header menu + blocked banner flip immediately; the panel stays open. */
  doBlock() {
    const peer = this.peer()
    const threadId = this.threadId()
    if (!peer || threadId === undefined) return
    this.busy.set(true)
    this.userService.setBlock({ userId: peer.id, block: true }).subscribe({
      next: (res) => {
        this.busy.set(false)
        if (res.code !== 0) return
        this.convList.applyThreadMeta(threadId, { blocked: true })
        this.confirmBlock.set(false)
      },
      error: () => this.busy.set(false),
    })
  }

  /** Unblock the peer (single tap — non-destructive, no confirm). */
  doUnblock() {
    const peer = this.peer()
    const threadId = this.threadId()
    if (!peer || threadId === undefined) return
    this.busy.set(true)
    this.userService.setBlock({ userId: peer.id, block: false }).subscribe({
      next: (res) => {
        this.busy.set(false)
        if (res.code !== 0) return
        this.convList.applyThreadMeta(threadId, { blocked: false })
      },
      error: () => this.busy.set(false),
    })
  }

  /** Close the aside (back to the chat). Clears the aside signal — back won't re-open it. */
  goBack() {
    this.nav.closeAside()
  }
}
