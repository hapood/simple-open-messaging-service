import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, finalize } from 'rxjs';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import { ThreadAliasEditorComponent } from '../thread-alias-editor/thread-alias-editor.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  ConversationItem,
  displayUserAccount,
  displayUserName,
} from '../../services/model';
import { UserService } from '../../services/user.service';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { PopupType, RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { ContactCardShareService } from '../../services/contact-card-share.service';
import { FocusedInputRevealDirective } from '../../directives/focused-input-reveal.directive';
import { conversationAvatarProfile } from '../../services/avatar-profile-ref';

/**
 * P2P (friend) profile panel — rendered in the `aside` auxiliary outlet (`chat/:threadId/(aside:profile)`).
 * Resolves its conversation from the parent route's `:threadId` + the shared list (no input binding
 * needed — the aside child route carries no params of its own). It is the complete P2P details surface:
 * conversation actions follow the identity section, while relationship and destructive actions remain
 * visually separated below them.
 */
@Component({
  selector: 'app-peer-profile',
  imports: [
    DemandAvatarComponent,
        TranslocoPipe,
    ThreadAliasEditorComponent,
    MatCardModule,
    MatButtonModule,
    MatSlideToggleModule,
    IconComponent,
    PageHeaderComponent,
    FocusedInputRevealDirective,
  ],
  template: `
    <div class="panel">
      <app-page-header [title]="'profile.title' | transloco" (back)="goBack()">
        @if (!friendshipEnded()) {
          <button
            pageHeaderAction
            class="share-action"
            type="button"
            (click)="shareContact()"
            [attr.aria-label]="'profile.shareCardAria' | transloco"
            [title]="'profile.shareCardAria' | transloco"
          >
            <app-icon
              [type]="AppIconType.SHARE"
              [style]="{ width: '18px', height: '18px' }"
            />
            <span>{{ 'profile.share' | transloco }}</span>
          </button>
        }
      </app-page-header>

      <div class="body" appFocusedInputReveal>
        @if (peer(); as identity) {
          <div class="identity">
            <span class="profile-avatar">
              <app-demand-avatar
                [type]="UserAvatarType.OTHER"
                [name]="identity.name"
                [account]="identity.account"
                [profile]="peerProfileRef()"
                [domainSource]="{ type: 'namespace', namespaceId: identity.namespaceId }"
              />
            </span>
          </div>
        }

        <mat-card appearance="outlined" class="peer-profile-card">
          <div class="profile-meta">{{ peerAccount() }}</div>
          <div class="peer-profile-row">
            <span class="profile-copy">
              <strong>{{ peerDisplayName() }}</strong>
              <span class="description">{{
                peer()?.bio || ('friend.noBio' | transloco)
              }}</span>
            </span>
          </div>
        </mat-card>

        @if (!friendshipEnded()) {
          <app-thread-alias-editor [threadId]="threadId()!" />
        }

        <mat-card appearance="outlined" class="conversation-actions">
          <button type="button" class="action-row" (click)="openSearch()">
            <span class="action-icon" aria-hidden="true">
              <app-icon
                [type]="AppIconType.SEARCH"
                [style]="{ width: '20px', height: '20px' }"
              />
            </span>
            <span class="action-label">{{
              'chat.menuSearch' | transloco
            }}</span>
            <app-icon
              class="action-chevron"
              [type]="AppIconType.CHEVRON_RIGHT"
              [style]="{ width: '18px', height: '18px' }"
            />
          </button>
          <div class="action-row">
            <span class="action-icon" aria-hidden="true">
              <app-icon
                [type]="AppIconType.MUTE"
                [style]="{ width: '20px', height: '20px' }"
              />
            </span>
            <span class="action-label">{{ 'chat.menuMute' | transloco }}</span>
            <mat-slide-toggle
              [checked]="userMsgTrd()?.muted === true"
              [disabled]="mutedSaving()"
              [attr.aria-label]="'chat.menuMute' | transloco"
              (change)="setMuted($event.checked)"
            />
          </div>
          <div class="action-row">
            <span class="action-icon" aria-hidden="true">
              <app-icon
                [type]="AppIconType.PIN"
                [style]="{ width: '20px', height: '20px' }"
              />
            </span>
            <span class="action-label">{{ 'chat.menuPin' | transloco }}</span>
            <mat-slide-toggle
              [checked]="userMsgTrd()?.pinned === true"
              [disabled]="pinnedSaving()"
              [attr.aria-label]="'chat.menuPin' | transloco"
              (change)="setPinned($event.checked)"
            />
          </div>
        </mat-card>

        @if (!friendshipEnded()) {
          <mat-card
            appearance="outlined"
            class="permission-card block-card"
            [class.on]="blockedControl()"
          >
            <span
              class="block-icon"
              [class.on]="blockedControl()"
              aria-hidden="true"
            >
              <app-icon
                [type]="AppIconType.BLOCK"
                [style]="{ width: '20px', height: '20px' }"
              />
            </span>
            <span class="permission-copy">
              <strong>{{ 'profile.block' | transloco }}</strong>
            </span>
            <mat-slide-toggle
              class="danger-switch"
              [checked]="blockedControl()"
              [class.saving]="blockedSaving()"
              [disabled]="unfriendPending()"
              [attr.aria-busy]="blockedSaving()"
              [attr.aria-label]="'profile.block' | transloco"
              (change)="setBlocked($event.checked)"
            />
          </mat-card>

          <div class="relationship-actions">
            <button
              mat-button
              color="warn"
              class="danger"
              type="button"
              (click)="removeFriend()"
              [disabled]="relationshipActionPending()"
            >
              <span>{{ 'chat.menuUnfriend' | transloco }}</span>
            </button>
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
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
      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 12px 0 calc(24px + var(--focused-input-keyboard-inset, 0px));
      }
      .share-action {
        height: 40px;
        padding: 0 8px;
        border: 0;
        border-radius: var(--app-radius-sm);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: transparent;
        color: var(--app-brand);
        font-size: 14px;
        line-height: 20px;
        cursor: pointer;
      }
      .share-action:hover {
        background: var(--app-hover);
      }
      .share-action:focus-visible {
        outline: 2px solid var(--app-brand);
        outline-offset: -2px;
      }
      .identity {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 8px 16px 12px;
      }
      .identity app-demand-avatar {
        width: 72px;
        height: 72px;
      }
      .profile-avatar {
        position: relative;
        display: block;
        width: 72px;
        height: 72px;
      }
      .peer-profile-card {
        margin: 0 16px 12px;
        overflow: hidden;
      }
      .profile-meta {
        height: 24px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        border-bottom: 1px solid var(--app-border);
        background: var(--app-surface-subtle);
        color: var(--app-text-muted);
        font-size: 11px;
        font-weight: var(--app-font-weight-medium, 500);
        line-height: 16px;
        letter-spacing: 0.02em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .peer-profile-row {
        min-height: 72px;
        padding: 12px 14px;
        display: flex;
        align-items: center;
        box-sizing: border-box;
      }
      .profile-copy {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .profile-copy strong {
        color: var(--app-text);
        font-size: 16px;
        font-weight: var(--app-font-weight-medium, 500);
        line-height: 24px;
        overflow-wrap: anywhere;
      }
      .profile-copy .description {
        color: var(--app-text-muted);
        font-size: 14px;
        font-weight: var(--app-font-weight-regular, 400);
        line-height: 20px;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .permission-card {
        margin: 18px 16px 0;
        padding: 12px 14px;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
      }
      .conversation-actions {
        margin: 18px 16px 0;
        overflow: hidden;
      }
      .action-row {
        width: 100%;
        min-height: 52px;
        padding: 6px 14px;
        border: 0;
        border-bottom: 1px solid var(--app-border);
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 12px;
        background: transparent;
        color: var(--app-text);
        font: inherit;
        text-align: left;
      }
      .action-row:last-child {
        border-bottom: 0;
      }
      button.action-row {
        cursor: pointer;
      }
      button.action-row:hover {
        background: var(--app-hover);
      }
      button.action-row:focus-visible {
        outline: 2px solid var(--app-brand);
        outline-offset: -2px;
      }
      .action-icon {
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
        display: grid;
        place-items: center;
        color: var(--app-text-muted);
      }
      .action-label {
        min-width: 0;
        flex: 1 1 auto;
        font-size: 14px;
        line-height: 20px;
      }
      .action-chevron {
        margin-left: auto;
        color: var(--app-text-muted);
      }
      .permission-copy {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
      }
      .permission-copy strong {
        color: var(--app-text);
        font-size: 14px;
        font-weight: var(--app-font-weight-regular, 400);
        line-height: 20px;
      }
      .block-card.on .permission-copy strong {
        color: var(--app-danger);
      }
      .block-icon {
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
        display: grid;
        place-items: center;
        color: var(--app-text-muted);
      }
      .block-icon.on {
        color: var(--app-danger);
      }
      mat-slide-toggle.saving {
        pointer-events: none;
      }
      .danger-switch {
        --mat-slide-toggle-selected-track-color: var(--app-danger);
        --mat-slide-toggle-selected-focus-track-color: var(--app-danger);
        --mat-slide-toggle-selected-hover-track-color: color-mix(
          in srgb,
          var(--app-danger) 86%,
          black
        );
        --mat-slide-toggle-selected-pressed-track-color: var(--app-danger);
        --mat-slide-toggle-selected-focus-state-layer-color: var(--app-danger);
        --mat-slide-toggle-selected-hover-state-layer-color: var(--app-danger);
        --mat-slide-toggle-selected-pressed-state-layer-color: var(
          --app-danger
        );
      }
      .relationship-actions {
        margin: 12px 16px 0;
        display: flex;
        flex-direction: column;
        align-items: stretch;
      }
      .relationship-actions > button {
        width: 100%;
        height: 48px;
        justify-content: center;
        padding: 0 12px;
        text-align: center;
      }
    `,
  ],
})
export class PeerProfileComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly AppIconType = AppIconType;
  readonly blockedControl = signal(false);
  readonly blockedSaving = signal(false);
  readonly unfriendPending = signal(false);
  readonly mutedSaving = signal(false);
  readonly pinnedSaving = signal(false);
  readonly relationshipActionPending = computed(
    () => this.blockedSaving() || this.unfriendPending(),
  );

  private readonly nav = inject(NavStateMachineService);
  private readonly convList = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly route = inject(RouteService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  private readonly contactCardShare = inject(ContactCardShareService);

  /** The panel is open over the currently-viewed chat — read its id + item from the shared list. */
  readonly threadId = this.convList.openThreadId;
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.threadId();
    return id !== undefined
      ? this.convList.items().find((t) => t.threadId === id)
      : undefined;
  });
  readonly peerProfileRef = computed(() => {
    const thread = this.userMsgTrd();
    return thread ? conversationAvatarProfile(thread) : undefined;
  });
  readonly peer = computed(() => this.userMsgTrd()?.peerUser);
  readonly friendshipEnded = computed(
    () =>
      this.userMsgTrd()?.friendshipActive === false ||
      this.userMsgTrd()?.conversationState === 'READ_ONLY',
  );
  /** Display label for the peer — the nickname, with federation indicated on the avatar. */
  readonly peerDisplayName = computed(() => {
    const p = this.peer();
    return p ? displayUserName(p) : '';
  });
  readonly peerAccount = computed(() => {
    const p = this.peer();
    return p ? displayUserAccount(p) : '';
  });

  constructor() {
    effect(() => {
      const blocked = this.userMsgTrd()?.blocked === true;
      if (!this.blockedSaving())
        untracked(() => this.blockedControl.set(blocked));
    });
  }

  /** Close the aside (back to the chat). Clears the aside signal — back won't re-open it. */
  goBack() {
    this.nav.closeAside();
  }

  shareContact(): void {
    if (this.friendshipEnded()) return;
    const trd = this.userMsgTrd();
    if (trd) this.contactCardShare.open(trd);
  }

  openSearch(): void {
    this.nav.closeAside();
    this.nav.openSearch();
  }

  setMuted(muted: boolean): void {
    const trd = this.userMsgTrd();
    if (!trd || this.mutedSaving()) return;
    const previous = trd.muted;
    this.convList.applyThreadMeta(trd.threadId, { muted });
    this.mutedSaving.set(true);
    this.threadAdapter
      .setMuted({ threadId: trd.threadId, muted })
      .pipe(finalize(() => this.mutedSaving.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code === 0) return;
          this.convList.applyThreadMeta(trd.threadId, { muted: previous });
          this.toast.warn(translateBizResult(res, this.transloco));
        },
        error: () => {
          this.convList.applyThreadMeta(trd.threadId, { muted: previous });
          this.toast.warn(this.transloco.translate('errors.networkError'));
        },
      });
  }

  setPinned(pinned: boolean): void {
    const trd = this.userMsgTrd();
    if (!trd || this.pinnedSaving()) return;
    const previous = trd.pinned;
    const previousPinnedAt = trd.pinnedAt;
    this.convList.applyThreadMeta(trd.threadId, {
      pinned,
      pinnedAt: pinned ? Date.now() : null,
    });
    this.pinnedSaving.set(true);
    this.threadAdapter
      .setPinned({ threadId: trd.threadId, pinned })
      .pipe(finalize(() => this.pinnedSaving.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code === 0) return;
          this.convList.applyThreadMeta(trd.threadId, {
            pinned: previous,
            pinnedAt: previousPinnedAt,
          });
          this.toast.warn(translateBizResult(res, this.transloco));
        },
        error: () => {
          this.convList.applyThreadMeta(trd.threadId, {
            pinned: previous,
            pinnedAt: previousPinnedAt,
          });
          this.toast.warn(this.transloco.translate('errors.networkError'));
        },
      });
  }

  setBlocked(blocked: boolean): void {
    const trd = this.userMsgTrd();
    if (!trd || this.friendshipEnded() || this.relationshipActionPending())
      return;
    const previous = trd.blocked === true;
    this.blockedControl.set(blocked);
    this.blockedSaving.set(true);
    this.threadAdapter
      .setBlocked({ threadId: trd.threadId, blocked })
      .pipe(finalize(() => this.blockedSaving.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) {
            this.blockedControl.set(previous);
            return this.toast.warn(translateBizResult(res, this.transloco));
          }
          this.convList.applyThreadMeta(trd.threadId, { blocked });
        },
        error: () => {
          this.blockedControl.set(previous);
          this.toast.warn(this.transloco.translate('errors.networkError'));
        },
      });
  }

  removeFriend(): void {
    const trd = this.userMsgTrd();
    const peer = trd?.peerUser;
    if (
      !trd ||
      !peer ||
      this.friendshipEnded() ||
      this.relationshipActionPending()
    )
      return;
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.unfriendConfirmTitle',
        messageKey: 'chat.unfriendConfirmBody',
        confirmKey: 'chat.menuUnfriend',
        cancelKey: 'common.cancel',
        danger: true,
      },
      (result) => {
        if (!result) return;
        void this.finishRemoveFriend(trd);
      },
    );
  }

  private async finishRemoveFriend(trd: ConversationItem) {
    if (this.unfriendPending()) return;
    this.unfriendPending.set(true);
    try {
      const res = await firstValueFrom(
        this.userService.revokeRelationship({ threadId: trd.threadId }),
      );
      if (res.code !== 0)
        return this.toast.warn(translateBizResult(res, this.transloco));
      this.convList.applyThreadMeta(trd.threadId, {
        friendshipActive: false,
        conversationState: 'READ_ONLY',
      });
      this.nav.closeAside();
    } catch {
      this.toast.warn(this.transloco.translate('errors.networkError'));
    } finally {
      this.unfriendPending.set(false);
      this.convList.load();
    }
  }
}
