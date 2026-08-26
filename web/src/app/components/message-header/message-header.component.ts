import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
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
import { LayoutService } from '../../services/layout.service';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { CallAdapterService } from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { uuid } from '../../lib/uuid';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { ChatContextService } from '../message-thread/chat-context.service';

/**
 * Chat surface header: back (mobile), the thread title (tap → peer-profile / group-info aside), and
 * the top-right MORE button. P2P opens the friend-info aside directly; GROUP keeps an anchored
 * {@link ChatActionMenuComponent}. System settings is NOT here — it lives in the global nav
 * (icon-rail / nav-drawer), not a per-thread context menu.
 *
 * Mute / pin apply optimistically to the conversation list (via applyThreadMeta) and the durable state
 * delta re-confirms idempotently. P2P relationship actions are owned exclusively by the friend panel.
 */
@Component({
  selector: 'app-message-header',
  imports: [
    IconComponent,
    ChatActionMenuComponent,
    OverlayModule,
    TranslocoModule,
    MessageSearchComponent,
  ],
  templateUrl: './message-header.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './message-header.component.scss',
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType;
  readonly userMsgTrd = input<ConversationItem>();
  /** The current thread's id, fed to the embedded search field. Derived from userMsgTrd. */
  readonly threadId = computed(() => this.userMsgTrd()?.threadId ?? 0);

  /** Emits a message seq to center the kernel on (the parent owns the kernel + calls scrollToIndex). */
  readonly searchJump = output<number>();
  readonly shareChatCard = output<ConversationItem>();
  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly userService = inject(UserService);
  private readonly convList = inject(ConversationListService);
  private readonly callAdapter = inject(CallAdapterService);
  private readonly callEvents = inject(CallEventService);
  readonly callActive = computed(
    () => this.callEvents.callState().phase !== 'idle',
  );
  private readonly chatContext = inject(ChatContextService);

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
   *  POSTs /calls/initiate + creates the offer. Android resolves the peer presentation directly from native
   *  SQLite by account + domain; the renderer neither
   *  reads avatar bytes nor serializes them across the JS bridge. */
  placeCall(): void {
    if (this.callActive()) return;
    const peer = this.userMsgTrd()?.peerUser;
    if (peer?.id === undefined) return;
    this.callAdapter.initiate(
      peer.id,
      uuid(),
      'AUDIO',
      peer.name ?? '',
      peer.avatar ?? '',
      peer.account,
      peer.domain !== 'local' ? (peer.domain ?? '') : '',
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

  /** Group size shown as quiet context beside the title. P2P threads omit it. */
  readonly groupMemberCount = computed(() => {
    const trd = this.userMsgTrd();
    return trd?.type === 'GROUP' ? trd.group.memberCount : undefined;
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
  readonly moreExpanded = computed(() =>
    this.userMsgTrd()?.type === 'P2P'
      ? this.nav.asideTop()?.panel === 'profile'
      : this.menuOpen(),
  );
  readonly hasUnreadJoinRequests = computed(() => {
    const trd = this.userMsgTrd();
    if (trd?.type !== 'GROUP' || !this.chatContext.canAdministerGroup())
      return false;
    const head = this.userService.groupJoinRequestHeads().get(trd.threadId);
    return !!head && head.readFeedId < head.latestFeedId;
  });
  /** Group action-menu entries. P2P bypasses this menu and opens friend info directly. */
  readonly entries = computed<ChatMenuEntry[]>(() => this.normalEntries());

  private normalEntries(): ChatMenuEntry[] {
    const trd = this.userMsgTrd();
    if (!trd) return [];
    const list: ChatMenuEntry[] = [
      // Label mirrors the panel title it opens: "Contact info" for P2P, "Group Info" for groups — so
      // the menu item and the popup (aside panel) header read the same (chat.menuViewInfo / group.title).
      {
        kind: 'action',
        key: 'viewInfo',
        labelKey: 'group.title',
        icon: AppIconType.EYE,
      },
      {
        kind: 'action',
        key: 'search',
        labelKey: 'chat.menuSearch',
        icon: AppIconType.SEARCH,
      },
      {
        kind: 'action',
        key: 'shareContact',
        labelKey: 'contactCard.shareTitle',
        icon: AppIconType.SHARE,
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
    ];
    if (this.chatContext.canAdministerGroup())
      list.splice(1, 0, {
        kind: 'action',
        key: 'joinRequests',
        labelKey: 'group.joinRequests',
        icon: AppIconType.FRIEND_REQUESTS,
        badge: this.hasUnreadJoinRequests(),
      });
    return list;
  }

  toggleMenu(): void {
    if (this.userMsgTrd()?.type === 'P2P') {
      this.showThreadInfo();
      return;
    }
    this.menuOpen.set(!this.menuOpen());
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Dispatch a group menu selection, then close the anchored menu. */
  onSelect(key: string): void {
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
      case 'shareContact':
        this.shareChatCard.emit(trd);
        return;
      case 'joinRequests':
        this.nav.openAside('group-join-requests');
        return;
      case 'mute':
        this.toggleMute(threadId, trd.muted);
        return;
      case 'pin':
        this.togglePin(threadId, trd.pinned);
        return;
    }
  }

  /** Mute toggle: optimistic patch; the server confirms through the durable state delta. */
  private toggleMute(threadId: number, muted: boolean): void {
    const next = !muted;
    this.convList.applyThreadMeta(threadId, { muted: next });
    this.threadAdapter.setMuted({ threadId, muted: next }).subscribe({
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
    this.threadAdapter.setPinned({ threadId, pinned: next }).subscribe({
      error: () =>
        this.convList.applyThreadMeta(threadId, {
          pinned,
          pinnedAt: pinned ? Date.now() : null,
        }),
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
