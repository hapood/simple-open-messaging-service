import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  Component,
  computed,
  inject,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MessageSearchComponent } from '../message-search/message-search.component';
import { ConversationItem, displayUserName } from '../../services/model';
import { LayoutService } from '../../services/layout.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { CallAdapterService } from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { uuid } from '../../lib/uuid';
import { hasUnreadGroupJoinRequests } from '../../services/group-join-request-state';
import { RouteService, PopupType } from '../../services/route.service';
import { currentGroupAnnouncement } from '../../services/group-announcement';

/**
 * Chat surface header: back (mobile), the centered thread title, and the top-right MORE button.
 * P2P and GROUP each open their own dedicated information panel from MORE.
 * System settings is NOT here — it lives in the global nav
 * (icon-rail / nav-drawer), not a per-thread context menu.
 *
 * Conversation and relationship actions are owned by those panels rather than a header dropdown.
 */
@Component({
  selector: 'app-message-header',
  imports: [IconComponent, TranslocoModule, MessageSearchComponent],
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
  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);
  private readonly convList = inject(ConversationListService);
  private readonly callAdapter = inject(CallAdapterService);
  private readonly callEvents = inject(CallEventService);
  readonly callActive = computed(
    () => this.callEvents.callState().phase !== 'idle',
  );
  private readonly route = inject(RouteService);
  readonly announcement = computed(() =>
    currentGroupAnnouncement(this.userMsgTrd()),
  );
  readonly announcementUnread = computed(() => {
    const announcement = this.announcement();
    return (
      announcement !== null &&
      BigInt(announcement.feedId) >
        BigInt(this.userMsgTrd()?.announcementReadFeedId ?? 0)
    );
  });
  openAnnouncement(): void {
    const announcement = this.announcement();
    const thread = this.userMsgTrd();
    if (thread?.type !== 'GROUP' || !announcement?.text) return;
    this.route.popupDlg(
      PopupType.GROUP_ANNOUNCEMENT,
      {
        threadId: thread.threadId,
        feedId: announcement.feedId,
        text: announcement.text,
      },
      undefined,
      { scopeThreadId: thread.threadId },
    );
  }

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

  readonly groupInactive = computed(() => {
    const trd = this.userMsgTrd();
    return (
      trd?.type === 'GROUP' &&
      (trd.group.dissolvedAt != null || trd.conversationState === 'READ_ONLY')
    );
  });

  /** Place an outgoing audio-first call to the P2P peer. Video is enabled from the shared in-call UI instead
   *  of being a second chat-header entry point. Mints a client-side callSid (the call's idempotency
   *  key + signaling address — a UUIDv4, accepted by CALL_SID_RE) and hands it to the native call layer, which
   *  POSTs /calls/initiate + creates the offer. Android resolves the peer presentation directly from native
   * SQLite by account + namespace id; the renderer neither reads avatar bytes nor serializes them across the JS bridge. */
  placeCall(): void {
    if (this.callActive()) return;
    const thread = this.userMsgTrd();
    const peer = thread?.peerUser;
    if (!thread || !peer) return;
    this.callAdapter.initiate(
      thread.threadId,
      uuid(),
      'AUDIO',
      peer.account,
      peer.namespaceId,
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
    if (trd?.type !== 'GROUP') return undefined;
    return this.groupInactive() ? 1 : trd.group.memberCount;
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

  readonly moreExpanded = computed(() => {
    const trd = this.userMsgTrd();
    if (!trd) return false;
    return (
      this.nav.asideTop()?.panel ===
      (trd.type === 'GROUP' ? 'group-info' : 'profile')
    );
  });
  readonly hasUnreadJoinRequests = computed(() => {
    const trd = this.userMsgTrd();
    return trd?.type === 'GROUP' && hasUnreadGroupJoinRequests(trd);
  });
  toggleMenu(): void {
    this.showThreadInfo();
  }

  /** Mobile back arrow: delegate to the nav stack's `back`, which peels layers in priority order
   *  (panes → aside → search → chat). This unifies the UI back arrow with the Android hardware-back path
   *  (which also calls `nav.back()` via the `__SOMS_BACK__` bridge), so search is always exited before leaving
   *  the thread. */
  goBack(): void {
    this.nav.back();
  }

  /**
   * Open (or toggle) the peer-profile / group-info panel in the `aside` slot. The panels resolve their
   * thread from `ConversationListService.openThreadId`, so no threadId is needed. Toggling the SAME panel
   * closed just clears the aside signal (≈ hardware-back). This is intentionally reached from the MORE
   * button; the centered title is presentation only.
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
