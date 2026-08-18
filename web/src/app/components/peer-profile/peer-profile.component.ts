import { Component, computed, inject } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { ThreadAliasEditorComponent } from '../thread-alias-editor/thread-alias-editor.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ConversationItem, displayUserName } from '../../services/model';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { UserService } from '../../services/user.service';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { PopupType, RouteService } from '../../services/route.service';
import { ThreadDeletionLockService } from '../../services/thread-deletion-lock.service';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';

/**
 * P2P (friend) profile panel — rendered in the `aside` auxiliary outlet (`chat/:threadId/(aside:profile)`).
 * Resolves its conversation from the parent route's `:threadId` + the shared list (no input binding
 * needed — the aside child route carries no params of its own). Relationship actions intentionally live
 * here, grouped in one quiet action card instead of competing with everyday chat controls.
 */
@Component({
  selector: 'app-peer-profile',
  imports: [
    UserAvatarComponent,
    TranslocoPipe,
    ThreadAliasEditorComponent,
    FederatedBadgeComponent,
  ],
  template: `
    <div class="panel">
      <div class="msg-header">
        <button
          class="icon-btn"
          (click)="goBack()"
          [attr.aria-label]="'common.back' | transloco"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span class="title">{{ 'profile.title' | transloco }}</span>
        <span></span>
      </div>

      <div class="body">
        <div class="identity">
          <app-user-avatar
            [type]="UserAvatarType.OTHER"
            [name]="peer()?.name ?? ''"
            [identityId]="peer()?.id"
            [src]="peer()?.avatar"
          />
          <app-federated-badge [domain]="peerDomain()"></app-federated-badge>
          <div class="name">{{ peerDisplayName() }}</div>
          @if (peer()?.account) {
            <div class="account">
              {{ 'profile.account' | transloco }} · {{ peer()!.account }}
              @if (peerDomain()) {
                &#64;{{ peerDomain() }}
              }
            </div>
          }
          @if (peer()?.bio) {
            <div class="bio">{{ peer()?.bio }}</div>
          }
        </div>

        <app-thread-alias-editor [threadId]="threadId()!" />

        <section
          class="relationship-card"
          [attr.aria-label]="'profile.relationship' | transloco"
        >
          <button
            class="relationship-action"
            type="button"
            (click)="toggleBlocked()"
          >
            <span class="action-icon" aria-hidden="true">⊘</span>
            <span class="action-copy">
              <strong>{{
                (userMsgTrd()?.blocked ? 'profile.unblock' : 'profile.block')
                  | transloco
              }}</strong>
              <small>{{ 'profile.blockHint' | transloco }}</small>
            </span>
          </button>
          @if (userMsgTrd()?.friendshipActive !== false) {
            <button
              class="relationship-action danger"
              type="button"
              (click)="removeFriend()"
            >
              <span class="action-icon" aria-hidden="true">−</span>
              <span class="action-copy">
                <strong>{{ 'chat.menuUnfriend' | transloco }}</strong>
                <small>{{ 'profile.unfriendHint' | transloco }}</small>
              </span>
            </button>
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        background: var(--app-surface);
      }
      .panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
      }
      .msg-header {
        height: 56px;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 8px;
        border-bottom: 1px solid var(--app-border);
        box-sizing: border-box;
      }
      .msg-header .title {
        font-size: 16px;
        font-weight: 600;
        flex: 1 1 auto;
      }
      .icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border: none;
        background: transparent;
        color: var(--app-text);
        cursor: pointer;
        border-radius: var(--app-radius-sm);
      }
      .icon-btn:hover {
        background: var(--app-hover);
      }
      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
        padding: 28px 16px;
      }
      .identity {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
      }
      .identity app-user-avatar {
        width: 72px;
        height: 72px;
      }
      .name {
        font-size: 18px;
        font-weight: 600;
      }
      .bio {
        max-width: 320px;
        color: var(--app-text-muted);
        font-size: 13px;
        line-height: 19px;
        text-align: center;
      }
      .account {
        color: var(--app-text-muted);
        font-size: 13px;
        line-height: 19px;
        overflow-wrap: anywhere;
        text-align: center;
      }
      .relationship-card {
        overflow: hidden;
        border: 1px solid var(--app-border);
        border-radius: var(--app-radius-lg, 14px);
        background: var(--app-surface);
      }
      .relationship-action {
        width: 100%;
        min-height: 64px;
        padding: 10px 14px;
        border: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        text-align: left;
        color: var(--app-text);
        background: transparent;
        cursor: pointer;
      }
      .relationship-action + .relationship-action {
        border-top: 1px solid var(--app-border);
      }
      .relationship-action:hover {
        background: var(--app-hover);
      }
      .action-icon {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        border-radius: 10px;
        background: var(--app-bg-muted);
        color: var(--app-text-muted);
        font-size: 20px;
      }
      .action-copy {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .action-copy strong {
        font-size: 14px;
        font-weight: 600;
      }
      .action-copy small {
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 17px;
      }
      .relationship-action.danger strong {
        color: var(--app-danger, #c73535);
      }
      .relationship-action.danger .action-icon {
        color: var(--app-danger, #c73535);
        background: color-mix(
          in srgb,
          var(--app-danger, #c73535) 10%,
          transparent
        );
      }
    `,
  ],
})
export class PeerProfileComponent {
  readonly UserAvatarType = UserAvatarType;

  private readonly nav = inject(NavStateMachineService);
  private readonly convList = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly route = inject(RouteService);
  private readonly deletionLock = inject(ThreadDeletionLockService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);

  /** The panel is open over the currently-viewed chat — read its id + item from the shared list. */
  readonly threadId = this.convList.openThreadId;
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.threadId();
    return id !== undefined
      ? this.convList.items().find((t) => t.threadId === id)
      : undefined;
  });
  readonly peer = computed(() => this.userMsgTrd()?.peerUser);
  /** Display label for the peer — the nickname. The federated domain (if any) is shown via the badge
   *  directly under the avatar, not folded into the name. */
  readonly peerDisplayName = computed(() => {
    const p = this.peer();
    return p ? displayUserName(p) : '';
  });
  /** The peer's domain when federated, else null (the badge self-hides). */
  readonly peerDomain = computed(() => {
    const p = this.peer();
    return p && p.isForeigner ? p.domain : null;
  });

  /** Close the aside (back to the chat). Clears the aside signal — back won't re-open it. */
  goBack() {
    this.nav.closeAside();
  }

  toggleBlocked(): void {
    const trd = this.userMsgTrd();
    if (!trd) return;
    const next = !trd.blocked;
    const apply = () => {
      this.threadAdapter
        .setBlocked({ threadId: trd.threadId, blocked: next })
        .subscribe({
          next: (res) => {
            if (res.code !== 0)
              return this.toast.warn(translateBizResult(res, this.transloco));
            this.convList.applyThreadMeta(trd.threadId, { blocked: next });
          },
          error: () =>
            this.toast.warn(this.transloco.translate('errors.networkError')),
        });
    };
    if (!next) return apply();
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'profile.block',
        messageKey: 'profile.blockConfirm',
        confirmKey: 'profile.block',
        cancelKey: 'common.cancel',
        danger: false,
        messageParams: { name: this.peerDisplayName() },
      },
      (result) => {
        if (result) apply();
      },
    );
  }

  removeFriend(): void {
    const trd = this.userMsgTrd();
    const peerId = trd?.peerUser?.id;
    if (!trd || peerId === undefined) return;
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.unfriendConfirmTitle',
        messageKey: 'chat.unfriendConfirmBody',
        confirmKey: 'chat.menuUnfriend',
        cancelKey: 'common.cancel',
        checkboxKey: 'chat.alsoDeleteData',
        danger: true,
      },
      (result) => {
        if (!result) return;
        const deleteData = typeof result === 'object' && result.checked;
        void this.finishRemoveFriend(trd, peerId, deleteData);
      },
    );
  }

  private async finishRemoveFriend(
    trd: ConversationItem,
    peerId: number,
    deleteData: boolean,
  ) {
    if (!this.deletionLock.begin(trd.threadId)) return;
    try {
      const res = await firstValueFrom(
        this.userService.deleteFriend({ userId: peerId, deleteData }),
      );
      if (res.code !== 0)
        return this.toast.warn(translateBizResult(res, this.transloco));
      if (deleteData) {
        await this.convList.removeThread(trd.threadId);
        this.nav.closeChat();
      } else {
        this.convList.applyThreadMeta(trd.threadId, {
          friendshipActive: false,
          conversationState: 'READ_ONLY',
        });
        this.nav.closeAside();
      }
    } catch {
      this.toast.warn(this.transloco.translate('errors.networkError'));
    } finally {
      this.deletionLock.end(trd.threadId);
      this.convList.load();
    }
  }
}
