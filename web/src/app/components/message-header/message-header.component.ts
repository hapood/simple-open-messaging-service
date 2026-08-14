import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import {
  ChatActionMenuComponent,
  ChatMenuEntry,
} from '../chat-action-menu/chat-action-menu.component';
import { MessageSearchComponent } from '../message-search/message-search.component';
import { ConversationItem, displayUserName } from '../../services/model';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { LayoutService } from '../../services/layout.service';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService, PopupType } from '../../services/route.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { CallAdapterService } from '../../services/call-adapter';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { uuid } from '../../lib/uuid';
import { TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { ToastService } from '../../services/toast.service';
import { ThreadDeletionLockService } from '../../services/thread-deletion-lock.service';
import { firstValueFrom } from 'rxjs';

/**
 * Chat surface header: back (mobile), the thread title (tap → peer-profile / group-info aside), and
 * the top-right MORE button, which opens a {@link ChatActionMenuComponent} anchored CDK overlay with
 * the full per-thread action set (view info, search, mute, pin, clear; P2P: block,
 * delete; GROUP: leave). System settings is NOT here — it lives in the global nav
 * (icon-rail / nav-drawer), not a per-thread context menu.
 *
 * Destructive actions use a two-tap inline confirm driven by swapping the menu's entry list (no separate
 * confirm dialog) — EXCEPT clear history, whose irreversibility warrants an unmissable app-level modal
 * ({@link PopupType.CONFIRM}) with a danger-styled warning. Mute / pin apply optimistically to the
 * conversation list (via applyThreadMeta) and the durable state delta re-confirms idempotently.
 * Actions that affect the shell (clear history / delete / leave → navigate away) or conversation state
 * (block → banner) are applied through their owning services.
 */
@Component({
  selector: 'app-message-header',
  imports: [
    IconComponent,
    ChatActionMenuComponent,
    OverlayModule,
    TranslocoModule,
    FederatedBadgeComponent,
    MessageSearchComponent,
  ],
  templateUrl: './message-header.component.html',
  styleUrl: './message-header.component.scss',
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType;
  readonly userMsgTrd = input<ConversationItem>();
  /** The current thread's id, fed to the embedded search field. Derived from userMsgTrd. */
  readonly threadId = computed(() => this.userMsgTrd()?.threadId ?? 0);

  /** Emits a message seq to center the kernel on (the parent owns the kernel + calls scrollToIndex). */
  readonly searchJump = output<number>();
  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);
  private readonly msgService = inject(MsgService);
  private readonly userService = inject(UserService);
  private readonly groupService = inject(GroupService);
  private readonly convList = inject(ConversationListService);
  private readonly routeService = inject(RouteService);
  private readonly callAdapter = inject(CallAdapterService);
  private readonly avatarRepo = inject(AvatarRepository);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly deletionLock = inject(ThreadDeletionLockService);

  /** Whether the call button shows: 1:1 calling is supported (Android native only — web/desktop calling is
   *  deferred) AND this is a P2P thread (groups can't be called 1:1). */
  readonly canCall = computed(() => {
    const trd = this.userMsgTrd();
    return (
      this.callAdapter.supported &&
      trd?.type === 'P2P' &&
      trd.friendshipActive !== false
    );
  });

  /** Place an outgoing audio-first call to the P2P peer. Video is enabled from the shared in-call UI instead
   *  of being a second chat-header entry point. Mints a client-side callSid (the call's idempotency
   *  key + signaling address — a UUIDv4, accepted by CALL_SID_RE) and hands it to the native call layer, which
   *  POSTs /calls/initiate + creates the offer. The peer's avatar is read from the IDB cache + passed as a
   *  base64 data URL so the native call notification (CallStyle Person) decodes it directly — NO /uploads
   *  fetch (the bytes are already on-device; the caller is in the peer's thread, so the avatar is cached). */
  async placeCall(): Promise<void> {
    const peer = this.userMsgTrd()?.peerUser;
    if (peer?.id === undefined) return;
    const avatarDataUrl = await this.avatarRepo.getCachedDataUrl(`u${peer.id}`);
    this.callAdapter.initiate(
      peer.id,
      uuid(),
      'AUDIO',
      peer.name ?? '',
      peer.avatar ?? '',
      avatarDataUrl,
    );
  }

  /** Unread messages in every conversation except the one currently open. Compact chat headers surface
   *  this beside Back so leaving the thread has useful context, matching the common mobile messenger pattern.
   *  Reads `unreadCount` (server-authoritative — own messages are 0, so a sent group-invite never inflates
   *  this total) and excludes the canonical open-thread signal (not the input — robust to input staleness). */
  readonly otherUnreadCount = computed(() => {
    const openId = this.convList.openThreadId();
    return this.convList
      .items()
      .reduce(
        (sum, item) =>
          sum +
          (item.threadId === openId ? 0 : Math.max(0, item.unreadCount ?? 0)),
        0,
      );
  });

  readonly otherUnreadLabel = computed(() => {
    const count = this.otherUnreadCount();
    return count > 99 ? '99+' : String(count);
  });

  /** In-chat search visibility is a layer of the app's virtual nav stack (see NavStateMachineService):
   *  `back` peels it before the chat, so hardware-back exits search before leaving the thread — the same
   *  model as the aside panel. Session-state only; NOT mirrored to the browser URL. The header reads/writes
   *  it directly via `nav`. */
  protected readonly searchOpen = this.nav.searchOpen;
  /** Close the embedded search field — drops the search nav layer (search-component ✕ button). */
  protected closeSearch(): void {
    this.nav.closeSearch();
  }

  /** The back arrow exists only to leave the compact full-screen chat overlay. Medium and expanded both
   *  render the chat inline alongside the conversation list (chat-slot is `static`), so there is no
   *  overlay to leave. */
  protected readonly mode = this.layout.mode;

  readonly title = computed(() => {
    const trd = this.userMsgTrd();
    if (!trd) return '';
    // A per-user alias (remark) overrides the real name in the caller's header.
    if (trd.alias) return trd.alias;
    return trd.type === 'P2P' ? displayUserName(trd.peerUser) : trd.group.name;
  });

  /** The home domain of the open conversation when it is federated, else null (self-hides the badge).
   *  P2P = the peer's domain; GROUP = the group's origin domain (the backend exposes '' for a
   *  local-origin group, so the badge self-hides there). */
  readonly federatedDomain = computed(() => {
    const trd = this.userMsgTrd();
    if (!trd) return null;
    if (trd.type === 'P2P')
      return trd.peerUser.isForeigner ? trd.peerUser.domain : null;
    return trd.group.domain || null;
  });

  /** Optional subtitle line under the title: the peer's bio (P2P) or the group description (GROUP).
   *  Empty when neither is set, so the header collapses to a single centered line (template @if). */
  readonly subtitle = computed(() => {
    const trd = this.userMsgTrd();
    if (!trd) return '';
    return trd.type === 'P2P'
      ? (trd.peerUser.bio ?? '')
      : (trd.group.description ?? '');
  });

  /** Whether the action menu overlay is open. */
  readonly menuOpen = signal(false);
  /** The action awaiting a two-tap confirm (null = normal menu list). */
  readonly confirmKey = signal<string | null>(null);

  /** The menu entry list — the normal per-thread set, or the inline confirm pair when a destructive
   *  action is staged. Computed so swapping confirmKey re-renders the overlay contents in place. */
  readonly entries = computed<ChatMenuEntry[]>(() => {
    const pending = this.confirmKey();
    if (pending) return this.confirmEntries(pending);
    return this.normalEntries();
  });

  private normalEntries(): ChatMenuEntry[] {
    const trd = this.userMsgTrd();
    if (!trd) return [];
    const isP2P = trd.type === 'P2P';
    const list: ChatMenuEntry[] = [
      // Label mirrors the panel title it opens: "Contact info" for P2P, "Group Info" for groups — so
      // the menu item and the popup (aside panel) header read the same (chat.menuViewInfo / group.title).
      {
        kind: 'action',
        key: 'viewInfo',
        labelKey: isP2P ? 'chat.menuViewInfo' : 'group.title',
        icon: AppIconType.EYE,
      },
      {
        kind: 'action',
        key: 'search',
        labelKey: 'chat.menuSearch',
        icon: AppIconType.SEARCH,
      },
      { kind: 'divider' },
      {
        kind: 'action',
        key: 'mute',
        labelKey: trd.muted ? 'chat.menuUnmute' : 'chat.menuMute',
        icon: AppIconType.MUTE,
      },
      {
        kind: 'action',
        key: 'pin',
        labelKey: trd.pinned ? 'chat.menuUnpin' : 'chat.menuPin',
        icon: AppIconType.PIN,
      },
      { kind: 'divider' },
      {
        kind: 'action',
        key: 'clearHistory',
        labelKey: 'chat.menuClearHistory',
        icon: AppIconType.TRASH,
        danger: true,
      },
    ];
    return list;
  }

  /** The inline confirm pair for a staged destructive action. */
  private confirmEntries(pending: string): ChatMenuEntry[] {
    const confirmLabel: Record<string, string> = {
      block: 'chat.menuBlockConfirm',
      deleteChat: 'chat.menuDeleteChatConfirm',
      leaveGroup: 'chat.menuLeaveGroupConfirm',
    };
    return [
      {
        kind: 'action',
        key: '__confirm__',
        labelKey: confirmLabel[pending] ?? '',
        danger: true,
      },
      { kind: 'divider' },
      { kind: 'action', key: '__back__', labelKey: 'chat.menuCancel' },
    ];
  }

  toggleMenu(): void {
    this.confirmKey.set(null);
    this.menuOpen.set(!this.menuOpen());
  }

  closeMenu(): void {
    this.menuOpen.set(false);
    this.confirmKey.set(null);
  }

  /** Route a menu selection: confirm-actions stage the two-tap, otherwise dispatch + close. */
  onSelect(key: string): void {
    if (key === '__back__') {
      this.confirmKey.set(null);
      return;
    }
    if (key === '__confirm__') {
      const action = this.confirmKey();
      this.confirmKey.set(null);
      this.menuOpen.set(false);
      if (action) void this.runAction(action);
      return;
    }
    // Destructive actions stage the inline two-tap confirm first. (clearHistory is excluded — it pops
    // the app-level modal instead, via runAction.)
    if (key === 'block') {
      this.confirmKey.set(key);
      return;
    }
    // Single-tap actions execute immediately and close.
    this.menuOpen.set(false);
    void this.runAction(key);
  }

  private async runAction(key: string): Promise<void> {
    const trd = this.userMsgTrd();
    if (!trd || trd.threadId === undefined) return;
    const threadId = trd.threadId;
    switch (key) {
      case 'viewInfo':
        this.showThreadInfo();
        return;
      case 'search':
        this.nav.openSearch();
        return;
      case 'mute':
        this.toggleMute(threadId, trd.muted);
        return;
      case 'pin':
        this.togglePin(threadId, trd.pinned);
        return;
      case 'clearHistory':
        this.confirmClearHistory(threadId);
        return;
      case 'block':
        this.toggleBlock(trd, !trd.blocked);
        return;
      case 'deleteChat':
        this.deleteChat(trd);
        return;
      case 'leaveGroup':
        this.leaveGroup(trd);
        return;
    }
  }

  /** Mute toggle: optimistic patch; the server confirms through the durable state delta. */
  private toggleMute(threadId: number, muted: boolean): void {
    const next = !muted;
    this.convList.applyThreadMeta(threadId, { muted: next });
    this.msgService.setMuted({ threadId, muted: next }).subscribe({
      error: () => this.convList.applyThreadMeta(threadId, { muted }), // revert on failure
    });
  }

  private togglePin(threadId: number, pinned: boolean): void {
    const next = !pinned;
    // pinnedAt is resolved server-side; optimistically set a provisional now so the row re-sorts into
    // the pinned tier immediately. The state delta overwrites it with the authoritative value.
    this.convList.applyThreadMeta(threadId, {
      pinned: next,
      pinnedAt: next ? Date.now() : null,
    });
    this.msgService.setPinned({ threadId, pinned: next }).subscribe({
      error: () =>
        this.convList.applyThreadMeta(threadId, {
          pinned,
          pinnedAt: pinned ? Date.now() : null,
        }),
    });
  }

  /** Clear the caller's server-visible history and remove the local thread plus its cached messages. */
  private confirmClearHistory(threadId: number): void {
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.clearConfirmTitle',
        messageKey: 'chat.clearConfirmBody',
        confirmKey: 'chat.clearConfirmAction',
        cancelKey: 'common.cancel',
        danger: true,
        icon: AppIconType.REPORT,
      },
      (ok) => {
        if (ok)
          void this.runLockedDelete(
            threadId,
            () => firstValueFrom(this.msgService.clearHistory({ threadId })),
            true,
            () => undefined,
            false,
          );
      },
    );
  }

  /** Block / unblock (P2P). The backend drops delivery + query-messages hides the blocked creator. The
   *  banner + input swap are derived from the conv item's `blocked` field, so patching it here flips them. */
  private toggleBlock(trd: ConversationItem, block: boolean): void {
    const peerId = trd.peerUser?.id;
    if (peerId === undefined) return;
    this.userService.setBlock({ userId: peerId, block }).subscribe((res) => {
      if (res.code !== 0) return;
      this.convList.applyThreadMeta(trd.threadId, { blocked: block });
    });
  }

  /** Unfriend ends write capability but retains this conversation and its history. */
  private deleteChat(trd: ConversationItem): void {
    const peerId = trd.peerUser?.id;
    if (peerId === undefined) return;
    this.routeService.popupDlg(
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
        void this.runLockedDelete(
          trd.threadId,
          () =>
            firstValueFrom(
              this.userService.deleteFriend({ userId: peerId, deleteData }),
            ),
          deleteData,
          () =>
            this.convList.applyThreadMeta(trd.threadId, {
              friendshipActive: false,
              conversationState: 'READ_ONLY',
            }),
        );
      },
    );
  }

  /** Leave group: reload the list (the row drops) and go home. */
  private leaveGroup(trd: ConversationItem): void {
    const groupId = trd.group?.id;
    if (groupId === undefined) return;
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.leaveConfirmTitle',
        messageKey: 'chat.menuLeaveGroupConfirm',
        confirmKey: 'chat.menuLeaveGroup',
        cancelKey: 'common.cancel',
        checkboxKey: 'chat.alsoDeleteData',
        danger: true,
      },
      (result) => {
        if (!result) return;
        const deleteData = typeof result === 'object' && result.checked;
        void this.runLockedDelete(
          trd.threadId,
          () =>
            firstValueFrom(
              this.groupService.leaveGroup({ groupId, deleteData }),
            ),
          deleteData,
          () =>
            this.convList.applyThreadMeta(trd.threadId, {
              conversationState: 'READ_ONLY',
            }),
        );
      },
    );
  }

  private async runLockedDelete(
    threadId: number,
    request: () => Promise<{ code: number; message: string }>,
    deleteData: boolean,
    onRetain: () => void,
    reloadAfter = true,
  ): Promise<void> {
    if (!this.deletionLock.begin(threadId)) return;
    try {
      const res = await request();
      if (res.code !== 0) {
        this.toast.warn(translateBizResult(res, this.transloco));
        return;
      }
      if (deleteData) {
        await this.convList.removeThread(threadId);
        this.nav.closeChat();
      } else onRetain();
    } catch {
      this.toast.warn(this.transloco.translate('errors.networkError'));
    } finally {
      this.deletionLock.end(threadId);
      if (reloadAfter) this.convList.load();
    }
  }

  /** Mobile back arrow: delegate to the nav stack's `back`, which peels layers in priority order
   *  (panes → aside → search → chat). This unifies the UI back arrow with the Android hardware-back path
   *  (which also calls `nav.back()` via the `__SOMS_BACK__` bridge), so search is always exited before the
   *  thread closes. */
  goBack(): void {
    this.nav.back();
  }

  /**
   * Open (or toggle) the peer-profile / group-info panel in the `aside` slot. The panels resolve their
   * thread from `ConversationListService.openThreadId`, so no threadId is needed. Toggling the SAME panel
   * closed just clears the aside signal (≈ hardware-back).
   */
  showThreadInfo(): void {
    const trd = this.userMsgTrd();
    if (!trd) return;
    const seg = trd.type === 'GROUP' ? 'group-info' : 'profile';
    if (this.nav.asideTop()?.panel === seg) {
      this.nav.closeAside();
      return;
    }
    this.nav.openAside(seg);
  }
}
