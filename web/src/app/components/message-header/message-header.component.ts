import { Component, computed, inject, input, output, signal } from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { ChatActionMenuComponent, ChatMenuEntry } from '../chat-action-menu/chat-action-menu.component';
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
import { uuid } from '../../lib/uuid';

/**
 * Chat surface header: back (mobile), the thread title (tap → peer-profile / group-info aside), and
 * the top-right MORE button, which opens a {@link ChatActionMenuComponent} anchored CDK overlay with
 * the full per-thread action set (view info, search, mute, pin, mark-read, clear; P2P: block,
 * delete; GROUP: leave). System settings is NOT here — it lives in the global nav
 * (icon-rail / nav-drawer), not a per-thread context menu.
 *
 * Destructive actions use a two-tap inline confirm driven by swapping the menu's entry list (no separate
 * confirm dialog) — EXCEPT clear history, whose irreversibility warrants an unmissable app-level modal
 * ({@link PopupType.CONFIRM}) with a danger-styled warning. Mute / pin apply optimistically to the
 * conversation list (via applyThreadMeta) and the server's THREAD_META frame re-confirms idempotently.
 * Actions that affect the kernel (clear history → reset, block → banner) or the shell (delete / leave
 * → navigate away) are delegated to the parent via outputs.
 */
@Component({
  selector: 'app-message-header',
  imports: [IconComponent, ChatActionMenuComponent, OverlayModule, TranslocoModule, FederatedBadgeComponent, MessageSearchComponent],
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
  /** Emitted after clear-history succeeds (parent resets the kernel against the now-empty view). */
  readonly historyCleared = output<void>();

  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);
  private readonly msgService = inject(MsgService);
  private readonly userService = inject(UserService);
  private readonly groupService = inject(GroupService);
  private readonly convList = inject(ConversationListService);
  private readonly routeService = inject(RouteService);
  private readonly callAdapter = inject(CallAdapterService);

  /** Whether the call button shows: 1:1 calling is supported (Android native only — web/desktop calling is
   *  deferred) AND this is a P2P thread (groups can't be called 1:1). */
  readonly canCall = computed(() => this.callAdapter.supported && this.userMsgTrd()?.type === 'P2P');

  /** Place an outgoing AUDIO call to the P2P peer. Mints a client-side callSid (the call's idempotency key +
   *  signaling address — a UUIDv4, accepted by CALL_SID_RE) and hands it to the native call layer, which POSTs
   *  /calls/initiate + creates the offer. */
  placeCall(callType: 'AUDIO' | 'VIDEO'): void {
    const peer = this.userMsgTrd()?.peerUser;
    if (peer?.id === undefined) return;
    // Pass the peer's name + avatar so the native call notification (CallStyle Person) shows them — the
    // caller already knows the peer from the thread; no extra fetch on the ringing path.
    this.callAdapter.initiate(peer.id, uuid(), callType, peer.name ?? '', peer.avatar ?? '');
  }

  /** In-chat search visibility is a layer of the app's virtual nav stack (see NavStateMachineService):
   *  `back` peels it before the chat, so hardware-back exits search before leaving the thread — the same
   *  model as the aside panel. Session-state only; NOT mirrored to the browser URL. The header reads/writes
   *  it directly via `nav`. */
  protected readonly searchOpen = this.nav.searchOpen;
  /** Close the embedded search field — drops the search nav layer (search-component ✕ button). */
  protected closeSearch(): void {
    this.nav.closeSearch();
  }

  /** The back arrow exists only to leave the mobile full-screen chat overlay. Tablet and desktop both
   *  render the chat inline alongside the conversation list (chat-slot is `static`), so there is no
   *  overlay to leave — it is mobile-only. */
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
    if (trd.type === 'P2P') return trd.peerUser.isForeigner ? trd.peerUser.domain : null;
    return trd.group.domain || null;
  });

  /** Optional subtitle line under the title: the peer's bio (P2P) or the group description (GROUP).
   *  Empty when neither is set, so the header collapses to a single centered line (template @if). */
  readonly subtitle = computed(() => {
    const trd = this.userMsgTrd();
    if (!trd) return '';
    return trd.type === 'P2P' ? (trd.peerUser.bio ?? '') : (trd.group.description ?? '');
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
      { kind: 'action', key: 'viewInfo', labelKey: isP2P ? 'chat.menuViewInfo' : 'group.title', icon: AppIconType.EYE },
      { kind: 'action', key: 'search', labelKey: 'chat.menuSearch', icon: AppIconType.SEARCH },
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
      { kind: 'divider' },
    ];
    if (isP2P) {
      list.push(
        {
          kind: 'action',
          key: 'block',
          labelKey: trd.blocked ? 'chat.menuUnblock' : 'chat.menuBlock',
          icon: AppIconType.BLOCK,
          danger: !trd.blocked,
        },
        {
          kind: 'action',
          key: 'deleteChat',
          labelKey: 'chat.menuDeleteChat',
          icon: AppIconType.TRASH,
          danger: true,
        },
      );
    } else {
      list.push({
        kind: 'action',
        key: 'leaveGroup',
        labelKey: 'chat.menuLeaveGroup',
        icon: AppIconType.CLOSE,
        danger: true,
      });
    }
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
      { kind: 'action', key: '__confirm__', labelKey: confirmLabel[pending] ?? '', danger: true },
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
    if (key === 'block' || key === 'deleteChat' || key === 'leaveGroup') {
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

  /** Mute toggle: optimistic patch (icon flips now), server confirms via THREAD_META idempotently. */
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
    // the pinned tier immediately. The THREAD_META frame overwrites it with the authoritative value.
    this.convList.applyThreadMeta(threadId, { pinned: next, pinnedAt: next ? Date.now() : null });
    this.msgService.setPinned({ threadId, pinned: next }).subscribe({
      error: () => this.convList.applyThreadMeta(threadId, { pinned, pinnedAt: pinned ? Date.now() : null }),
    });
  }

  /**
   *  Clear history is irreversible (a per-user watermark: every message vanishes from this view, while the
   *  peer retains them) — so it pops the app-level confirm dialog with a danger-styled, unmissable warning
   *  rather than the inline two-tap the other destructive actions use. The actual clear runs only on a
   *  `true` result; a cancel / system-back delivers undefined and the history is left untouched.
   */
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
        if (ok) this.clearHistory(threadId);
      },
    );
  }

  private clearHistory(threadId: number): void {
    this.msgService.clearHistory({ threadId }).subscribe((res) => {
      if (res.code !== 0) return;
      this.historyCleared.emit();
    });
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

  /** Delete-friend (P2P): the server soft-leaves both participants; drop the thread and go home. */
  private deleteChat(trd: ConversationItem): void {
    const peerId = trd.peerUser?.id;
    if (peerId === undefined) return;
    this.userService.deleteFriend({ userId: peerId }).subscribe((res) => {
      if (res.code !== 0) return;
      this.convList.removeThread(trd.threadId);
      this.nav.closeChat();
    });
  }

  /** Leave group: reload the list (the row drops) and go home. */
  private leaveGroup(trd: ConversationItem): void {
    const groupId = trd.group?.id;
    if (groupId === undefined) return;
    this.groupService.leaveGroup({ groupId }).subscribe(() => {
      this.convList.load();
      this.nav.closeChat();
    });
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
