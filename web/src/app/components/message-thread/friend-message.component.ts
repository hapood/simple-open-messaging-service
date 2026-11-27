import {
  Component,
  ApplicationRef,
  createComponent,
  DestroyRef,
  computed,
  effect,
  ElementRef,
  EnvironmentInjector,
  HostListener,
  inject,
  input,
  isDevMode,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import {
  ChatSurfaceLifecycle,
  type ChatSurfaceState,
} from './chat-surface-lifecycle';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { MessageWindowScenario } from './message-entry';
import {
  catchError,
  concatMap,
  defer,
  type Observable,
  EMPTY,
  firstValueFrom,
  map,
  of,
  Subscriber,
  Subscription,
  tap,
} from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import {
  ChatBoxScroller,
  type CbWindowNavigation,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import { isViewportTransformEnd } from '../../lib/sticky-date';
import { CbItemLifetime } from '../../lib/chat-box/cb-item-lifetime';
import {
  TailActivityRowComponent,
  type TailOverlapPeerAvatar,
} from './tail-activity-row.component';
import type { ThreadAuthor } from '../../../../../shared/thread-author';
import type { AvatarDomainSource } from '../user-avatar/model';
import { TailAuthorCache } from './tail-author-cache';
import { MessageRepository } from '../../services/message-repository.service';
import { ChatAppearanceService } from '../../services/chat-appearance.service';
import { SendingTaskPresentation } from '../../services/sending-task-presentation.service';
import { isTailCueVisible } from './tail-cue-visibility';
import {
  MESSAGE_THREAD_ADAPTER,
  type MessageThreadSource,
} from './message-thread-adapter';
import {
  createMsgCbElement,
  createServerGapCbElement,
  createGhostCbElement,
  computeRowFlags,
} from '../message-cards/create-item';
import { VOICE_BAR_W, VOICE_BAR_H } from '../message-cards/media-row/layout';
import {
  mergeAlbumItemsAtBoundary,
  absorbAlbumTail,
} from '../message-cards/merge-items';
import {
  MEDIA_STATUS,
  type AlbumMedia,
  type ChatItemData,
  type ChatMsgData,
  type AuthoredContentType,
  type FileInfo,
  type MediaStatus,
  isConfirmedMessage,
} from '../message-cards/chat-item';
import { MessageWindowSkeletonComponent } from './message-window-skeleton.component';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import {
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
  conversationAvatarType,
} from '../user-avatar/conversation-avatar.util';
import {
  avatarProfileDemand,
  conversationAvatarProfile,
  groupMemberAvatarProfile,
  type AvatarProfileRef,
} from '../../services/avatar-profile-ref';
import {
  ChatInputComponent,
  type ChatSendIntent,
} from '../../lib/chat-input/chat-input.component';
import { PastePanelComponent } from '../../lib/chat-input/paste-panel.component';
import { KbdOffsetDirective } from '../../directives/kbd-offset.directive';
import { ComposerWidthSourceDirective } from '../../directives/composer-width-source.directive';
import { ComposerDraftService } from '../../services/composer-draft.service';
import { LinkCardGenerationService } from '../../services/link-card-generation.service';
import { ChatboxStickyOverlaysComponent } from '../message-cards/chatbox-sticky-overlays/chatbox-sticky-overlays.component';
import { uuid } from '../../lib/uuid';
import { assetUrl, isAndroidNative } from '../../services/runtime';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { LayoutService } from '../../services/layout.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  displayThreadName,
  displayUserAccount,
  type ConversationItem,
  type StandardResponse,
} from '../../services/model';
import { mentionSearchPlan } from '../chat-editor/mention-candidates';
import { serializeNativeComposerText } from '../chat-editor/editor-message-serializer';
import {
  MediaTransferService,
} from '../../services/media-transfer.service';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import { BrowserSendFiles } from '../../services/browser-send-files.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { AttachmentUploadQueueService } from '../../services/attachment-upload-queue.service';
import { DebugToolsService } from '../../services/debug-tools.service';
import { ToastService } from '../../services/toast.service';
import {
  canCopyMessage,
  messageCopyBody,
  selectedMessagesCopyText,
  type MessageCopyLabels,
} from './message-copy';
import {
  NativeComposerService,
  type NativeComposerEvent,
} from '../../services/native-composer.service';
import { ThemeService } from '../../services/theme.service';
import { CallBannerComponent } from '../call-banner/call-banner.component';
import { CallEventService } from '../../services/call-event.service';
import { CallPresentationService } from '../../services/call-presentation.service';
import { BusinessCode, translateBizResult } from '../../services/biz-code';
import { tauriInvoke } from '../../services/runtime';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { namespaceDisplayDomain } from '../../services/profile-namespace-domain';
import {
  PopupType,
  RouteService,
  type DlgRef,
} from '../../services/route.service';
import { currentGroupAnnouncement } from '../../services/group-announcement';
import { GroupAnnouncementComponent } from '../group-announcement/group-announcement.component';
import { ChatboxPopupComponent } from '../chatbox-popup/chatbox-popup.component';
import { MemberProfileRepository } from '../../services/member-profile-store.service';
import type { ProfileDemand } from '../../../../../shared/profile-demand';
import {
  ALL_MENTION_ID,
  escapePlainText,
  selfMentionIdentity,
} from '../../lib/message-entity';
import type { ChatMember } from '../chat-editor/chat-editor.component';
import { StableReadTracker } from './stable-read-tracker';
import {
  applyMessageSelectionState,
  messageMemberIds,
} from './message-selection';
import { MessageInteractionController } from './message-interaction.controller';
import { jumpToMessage } from './message-jump';
import type { HistoryAnchor } from '../../services/history-anchor';
import { MessageForwardController } from './message-forward.controller';
import {
  ThreadPasteQueueController,
  type ThreadPasteItem,
} from './thread-paste-queue.controller';
import { ThreadScrollController } from './thread-scroll.controller';
import { ThreadSendRetryController } from './thread-send-retry.controller';
import { ThreadComposerController } from './thread-composer.controller';
import { NativeComposerBoundsController } from './native-composer-bounds.controller';
import { ThreadMessageSendController } from './thread-message-send.controller';
import { NativeComposerDraftController } from './native-composer-draft.controller';

let nativeComposerContextSequence = Date.now() * 1000;

/**
 * Message thread container (shared by the desktop chat-pane inline view and the mobile root-popup dialog).
 *
 * Render core: virtual-scroll kernel B (ChatBoxScroller, manual compensation, array index) + HttpItemSource
 * (msgId cursor + HTTP pagination + SSE). Rendering + grouping logic is identical to the playground —
 * createItem calls createMsgCbElement (the real message-cards components); date separators are derived at the
 * render layer; album merging is the kernel's mergeItems hook.
 *
 * Optimistic send (ported from the playground, adapted to HTTP): the ChatInputComponent emits a structured
 * ChatSendIntent; this component builds an optimistic bubble (insertAfter, transient), registers it with the
 * source's pending area, and fires the HTTP send. The SSE echo updates the repository-backed source; its active newer
 * demand then delivers the confirmed real through the same range-loading path as history. On HTTP failure the
 * optimistic is morphed to a failed bubble (reconcilePending) with a retry affordance.
 *
 * zoneless: viewChild is initialized in an effect (ngAfterViewInit is unreliable zoneless — see the
 * zoneless-viewchild-init-effect memory). Switching conversations (same component, input change): tear down
 * the old scroller + source and rebuild.
 */
@Component({
  selector: 'app-message-thread',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MessageHeaderComponent,
    MessageWindowSkeletonComponent,
    CallBannerComponent,
    ChatInputComponent,
    PastePanelComponent,
    KbdOffsetDirective,
    ComposerWidthSourceDirective,
    ChatboxStickyOverlaysComponent,
    ChatboxPopupComponent,
    EmptyStateComponent,
    DemandAvatarComponent,
    SnapshotAvatarComponent,
    TranslocoModule,
  ],
  templateUrl: './friend-message.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  private readonly callLayout = inject(LayoutService);
  private readonly callPresentation = inject(CallPresentationService);
  private readonly callEvents = inject(CallEventService);
  readonly showCallBanner = computed(
    () =>
      this.callLayout.mode() === 'compact' && this.callPresentation.minimized(),
  );
  readonly assetUrl = assetUrl;
  readonly UserAvatarType = UserAvatarType;
  readonly displayUserAccount = displayUserAccount;
  readonly threadId = input<number>();
  readonly userMsgTrd = input<ConversationItem>();
  readonly canAdministerGroup = computed(() => {
    const thread = this.userMsgTrd();
    return (
      thread?.type === 'GROUP' &&
      (thread.role === 'OWNER' || thread.role === 'ADMIN')
    );
  });
  /** The A/B host keeps two threads mounted; only the foreground layer may own the one native composer. */
  readonly nativeComposerActive = input(false);
  private readonly chatInput = viewChild(ChatInputComponent);

  /** Emits the threadId once messages or the retry surface can be presented after `init()` — the A/B buffer host
   *  awaits this before cross-fading a pane in, so the reveal never races a half-initialized kernel. Carries
   *  `threadId` (NOT `trd.id` — that's the AccountThreadState row id, a different value) so the host can
   *  discard stale emits from a superseded reset. Not emitted on teardown. */
  readonly ready = output<number>();

  private readonly viewportRef =
    viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly containerRef =
    viewChild<ElementRef<HTMLDivElement>>('container');
  private readonly contentRef =
    viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly stickyOverlays = viewChild(ChatboxStickyOverlaysComponent);
  /** The chat header element — its bottom edge is the STABLE visible-top reference for the sticky-date
   *  pill. The viewport carries the keyboard-lift `transform`, so its own `getBoundingClientRect().top`
   *  slides under the header while the keyboard is up; the header does not transform, so its bottom is the
   *  true top of the visible content (see updateStickyOverlays). */
  private readonly headerRef = viewChild('msgHeader', {
    read: ElementRef<HTMLElement>,
  });
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly userService = inject(UserService);
  readonly selfUserId = computed(() => this.userService.sessionProfile()?.id);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly namespaces = inject(ProfileNamespaceRepository);
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly nav = inject(NavStateMachineService);
  private readonly convList = inject(ConversationListService);
  private readonly transfers = inject(MediaTransferService);
  private readonly nativeUploads = inject(NativeUploadService);
  private readonly pasteQueue = new ThreadPasteQueueController((partId) =>
    this.nativeUploads.discard(partId),
  );
  readonly pasteItems = this.pasteQueue.items;
  readonly pasteOpen = this.pasteQueue.open;
  private readonly attachmentUploads = inject(AttachmentUploadQueueService);
  private readonly route = inject(RouteService);
  readonly chatboxDialogOpen = computed(() => {
    const threadId = this.threadId();
    return this.route
      .dlgList()
      .some(
        (dialog) =>
          dialog.presentation === 'chatbox' &&
          dialog.scopeThreadId === threadId,
      );
  });
  /** Every routed dialog visually covers the composer. Keep the browser composer mounted and hide only
   *  its paint so the scroller's measured tail geometry cannot change while a global modal opens. */
  readonly dialogOpen = computed(() =>
    this.nav.paneStack().some((pane) => pane.kind === 'dialog'),
  );
  private readonly transloco = inject(TranslocoService);
  private readonly debugTools = inject(DebugToolsService);
  private readonly toast = inject(ToastService);
  private readonly sendOutbox = inject(ThreadSendOutbox);
  private readonly browserSendFiles = inject(BrowserSendFiles);
  private readonly sendRetry = new ThreadSendRetryController(
    this.sendOutbox,
    {
      message: task => this.messageSender.execute(task),
      webAttachment: task => this.transfers.executeWeb(task),
      nativeAttachment: task => this.transfers.executeNative(task),
    },
  );
  private readonly messageSender = new ThreadMessageSendController(
    this.threadAdapter,
    {
      threadId: () => this.threadId(),
      consumeQuote: () => {
        const quote = this.messageInteraction.consumeQuote();
        return quote?.kind === 'jumpable' ? { seq: quote.seq } : null;
      },
      newClientMessageId: () => this.newClientMessageId(),
      surfaceFailure: (response) => this.surfaceSendFailure(response),
    },
    this.sendOutbox,
  );
  private readonly composer = new ThreadComposerController({
    text: (intent) => this.messageSender.text(intent.text),
    image: (intent) =>
      void this.sendChosenWebAttachments(
        Array.from(intent.files).filter((file) =>
          file.type.startsWith('image/'),
        ),
      ),
    file: (intent) => void this.sendChosenWebAttachments(intent.files),
    nativeFiles: (intent) =>
      void this.sendChosenNativeAttachments(intent.files),
    link: (intent) =>
      this.messageSender.link(intent.generationId),
    contact: (intent) => this.messageSender.contact(intent),
    paste: (intent) => this.appendWebPaste(intent.files, intent.text),
    audio: (intent) =>
      this.sendVoice(intent.blob, intent.duration, intent.mimeType),
  });
  private readonly theme = inject(ThemeService);
  private readonly forwarding = new MessageForwardController(
    this.threadAdapter,
    this.route,
    this.toast,
    this.transloco,
    () => this.newClientMessageId(),
  );
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly profileSession = inject(SessionLifecycleService);
  private readonly destroyRef = inject(DestroyRef);
  readonly nativeComposer = inject(NativeComposerService);
  private readonly composerDrafts = inject(ComposerDraftService);
  private readonly linkGenerations = inject(LinkCardGenerationService);
  private readonly nativeDraft = new NativeComposerDraftController(
    this.composerDrafts,
    this.linkGenerations,
  );
  readonly searchMentionMembers = async (
    query: string,
  ): Promise<ChatMember[]> => {
    const binding = this.lifecycle.binding;
    const session = this.profileSession.capture();
    const threadId = binding?.threadId;
    const trd = this.userMsgTrd();
    if (threadId === undefined || trd?.type !== 'GROUP') return [];
    const allLabel = this.transloco.translate('chat.mentionAll');
    const { includeAll, memberLimit } = mentionSearchPlan(
      query,
      allLabel,
      this.canAdministerGroup(),
    );
    const eligible = await this.memberProfiles.queryPage(threadId, {
      take: memberLimit,
      search: query,
      exclude: selfMentionIdentity(
        trd,
        this.userService.sessionProfile()?.account,
      ),
    });
    if (
      !binding ||
      binding.signal.aborted ||
      !this.profileSession.isCurrent(session)
    )
      return [];
    const members: ChatMember[] = eligible.map((member) => ({
      // Mention entity ids are serialized as v1 user entities:
      // somfp://user/<namespaceId>/<account>. The member's namespaceId is the
      // group origin's subject namespace (0 for a member hosted by the origin).
      id: `${member.namespaceId}/${member.account}`,
      label: member.name,
      profile: groupMemberAvatarProfile(trd, member),
    }));
    if (includeAll)
      members.unshift({
        id: ALL_MENTION_ID,
        label: allLabel,
      });
    return members;
  };
  private nativeComposerContextId: number | null = null;
  private nativeComposerThreadId: number | null = null;
  private readonly nativeComposerBounds = new NativeComposerBoundsController(
    this.nativeComposer,
    () => this.nativeComposerContextId,
    () => this.layout.reflowFrozen(),
  );

  private scroller?: ChatBoxScroller<ChatItemData>;
  private source?: MessageThreadSource;
  readonly lifecycle = new ChatSurfaceLifecycle();
  private readonly presentation = signal<
    'unbound' | 'loading' | 'history' | 'blocked' | 'error'
  >('unbound');
  readonly interactionActive = computed(() => {
    const state = this.lifecycle.state();
    return state.phase === 'bound' && state.foreground;
  });
  readonly composerBinding = computed(() =>
    this.blockedPeer() ||
    this.friendshipEnded() ||
    this.readOnlyGroup() ||
    this.sendPaused()
      ? undefined
      : this.lifecycle.binding,
  );
  private get currentTrdId(): number | null {
    return this.lifecycle.binding?.threadId ?? null;
  }
  private get kernelReady(): boolean {
    return this.presentation() === 'history';
  }
  private readonly scrollState = new ThreadScrollController();
  private readonly appVisible = signal(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  private resumeAfterBackground = false;
  private readonly unreadDividerReady = signal(false);
  private pendingDividerRefresh: number[] = [];
  private readonly stableRead = new StableReadTracker((seq) => {
    const threadId = this.threadId();
    if (
      threadId !== undefined &&
      threadId === this.currentTrdId &&
      this.interactionActive()
    ) {
      this.convList.markReadStable(threadId, seq);
    }
  });

  readonly atBottom = this.scrollState.atBottom;
  /** Incoming message signals received while the user is reading history. Cleared only after the viewport
   *  reaches the visible newest zone, not merely the kernel's much wider newer-prefetch threshold. */
  readonly newMessageCount = this.scrollState.newMessageCount;
  /** The frozen unread boundary is above the visible viewport; shown as the upward counterpart to latest. */
  readonly unreadBoundaryAbove = this.scrollState.unreadBoundaryAbove;
  readonly newMessageLabel = this.scrollState.newMessageLabel;
  /** True while the kernel fetches the initial batch on a thread open (or re-init on switch). Used only to
   *  keep the empty-thread state hidden until init settles; ChatPane owns the switch-loading spinner. */
  readonly windowJumpState = signal<'idle' | 'loading' | 'missing' | 'failed'>(
    'idle',
  );
  private windowJumpOptions?: CbWindowNavigation;
  private finishWindowJump?: (found: boolean) => void;

  readonly initialLoading = signal(true);
  readonly initialLoadFailed = signal(false);
  readonly showWindowSkeleton = computed(() =>
    this.windowJumpState() === 'loading' ||
    (this.presentation() === 'loading' && this.initialLoading() &&
      !this.initialLoadFailed() && this.mountedMessageCount() === 0),
  );
  private readonly messageInteraction = new MessageInteractionController();
  readonly selectionMode = this.messageInteraction.selectionMode;
  readonly selectedMessageIds = this.messageInteraction.selectedMessageIds;
  readonly selectedCount = this.messageInteraction.selectedCount;
  readonly messageContextMenu = this.messageInteraction.contextMenu;
  private lastMessageScrollTop = 0;
  private contextMenuScrollTop = 0;
  readonly composingQuote = this.messageInteraction.composingQuote;

  /** True when the kernel's mounted window is empty — the thread is open but has no messages (a fresh P2P
   *  friendship, a newly-created group, or after a server-applied history boundary). Maintained from
   *  onScroll's `mounted` count:
   *  the kernel's emit() fires on init's empty branch, on every mount, and on optimistic/incoming inserts, so
   *  the hero card reacts the instant the first message — including an optimistic send — mounts. Reset to false
   *  in teardown; the template additionally gates on !initialLoading() so the card never flashes mid-load. */
  private readonly mountedMessageCount = this.scrollState.mountedMessageCount;
  /** Conversation block state for both P2P and groups. */
  readonly blockedPeer = computed(() => !!this.userMsgTrd()?.blocked);
  readonly friendshipEnded = computed(
    () =>
      this.userMsgTrd()?.type === 'P2P' &&
      this.userMsgTrd()?.conversationState === 'READ_ONLY',
  );
  readonly readOnlyGroup = computed(
    () =>
      this.userMsgTrd()?.type === 'GROUP' &&
      this.userMsgTrd()?.conversationState === 'READ_ONLY',
  );
  /** Per-user quota breaker tripped for the local user → sending/uploading is paused server-side. Set when a
   *  send returns QUOTA_EXCEEDED; cleared on the next successful send (which implies the breaker was lifted,
   *  e.g. an admin added quota or UTC midnight reset it). */
  readonly sendPaused = signal(false);
  /** The media viewer must also suppress the native sibling composer, which otherwise sits outside the
   *  WebView DOM and can remain visible above a CDK overlay. The browser composer uses the same flag. */
  readonly mediaViewerOpen = computed(() =>
    this.nav.paneStack().some((pane) => pane.kind === 'gallery'),
  );
  /** Native composer is a sibling of the WebView, so CSS stacking cannot place a web overlay above it.
   *  Treat every chat aside/transient pane as a higher semantic layer and unmount the native surface
   *  while that layer is active. This covers peer profile/group info as well as dialogs and viewers.
   *  A FULLSCREEN call overlay (CallOverlayService, body-level) is likewise above the native surface —
   *  but it is not part of the chat pane stack, so it must be named here explicitly. A minimized call
   *  (banner) does NOT occlude: the composer stays usable mid-call. */
  readonly nativeComposerOccluded = computed(
    () =>
      (this.callEvents.callState().phase !== 'idle' &&
        !this.callPresentation.minimized()) ||
      this.nav.aside().length > 0 ||
      this.nav
        .paneStack()
        .some(
          (pane) => pane.kind !== 'dialog' || pane.presentation !== 'chatbox',
        ) ||
      this.pasteOpen(),
  );
  /** A higher layer requires the composer to step aside. The browser composer stays mounted under every
   *  routed dialog; the native composer stays under non-chatbox dialogs via `nativeComposerOccluded`. */
  readonly composerAvoided = computed(() =>
    this.nativeComposer.supported
      ? this.chatboxDialogOpen() || this.nativeComposerOccluded()
      : this.dialogOpen() || this.nativeComposerOccluded(),
  );
  /** Static gray silhouette that permanently occupies the composer slot beneath the real composer, so a
   *  composer sliding out reveals it instead of an empty gap. Banner states and the selection bar own the
   *  slot themselves. */
  readonly composerPlaceholderVisible = computed(
    () => !!this.composerBinding() && !this.selectionMode(),
  );
  /** Sending tasks live outside history and do not suppress its empty state. */
  readonly threadEmpty = computed(() => this.mountedMessageCount() === 0);
  /** Hero-card content for the empty-thread placeholder. P2P shows the peer; GROUP shows the group. The name
   *  reuses displayThreadName (alias-aware) and the avatar reuses the same IDB-backed identity the conversation
   *  list uses, so an alias / cached avatar renders identically here and in the list. */
  readonly emptyTitle = computed(() => {
    const t = this.userMsgTrd();
    return t ? displayThreadName(t) : '';
  });
  readonly emptyIsGroup = computed(() => this.userMsgTrd()?.type === 'GROUP');
  readonly emptyAvatarType = computed<UserAvatarType>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarType(t) : UserAvatarType.OTHER;
  });
  readonly emptyAvatarAccount = computed<string | undefined>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarAccount(t) : undefined;
  });
  readonly emptyAvatarNamespaceId = computed(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarNamespaceId(t) : 0;
  });
  readonly emptyAvatarProfile = computed(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarProfile(t) : undefined;
  });
  /** Hint copy varies by state: a blocked peer can't be messaged until unblocked, so the "say hello" line is
   *  swapped for an unblock prompt; otherwise it is per thread type. Returns a transloco key. */
  readonly emptyHintKey = computed(() => {
    if (this.blockedPeer()) return 'chat.emptyBlockedHint';
    return this.emptyIsGroup() ? 'chat.emptyGroupHint' : 'chat.emptyP2PHint';
  });

  /** Non-audio attachments share one FIFO upload lane. All selected tasks are registered before the
   * first upload starts, so the aggregate send box is the only pending UI and keeps the full batch in
   * selection order. Voice notes deliberately bypass this lane. */

  private openedAnnouncementKey: string | null = null;

  constructor() {
    effect(() => {
      const tid = this.threadId() ?? 0;
      const { messages, uploads, messageCount, uploadCount, failedCount } = this.sendingPresentation.forThread(tid);
      untracked(() => {
        if (this.tailCacheThreadId !== tid) {
          this.tailCacheThreadId = tid;
          this.tailAuthorCache.clear();
        }
        const gapChanged = this.tailAuthorCache.observeSending(
          [...messages, ...uploads]
            .filter((row) => row.execution.phase === 'sending')
            .map((row) => row.task.clientMessageId),
          this.latestTailEnd(),
        );
        if (!gapChanged && this.tailSummary.messageCount === messageCount &&
            this.tailSummary.uploadCount === uploadCount &&
            this.tailSummary.failedCount === failedCount) return;
        this.tailSummary = { messageCount, uploadCount, failedCount };
        this.scroller?.refreshTailPresentation();
      });
    });
    this.messageRepo.historyHead$
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const tid = this.threadId();
        if (!tid || event.threadId !== tid) return;
        if (this.tailAuthorCache.observe(event.seq, event.author))
          this.scroller?.refreshTailPresentation();
      });
    const appearance = inject(ChatAppearanceService);
    effect(() => {
      appearance.showSelfAvatar();
      untracked(() => this.scroller?.scheduleLayoutRemeasure());
    });
    this.lifecycle.state$
      .pipe(takeUntilDestroyed())
      .subscribe((state) => untracked(() => this.applyLifecycle(state)));
    effect(() => this.synchronizeForeground());
    effect(() => {
      const thread = this.userMsgTrd();
      const active = this.nativeComposerActive();
      const openId = this.convList.openThreadId();
      const dialogOpen = this.chatboxDialogOpen();
      if (!active || !thread || openId !== thread.threadId) {
        this.openedAnnouncementKey = null;
        return;
      }
      if (thread.type !== 'GROUP') return;
      if (dialogOpen) {
        const displayed = this.route
          .dlgList()
          .find(
            (dialog) =>
              dialog.scopeThreadId === thread.threadId &&
              dialog.component === GroupAnnouncementComponent,
          );
        const feedId = displayed?.inputs?.['feedId'];
        if (typeof feedId === 'string')
          this.openedAnnouncementKey = `${thread.threadId}:${feedId}`;
        return;
      }
      const announcement = currentGroupAnnouncement(thread);
      if (
        !announcement ||
        BigInt(announcement.feedId) <=
          BigInt(thread.announcementReadFeedId ?? 0)
      )
        return;
      const key = `${thread.threadId}:${announcement.feedId}`;
      if (this.openedAnnouncementKey === key) return;
      this.openedAnnouncementKey = key;
      this.route.popupDlg(
        PopupType.GROUP_ANNOUNCEMENT,
        {
          threadId: thread.threadId,
          feedId: announcement.feedId,
          text: announcement.text,
          createdAt: announcement.createdAt,
          originCreatedAt: announcement.originCreatedAt,
        },
        undefined,
        { scopeThreadId: thread.threadId },
      );
    });
    effect(() => {
      const request = this.transfers.latestRequest();
      if (!request || request.threadId !== this.threadId()) return;
      // Reading the nonce makes repeated clicks for the same thread distinct. The kernel may still be
      // initializing after navigation; init's normal bottom positioning handles that cold case.
      request.nonce;
      if (this.lifecycle.binding) void this.scroller?.goToLatest();
    });
    effect(() => this.synchronizeKernel());
    // A background A/B pane may finish initialization before it is promoted. Only the foreground pane starts
    // read tracking; start() immediately commits the fully-visible HWM collected during kernel layout.
    effect(() => {
      const active = this.interactionActive();
      const loading = this.initialLoading();
      if (
        active &&
        !loading &&
        this.kernelReady &&
        this.unreadDividerReady() &&
        (!isAndroidNative() || this.appVisible())
      ) {
        // A cold notification launch or background return can reset the tracker
        // after the kernel's one-time visible-enter events. Sample the current
        // mounted viewport before start() flushes the read cursor.
        this.stableRead.startFromViewport(
          this.scroller?.getFullyVisibleIds() ?? [],
        );
      } else {
        this.stableRead.reset();
      }
    });
    // Immunity frame drain: when a route-transition freeze ends, apply any viewport resize the kernel
    // deferred so the message list re-pins to the post-animation viewport exactly once.
    effect(() => {
      if (this.layout.reflowFrozen()) return; // act only on the unfrozen edge
      this.scroller?.flushViewportResize();
      this.nativeComposerBounds.flush();
    });
    effect(() => {
      const threadId = this.threadId();
      const shouldShow =
        this.nativeComposer.supported &&
        !!this.composerBinding() &&
        this.interactionActive() &&
        threadId !== undefined &&
        !this.blockedPeer() &&
        !this.friendshipEnded() &&
        !this.readOnlyGroup() &&
        !this.nativeComposerOccluded() &&
        !this.chatboxDialogOpen() &&
        !this.selectionMode();
      if (!shouldShow) {
        this.hideNativeComposer(this.friendshipEnded());
        return;
      }
      const theme = this.theme.effective();
      const composingQuote = this.composingQuote();
      const quote =
        composingQuote?.kind === 'jumpable' && composingQuote.seq !== undefined
          ? {
              seq: composingQuote.seq,
              preview: `${composingQuote.author ?? ''}: ${composingQuote.body ?? ''}`,
            }
          : undefined;
      if (this.nativeComposerThreadId === threadId) {
        if (this.nativeComposerContextId !== null)
          this.nativeComposer.update(this.nativeComposerContextId, {
            theme,
            mentionAllLabel: this.transloco.translate('chat.mentionAll'),
            quote: quote ?? null,
          });
        return;
      }
      this.hideNativeComposer();
      // Draft changes must not re-run the native context setup/update effect.
      const initialDraft = untracked(() => this.nativeDraft.open(threadId));
      const contextId = ++nativeComposerContextSequence;
      this.nativeComposerContextId = contextId;
      this.nativeComposerThreadId = threadId;
      this.nativeComposer.show({
        version: 1,
        contextId,
        threadId: String(threadId),
        placeholder: this.transloco.translate('chat.messagePlaceholder'),
        initialDraft,
        sending: false,
        canRecord: true,
        canUpload: true,
        mentionsEnabled: this.userMsgTrd()?.type === 'GROUP',
        userId: this.userService.sessionProfile()?.id ?? 0,
        mentionAllLabel: this.transloco.translate('chat.mentionAll'),
        quote,
        theme,
      });
      this.observeNativeComposerBounds(contextId);
    });
    effect(() => {
      const event = this.nativeComposer.event();
      if (!event || event.contextId !== this.nativeComposerContextId) return;
      this.handleNativeComposerEvent(event);
    });

  }

  private closeDeletedMessageSurfaces(threadId: number, seq: number): void {
    // These surfaces can outlive the message's mounted row.
    this.galleryViewer.closeIfDeleted(threadId, seq);
    this.messageInteraction.removeMessage(seq);
  }

  private replaceMountedDeletedMessage(
    seq: number,
    deletionType: 'USER_RETRACTION' | 'MODERATION_REMOVAL',
  ): void {
    // Only mutate a currently mounted body. The source/cache never retain these
    // notices, so trimming, reloading or reopening cannot resurrect a deletion.
    this.scroller?.mutateItem(seq, (item) => {
      if (item.data.type !== 'msg') return item;
      const images = item.data.images;
      if (!images || !item.ids || item.ids.length < 2)
        return this.deletedPlaceholder(item, seq, deletionType);
      const index = images.findIndex((image) => image.msgId === seq);
      if (index < 0) return item;
      const data = item.data;
      const replacements: CbItem<ChatItemData>[] = [];
      const appendMedia = (members: typeof images) => {
        if (!members.length) return;
        const head = members[0];
        const ids = [...new Set(members.map((image) => image.msgId!))];
        replacements.push({
          id: ids[0],
          ids: ids.length > 1 ? ids : undefined,
          data: {
            ...data,
            msgId: ids[0],
            contentType: head.kind === 'video' ? 'VIDEO' : 'IMAGE',
            images: members,
          },
        });
      };
      appendMedia(images.slice(0, index));
      replacements.push(
        this.deletedPlaceholder(
          { ...item, boundary: undefined },
          seq,
          deletionType,
        ),
      );
      appendMedia(
        images.slice(index + 1).filter((image) => image.msgId !== seq),
      );
      if (item.boundary === 'oldest' || item.boundary === 'both')
        replacements[0].boundary = 'oldest';
      if (item.boundary === 'newest' || item.boundary === 'both')
        replacements[replacements.length - 1].boundary =
          replacements.length === 1 && item.boundary === 'both'
            ? 'both'
            : 'newest';
      return replacements;
    });
  }

  private deletedPlaceholder(
    item: CbItem<ChatItemData>,
    seq: number,
    deletionType: 'USER_RETRACTION' | 'MODERATION_REMOVAL',
  ): CbItem<ChatItemData> {
    if (item.data.type === 'serverGap')
      throw new Error('server-gap item cannot be replaced with a deletion notice');
    return {
      id: seq,
      ...(item.boundary ? { boundary: item.boundary } : {}),
      data: {
        type: 'system',
        contentType: 'SYSTEM',
        msgId: seq,
        threadId: item.data.threadId,
        isSelf: false,
        isGroupConversation: item.data.isGroupConversation,
        name: '',
        text: '',
        time: '',
        images: null,
        file: null,
        createdAtMs: item.data.createdAtMs,
        deletionType,
      },
    };
  }

  private hideNativeComposer(resetGeometry = false): void {
    this.nativeComposerBounds.reset();
    const contextId = this.nativeComposerContextId;
    if (contextId !== null) this.nativeComposer.hide(contextId);
    if (resetGeometry) this.nativeComposer.resetGeometry();
    this.nativeComposerContextId = null;
    this.nativeComposerThreadId = null;
  }

  private observeNativeComposerBounds(contextId: number): void {
    this.nativeComposerBounds.observe(
      this.containerRef()?.nativeElement,
      contextId,
    );
  }

  private handleNativeComposerEvent(event: NativeComposerEvent): void {
    // Saving a draft reads and writes signal-backed state. A native event effect
    // must not subscribe to those signals and replay the same event indefinitely.
    untracked(() => this.dispatchNativeComposerEvent(event));
  }

  private dispatchNativeComposerEvent(event: NativeComposerEvent): void {
    switch (event.kind) {
      case 'interaction':
        if (this.chatboxDialogOpen()) this.route.closeDlg();
        return;
      case 'sendText': {
        const text = event.text.trim();
        const accepted = text.length > 0;
        if (accepted) {
          const leadingTrim = event.text.length - event.text.trimStart().length;
          const mentions = (event.mentions ?? []).map((mention) => ({
            ...mention,
            start: mention.start - leadingTrim,
            end: mention.end - leadingTrim,
          }));
          const stored = serializeNativeComposerText(text, mentions);
          this.onSendIntent({ kind: 'text', text: stored });
        }
        this.nativeComposer.acknowledge(event.actionId, accepted);
        if (accepted) {
          this.nativeDraft.set('');
          this.nativeDraft.clearLink();
          this.saveNativeComposerDraft();
        }
        return;
      }
      case 'cancelQuote':
        this.cancelQuote();
        return;
      case 'pickAttachment':
        void this.pickNativeComposerAttachment(event);
        return;
      case 'pasteFiles':
        this.appendNativePaste(event.files);
        return;
      case 'draft':
        this.nativeDraft.set(event.text);
        this.saveNativeComposerDraft();
        return;
      case 'openLinkCard':
        this.openComposerLinkWebDialog(event.url, event.text);
        return;
      case 'linkMarkers':
        this.nativeDraft.set(event.text);
        this.nativeDraft.selectLink(event.links[0]?.href ?? null);
        this.saveNativeComposerDraft();
        return;
      case 'destroy':
        this.nativeDraft.set(event.text);
        this.saveNativeComposerDraft();
        return;
      case 'geometry':
      case 'recording':
        return;
    }
  }

  /** Existing Web dialog opened by the native composer's link action. */
  private composerLinkWebDialog?: DlgRef;

  private openComposerLinkWebDialog(url: string, text: string): void {
    const binding = this.lifecycle.binding;
    if (!binding || !url || this.composerLinkWebDialog) return;
    this.nativeDraft.set(text);
    this.nativeDraft.consumeLink(
      url,
      text,
      (generationId) => {
        if (binding.signal.aborted || this.lifecycle.binding !== binding)
          return;
        this.saveNativeComposerDraft();
        const close = () => {
          const dialog = this.composerLinkWebDialog;
          this.composerLinkWebDialog = undefined;
          if (dialog) this.route.closeDialogAndAbove(dialog);
        };
        binding.signal.addEventListener('abort', close, { once: true });
        this.composerLinkWebDialog = this.route.popupDlg(
          PopupType.LINK_CARD_GENERATION,
          { generationId, originalText: text, mode: 'composer' },
          (result) => {
            binding.signal.removeEventListener('abort', close);
            this.composerLinkWebDialog = undefined;
            if (binding.signal.aborted || this.lifecycle.binding !== binding)
              return;
            if (result?.kind === 'retry') {
              this.nativeDraft.clearLink();
              this.openComposerLinkWebDialog(url, text);
            } else if (result?.kind === 'link') {
              this.onSendIntent(result);
            }
          },
          { scopeThreadId: binding.threadId },
        );
      },
      () => {
        if (!binding.signal.aborted)
          this.toast.warn(this.transloco.translate('linkCard.generateFailed'));
      },
    );
  }

  private async pickNativeComposerAttachment(
    event: Extract<NativeComposerEvent, { kind: 'pickAttachment' }>,
  ): Promise<void> {
    const binding = this.lifecycle.binding;
    if (!binding) return;
    try {
      const files = await this.nativeUploads.pick(
        event.source === 'gallery' ? 'image' : 'file',
      );
      if (binding.signal.aborted) return;
      if (files.length) this.onSendIntent({ kind: 'native-files', files });
      this.nativeComposer.acknowledge(event.actionId, true);
    } catch {
      if (binding.signal.aborted) return;
      this.nativeComposer.acknowledge(event.actionId, false);
      this.toast.warn(this.transloco.translate('transfer.pickFailed'));
    }
  }

  /** Synchronize input changes without reviving a resident explicitly idled by the host. */
  private synchronizeKernel(): void {
    const vp = this.viewportRef();
    const ct = this.contentRef();
    const trd = this.userMsgTrd();
    const opening = this.nav.chatOpening();
    if (!vp || !ct) return;
    if (!this.scroller)
      this.prepareScroller(vp.nativeElement, ct.nativeElement);
    const binding = this.lifecycle.binding;
    if (!binding || !trd || binding.threadId !== trd.threadId) return;
    const presentation = this.presentation();
    if (this.blockedPeer()) {
      if (presentation !== 'blocked') {
        untracked(() => {
          this.reload();
        });
      }
      return;
    }
    if (presentation === 'blocked') {
      untracked(() => this.reload());
      return;
    }
    // Native delivery can outlive the WebView projection. Mount from live thread state;
    // the foreground drain need not finish before the cached page can be presented.
    if (isAndroidNative() && !this.appVisible()) return;
    // Metadata advances and repeated entries feed the existing source, never a new window.
    const latestSeq = Math.max(
      trd.messageEndSeq,
      this.convList.latestSeq(trd.threadId) ?? 0,
      opening?.threadId === trd.threadId ? opening.latestSeq : 0,
    );
    untracked(() => this.source?.refreshLatest?.(latestSeq));
    if (this.resumeAfterBackground && this.currentTrdId === trd.threadId) {
      if (!this.kernelReady) {
        this.initialLoading();
        return;
      }
      this.resumeAfterBackground = false;
      untracked(() => {
        this.applyUnreadDivider(trd.threadId);
        const latestSeq = Math.max(
          this.convList.latestSeq(trd.threadId) ?? -1,
          trd.messageEndSeq,
        );
        this.source?.resumeLiveUpdates?.(latestSeq);
        this.unreadDividerReady.set(true);
      });
      return;
    }
  }

  /** Foreground ownership belongs to the shell, not network history readiness. */
  private synchronizeForeground(): void {
    const binding = this.lifecycle.binding;
    const foreground =
      this.nativeComposerActive() &&
      this.convList.openThreadId() === binding?.threadId;
    if (binding)
      untracked(() => this.lifecycle.activate(binding, foreground));
  }

  /** Lifecycle notifications are synchronous; Angular effects only project metadata. */
  private applyLifecycle(state: ChatSurfaceState): void {
    if (state.phase === 'bound') {
      if (this.presentation() !== 'unbound') return;
      const thread = this.userMsgTrd();
      if (!thread || thread.threadId !== state.binding.threadId) return;
      this.presentation.set('loading');
      if (thread.blocked) this.presentBlockedThread(thread.threadId);
      else {
        this.initialLoading.set(true);
        this.initialLoadFailed.set(false);
        this.unreadDividerReady.set(false);
        // The bound shell/composer is ready independently of history setup.
        // A host may synchronously revoke this binding while promoting it.
        this.ready.emit(thread.threadId);
        if (this.lifecycle.binding === state.binding)
          this.initScroller(thread);
      }
      return;
    }
    this.hideNativeComposer();
    this.teardown();
    this.presentation.set('unbound');
    this.initialLoading.set(false);
    this.initialLoadFailed.set(false);
    if (state.phase === 'destroyed') this.scroller?.destroy();
  }

  private prepareScroller(
    viewport: HTMLDivElement,
    content: HTMLDivElement,
  ): void {
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      hooks: {
        updateTailPresentation: (newest) => this.syncTailCue(newest),
        messageSeqs: (item) =>
          item.data.type === 'serverGap' ? [] : (item.ids ?? [item.id]),
        createItem: (item, prev, presentation) => presentation.kind !== 'message'
          ? createGhostCbElement()
          : this.createItem(item, prev),
        mergeItems: (items) =>
          mergeAlbumItemsAtBoundary(items, this.scrollState.firstUnreadSeq),
        absorbTail: (target, incoming) =>
          incoming.id === this.scrollState.firstUnreadSeq
            ? null
            : absorbAlbumTail(target, incoming),
      },
      onWindowJump: (options) => this.replaceMessageWindow(options),
      onScroll: (info) => this.onScroll(info),
      onViewportPaint: () => this.updateStickyOverlays(),
      committedTombs$: this.threadAdapter.deletedLive$,
      onMountedTomb: ({ seq, type }) =>
        this.replaceMountedDeletedMessage(seq, type),
      onFullyVisibleEnter: (entries) => {
        for (const entry of entries) {
          this.pulseVisibleMention(entry.item, entry.el);
          this.stableRead.noteFullyVisible(entry.item.ids ?? [entry.item.id]);
        }
      },
      // Entry catch-up preserves its own anchor; ordinary arrivals may follow
      // the bottom after the kernel applies the measured batch-height limit.
      config: {
        ...this.threadAdapter.scrollerConfig(),
        followBottom: true,
      },
      isFrozen: () => this.layout.reflowFrozen(),
    });
    this.threadAdapter.configureScroller(this.scroller);
  }

  private initializationSubscription?: Subscription;
  private deletionSurfaceSubscription?: Subscription;
  private unreadReanchorTimer?: ReturnType<typeof setTimeout>;

  private initScroller(trd: ConversationItem): void {
    const binding = this.lifecycle.binding;
    if (!binding || !this.scroller) return;
    this.deletionSurfaceSubscription =
      this.threadAdapter.deletedLive$.subscribe({
        next: ({ threadId, deletions }) => {
          if (threadId !== binding.threadId) return;
          // This subscription owns detached surfaces only. The kernel consumes
          // committed tombs for mounted bodies after load-result application.
          for (const { seq } of deletions)
            this.closeDeletedMessageSurfaces(threadId, seq);
        },
      });
    this.openMessageWindow(trd, { kind: 'openConversation' });
  }

  private loadMessageWindow(
    source: MessageThreadSource,
    scroller: ChatBoxScroller<ChatItemData>,
    scenario: MessageWindowScenario,
  ): Observable<void> {
    switch (scenario.kind) {
      case 'openConversation':
        return defer(() => source.prepareEntry()).pipe(
          concatMap((entry) => {
            // Both cached and cold entry use the same read-position window.
            // The source retains the local around-read result for this load.
            if (entry.lastReadSeq === 0)
              return scroller.openWindow({ kind: 'start' });
            return scroller.openWindow({
              kind: 'message',
              messageId: entry.lastReadSeq,
              anchor: 'center',
            });
          }),
        );
      case 'jumpToMessage':
        return defer(() =>
          scroller.openWindow({
            kind: 'message',
            messageId: scenario.messageSeq,
            anchor: scenario.anchor,
            highlight: scenario.highlight,
          }),
        );
      case 'goToLatest':
        return defer(() => scroller.openWindow({ kind: 'latest' }));
    }
  }

  /** Message-window resources only. Conversation/editor ownership is unchanged. */
  private openMessageWindow(
    trd: ConversationItem,
    scenario: MessageWindowScenario,
  ): void {
    if (!this.scroller) return;
    const initStartedAt = performance.now();
    if (isDevMode()) {
      console.log('[chat-perf] scroller:init', {
        threadId: trd.threadId,
      });
    }
    this.source = this.threadAdapter.createSource(
      trd,
      this.convList.entryReadSeq(trd.threadId),
      {
        onHistoryIntervalStarted: () => {
          const generation = this.tailAuthorCache.captureGeneration();
          const binding = this.lifecycle.binding;
          return (left, right) => {
            if (this.lifecycle.binding !== binding || this.threadId() !== trd.threadId)
              return;
            if (this.tailAuthorCache.consumeCoveredInterval(left, right, generation))
              this.scroller?.refreshTailPresentation();
          };
        },
        onNewerAvailable: (_seq, previousLatestSeq) => {
          this.scrollState.noteNewerAvailable();
          this.scroller?.notifyNewerAvailable?.(previousLatestSeq);
        },
        onQuoteUpdated: (replySeq, quote) => {
          this.scroller?.mutateItem(replySeq, (item) => ({
            ...item,
            data: { ...item.data, quote },
          }));
        },
        onQuoteDeleted: (replySeq: number, targetSeq: number) => {
          this.scroller?.mutateItem(replySeq, (item) => ({
            ...item,
            // Coordinate-only quote: the tombstone stays jumpable.
            data: { ...item.data, quote: { kind: 'jumpable', seq: targetSeq } },
          }));
        },
      },
    );
    this.scroller.bind(this.source, { chatId: trd.threadId });
    this.initialLoading.set(true);
    this.initialLoadFailed.set(false);
    this.unreadDividerReady.set(false);
    // Freeze unread eligibility before mounting can publish visible-message reads.
    // It remains independent of the entry cursor used to select a history window.
    this.scrollState.open(
      this.convList.captureUnreadEntryBoundary(trd.threadId)?.firstUnreadSeq ??
        null,
    );
    const source = this.source;
    const scroller = this.scroller;
    this.initializationSubscription = this.loadMessageWindow(
      source,
      scroller,
      scenario,
    )
      .pipe(
        tap(() => {
          if (
            scenario.kind === 'jumpToMessage' &&
            !scroller.getMountedGeometry(scenario.messageSeq)
          ) {
            this.initialLoading.set(false);
            this.windowJumpState.set('missing');
            this.completeWindowNavigation(false);
            return;
          }
          this.windowJumpState.set('idle');
          this.presentation.set('history');
          if (!isAndroidNative() || this.appVisible()) {
            this.applyUnreadDivider(trd.threadId);
            this.unreadDividerReady.set(true);
          }
          this.initialLoading.set(false);
          // `onScroll` normally runs after the initial batch mounts, but the first paint must not depend on that
          // kernel callback: explicitly recompute once init has settled so a top-anchored unread divider suppresses
          // the floating date pill before the pane is handed to the user.
          this.updateStickyOverlays();
          if (isDevMode()) {
            console.log('[chat-perf] scroller:ready', {
              threadId: trd.threadId,
              elapsedMs: Math.round(performance.now() - initStartedAt),
            });
          }
          // Only after the DB/scroller phase is complete may the source compare the locally-loaded tail with
          // BOTH remote ceilings and fall through to HTTP: the live-session HWM plus the durable thread
          // metadata. The latter is load-bearing after an IndexedDB→SQLite migration / fresh install, where
          // the thread row can say messageEndSeq=258 while the local messages table is legitimately empty.
          source.finishLocalInit?.(
            this.convList.latestSeq(trd.threadId),
            Math.max(
              trd.messageEndSeq,
              this.nav.chatOpening()?.threadId === trd.threadId
                ? this.nav.chatOpening()!.latestSeq
                : 0,
            ),
          );
          // Notify last: the host may synchronously unbind this pane on readiness.
          switch (scenario.kind) {
            case 'openConversation':
              // The shell was already presented before history completed.
              break;
            case 'jumpToMessage':
            case 'goToLatest':
              this.completeWindowNavigation(true);
              break;
          }
        }),
        catchError((error) => {
          this.initialLoading.set(false);
          switch (scenario.kind) {
            case 'openConversation':
              this.initialLoadFailed.set(true);
              this.presentation.set('error');
              // Keep the already-presented shell and composer available for retry.
              break;
            case 'jumpToMessage':
            case 'goToLatest':
              this.windowJumpState.set('failed');
              this.completeWindowNavigation(false);
              break;
          }
          if (isDevMode())
            console.warn('[chat] initial message load failed', error);
          return EMPTY;
        }),
      )
      .subscribe();
  }

  /** Kernel createItem hook: compute grouping flags from the older neighbor prev, wrap the real component.
   *  Passes onOpenImage so clicking a media cell opens the immersive viewer. */
  private createItem(
    item: CbItem<ChatItemData>,
    prev: CbItem<ChatItemData> | null,
  ): CbElement<ChatItemData> {
    // Real items only — the topmost skeleton-slot decision (prev/boundary/noOlder) lives in the kernel's createVs,
    // rendered via the createSkeleton hook supplied below. createItem never branches on ghost-vs-real: that rule
    // drifted between playground and production and is what swallowed the empty-thread first message.
    if (item.data.type === 'serverGap') {
      return createServerGapCbElement(
        item,
        String(
          this.transloco.translate(
            item.data.state === 'SERVER_PENDING'
              ? 'chat.serverGapPending'
              : 'chat.serverGapUnavailable',
          ),
        ),
      );
    }
    const { isShowHead, isGroupStart, showDate } = computeRowFlags(item, prev);
    const isUnreadStart =
      this.scrollState.firstUnreadSeq !== null &&
      (item.id === this.scrollState.firstUnreadSeq ||
        item.ids?.includes(this.scrollState.firstUnreadSeq) === true);
    const rendered = createMsgCbElement(
      item,
      isShowHead,
      isGroupStart,
      showDate,
      this.envInjector,
      (images, index) =>
        this.galleryViewer.open(images, index, this.threadId() ?? 0),
      (data) => this.galleryViewer.openFile(data, this.threadId() ?? 0),
      isUnreadStart
        ? String(this.transloco.translate('chat.unreadDivider'))
        : undefined,
      (event, selectedItem, pointer, memberId) =>
        this.onMessageInteraction(event, selectedItem, pointer, memberId),
      (bundleId) => this.route.popupDlg(PopupType.FORWARD_DETAIL, { bundleId }),
      async (anchor) => {
        await this.jumpToQuoteAnchor(anchor);
      },
      (userId, anchor) => void this.openSenderProfile(userId, anchor),
    );
    const contextId = this.messageContextMenu()?.targetSeq;
    applyMessageSelectionState(
      rendered.el,
      messageMemberIds(item),
      this.selectionMode(),
      this.selectedMessageIds(),
      contextId,
    );
    if (item.data.quote && this.source?.mountQuote) {
      const unregister = this.source.mountQuote(item.id, item.data.quote);
      const predestory = rendered.predestory?.bind(rendered);
      const destroy = rendered.destroy.bind(rendered);
      const quoteLifetime = new CbItemLifetime();
      quoteLifetime.onPredestory(unregister);
      quoteLifetime.onPredestory(() => predestory?.());
      quoteLifetime.onDestroy(destroy);
      rendered.predestory = () => quoteLifetime.predestory();
      rendered.destroy = () => quoteLifetime.destroy();
    }
    this.bindTailCue(rendered, item);
    return rendered;
  }

  private readonly messageRepo = inject(MessageRepository);
  private readonly sendingPresentation = inject(SendingTaskPresentation);
  private readonly tailAuthorCache = new TailAuthorCache(
    () => {
      const profile = this.userService.sessionProfile();
      return profile
        ? { account: profile.account, namespaceId: profile.namespaceId ?? 0 }
        : null;
    },
    () => this.userMsgTrd()?.type === 'GROUP',
  );
  private tailCacheThreadId = 0;
  private tailSummary = { messageCount: 0, uploadCount: 0, failedCount: 0 };
  readonly tailCueVisible = signal(false);
  private readonly tailCues = new Map<HTMLElement, { sync: (enabled: boolean) => boolean; cue: HTMLElement; contains: (seq: number) => boolean }>();

  private bindTailCue(rendered: CbElement<ChatItemData>, item: CbItem<ChatItemData>): void {
    const ref = createComponent(TailActivityRowComponent, { environmentInjector: this.envInjector });
    const app = this.envInjector.get(ApplicationRef);
    app.attachView(ref.hostView);
    const cue = ref.location.nativeElement as HTMLElement;
    ref.setInput('summary', this.tailSummary);
    ref.setInput('selfContinuation', item.data.type === 'msg' && item.data.isSelf && item.data.contentType === 'PURE_TEXT');
    ref.setInput('peerContinuation', item.data.type === 'msg' && !item.data.isSelf && item.data.contentType === 'PURE_TEXT');
    const lifetime = new CbItemLifetime();
    const panelSubscription = ref.instance.openPanel.subscribe(() => this.openUploadDetails());
    lifetime.onPredestory(() => panelSubscription.unsubscribe());
    lifetime.onPredestory(() => ref.changeDetectorRef.detach());
    // Tail controls are not part of the server message's selection/context gesture.
    const stop = (event: Event) => event.stopPropagation();
    cue.addEventListener('pointerdown', stop);
    cue.addEventListener('click', stop);
    cue.addEventListener('contextmenu', stop);
    rendered.el.append(cue);
    rendered.measureTailHeight = () => cue.offsetHeight;
    let currentItem = item;
    this.tailCues.set(rendered.el, { cue, contains: (seq) => (currentItem.ids ?? [currentItem.id]).includes(seq), sync: (next) => {
      if (!lifetime.active) return false;
      const beforeHeight = cue.offsetHeight;
      const snap = this.tailAuthorCache.project();
      const hasSelfSummary =
        this.tailSummary.messageCount > 0 ||
        this.tailSummary.uploadCount > 0 ||
        this.tailSummary.failedCount > 0;
      const primary = snap.primaryPeer
        ? this.tailPeerAvatar(snap.primaryPeer)
        : null;
      ref.setInput('enabled', next);
      ref.setInput('summary', this.tailSummary);
      ref.setInput('selfVisible', hasSelfSummary || snap.hasPendingSelf);
      ref.setInput('selfDotsVisible', snap.hasPendingSelf);
      ref.setInput('peerVisible', snap.hasPendingPeer);
      ref.setInput('primaryPeerProfile', primary?.profile);
      ref.setInput('primaryPeerAccount', primary?.account ?? null);
      ref.setInput('primaryPeerNamespaceId', primary?.namespaceId ?? null);
      ref.setInput('primaryPeerDomainSource', primary?.domainSource);
      ref.setInput(
        'overlapPeers',
        snap.overlapPeers.map((peer) => this.tailPeerAvatar(peer)),
      );
      ref.setInput('hasOverflow', snap.hasOverflow);
      ref.changeDetectorRef.detectChanges();
      return cue.offsetHeight !== beforeHeight;
    } });
    const observer = new ResizeObserver(() => this.updateTailCueVisibility());
    observer.observe(cue);
    const update = rendered.update.bind(rendered);
    rendered.update = (next, prev) => {
      if (!lifetime.active) return;
      currentItem = next;
      update(next, prev);
      ref.setInput('selfContinuation', next.data.type === 'msg' && next.data.isSelf && next.data.contentType === 'PURE_TEXT');
      ref.setInput('peerContinuation', next.data.type === 'msg' && !next.data.isSelf && next.data.contentType === 'PURE_TEXT');
    };
    const predestory = rendered.predestory?.bind(rendered);
    const destroy = rendered.destroy.bind(rendered);
    lifetime.onPredestory(() => observer.disconnect());
    lifetime.onPredestory(() => {
      cue.removeEventListener('pointerdown', stop);
      cue.removeEventListener('click', stop);
      cue.removeEventListener('contextmenu', stop);
      this.tailCues.delete(rendered.el);
    });
    lifetime.onPredestory(() => predestory?.());
    lifetime.onPredestory(() => this.updateTailCueVisibility());
    lifetime.onDestroy(() => ref.destroy());
    lifetime.onDestroy(destroy);
    rendered.predestory = () => lifetime.predestory();
    rendered.destroy = () => lifetime.destroy();
  }

  private tailPeerAvatar(peer: ThreadAuthor): TailOverlapPeerAvatar {
    const trd = this.userMsgTrd();
    const domainSource: AvatarDomainSource =
      trd?.type === 'GROUP'
        ? {
            type: 'profile-namespace',
            publisherNamespaceId: trd.publisherNamespaceId,
            profileNamespaceId: peer.namespaceId,
          }
        : { type: 'namespace', namespaceId: peer.namespaceId };
    let profile: AvatarProfileRef | undefined;
    if (
      trd?.type === 'P2P' &&
      trd.account === peer.account &&
      trd.publisherNamespaceId === peer.namespaceId
    ) {
      profile = conversationAvatarProfile(trd);
    } else if (trd?.type === 'GROUP' && trd.publisherNamespaceId === 0) {
      const p2p = this.convList
        .items()
        .find(
          (item) =>
            item.type === 'P2P' &&
            item.account === peer.account &&
            item.publisherNamespaceId === peer.namespaceId,
        );
      if (p2p) profile = conversationAvatarProfile(p2p);
    }
    return {
      key: `${peer.namespaceId}\0${peer.account}`,
      account: peer.account,
      namespaceId: peer.namespaceId,
      domainSource,
      profile,
    };
  }

  private updateTailCueVisibility(): void {
    let visible = false;
    for (const { cue } of this.tailCues.values()) {
      if (!cue.offsetHeight) continue;
      const viewport = this.viewportRef()?.nativeElement;
      if (!viewport) continue;
      const bounds = viewport.getBoundingClientRect();
      const rect = cue.getBoundingClientRect();
      if (isTailCueVisible(rect.top, rect.bottom, bounds.top, bounds.bottom, this.tailCueVisible()))
        visible = true;
    }
    this.tailCueVisible.set(
      visible || Boolean(this.scroller?.isPinnedToBottom()),
    );
  }

  private onMessageInteraction(
    intent: 'select' | 'open-menu',
    item: CbItem<ChatItemData>,
    pointer?: { x: number; y: number },
    memberId?: number,
  ): void {
    if (item.data.type === 'serverGap') return;
    if (intent === 'open-menu') {
      const contextItem =
        memberId === undefined
          ? (item as CbItem<ChatMsgData>)
          : this.messageInteraction.targetItem(
              item as CbItem<ChatMsgData>,
              memberId,
            );
      const itemCount =
        (this.canCopyMessage(contextItem.data) ? 1 : 0) +
        (this.canQuote(contextItem.data) ? 1 : 0) +
        (this.canDirectForward(contextItem.data) ? 1 : 0) +
        (this.canMultiSelect(contextItem.data) ? 1 : 0) +
        (this.canWithdrawOrReport(contextItem.data) ? 1 : 0);
      // An unconfirmed row can legitimately offer nothing (e.g. `accepted`:
      // committed server-side, awaiting the echo — no copy, no cancel). Open
      // no menu rather than an empty box.
      if (itemCount === 0) return;
      // +1 keeps the historical positioning headroom of the height estimate.
      const menuItemCount = 1 + itemCount;
      const visualViewport = window.visualViewport;
      const messageViewport =
        this.viewportRef()?.nativeElement.getBoundingClientRect();
      const bounds = {
        left: Math.max(
          visualViewport?.offsetLeft ?? 0,
          messageViewport?.left ?? 0,
        ),
        // Header space is valid fallback room; only the screen edge and composer are forbidden.
        top: visualViewport?.offsetTop ?? 0,
        right: Math.min(
          (visualViewport?.offsetLeft ?? 0) +
            (visualViewport?.width ?? window.innerWidth),
          messageViewport?.right ?? window.innerWidth,
        ),
        bottom: Math.min(
          (visualViewport?.offsetTop ?? 0) +
            (visualViewport?.height ?? window.innerHeight),
          messageViewport?.bottom ?? window.innerHeight,
        ),
      };
      this.messageInteraction.openContextMenu(
        item,
        memberId,
        pointer,
        bounds,
        menuItemCount,
      );
      this.contextMenuScrollTop = this.lastMessageScrollTop;
      this.syncMountedSelectionState();
      return;
    }
    this.messageInteraction.toggle(item, memberId);
    this.syncMountedSelectionState();
  }

  selectContextMessage(): void {
    if (this.messageInteraction.selectContextMessage())
      this.syncMountedSelectionState();
  }

  dismissContextMenu(): void {
    this.closeContextMenu();
  }

  private closeContextMenu(): void {
    if (this.messageInteraction.closeContextMenu())
      this.syncMountedSelectionState();
  }

  async copyContextMessage(): Promise<void> {
    const context = this.messageContextMenu();
    if (!context || !this.canCopyMessage(context.targetItem.data)) return;
    this.closeContextMenu();
    await this.writeMessageClipboard(
      messageCopyBody(context.targetItem.data, this.messageCopyLabels()),
      1,
      false,
    );
  }

  quoteContextMessage(): void {
    const context = this.messageContextMenu();
    if (
      !context ||
      context.targetSeq < 0 ||
      !this.canQuote(context.targetItem.data)
    )
      return;
    const data = context.targetItem.data;
    const visual = this.replyVisual(data);
    this.messageInteraction.setQuote({
      kind: 'jumpable',
      seq: context.targetSeq,
      author: data.name,
      body: this.forwarding.summary(data),
      contentType: data.contentType,
      ...visual,
    });
  }

  cancelQuote(): void {
    this.messageInteraction.cancelQuote();
  }

  async copySelectedMessages(): Promise<void> {
    const messages = this.messageInteraction
      .selectedItems()
      .map((item) => item.data);
    if (!messages.length) return;
    await this.writeMessageClipboard(
      selectedMessagesCopyText(messages, this.messageCopyLabels()),
      messages.length,
      true,
    );
  }

  private async writeMessageClipboard(
    text: string,
    count: number,
    exitSelection: boolean,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.info(
        this.transloco.translate('chat.selection.copied', { count }),
      );
      if (exitSelection) this.exitSelectionMode();
    } catch {
      this.toast.warn(this.transloco.translate('chat.selection.copyFailed'));
    }
  }

  private messageCopyLabels(): MessageCopyLabels {
    return {
      photo: this.transloco.translate('chat.preview.photo'),
      video: this.transloco.translate('chat.preview.video'),
      voice: this.transloco.translate('chat.preview.voice'),
      file: this.transloco.translate('chat.preview.file'),
      call: this.transloco.translate('forward.call'),
      forward: this.transloco.translate('forward.chatHistory'),
    };
  }

  dismissContextMenuOnOutside(event: PointerEvent): void {
    if (
      !this.messageContextMenu() ||
      (event.target instanceof Element &&
        event.target.closest('.msg-context-menu'))
    )
      return;
    this.dismissContextMenu();
  }

  private async openSenderProfile(
    profileRef: AvatarProfileRef | undefined,
    _anchor: DOMRect,
  ): Promise<void> {
    const conversation = this.userMsgTrd();
    if (conversation?.type === 'P2P') {
      if (!profileRef || conversation.account !== profileRef.account) return;
      this.dismissContextMenu();
      this.nav.openAside('profile');
      return;
    }
    const session = this.profileSession.capture();
    const threadId = this.threadId();
    if (threadId === undefined || !profileRef) return;
    const demand = avatarProfileDemand(profileRef);
    if (!demand) return;
    let profile: ResolvedProfile | undefined;
    try {
      profile = await firstValueFrom(this.profileRepo.resolve(demand));
    } catch {
      return;
    }
    if (!profile) return;
    this.dismissContextMenu();
    // Resolve the member's namespace in the group's publisher space.
    // A member namespace is never a receiver-local publisher ID.
    const memberHomeDomain = await firstValueFrom(
      this.namespaces
        .resolve({
          publisherNamespaceId: profileRef.publisherNamespaceId,
          profileNamespaceId: profileRef.profileNamespaceId,
        })
        .pipe(
          map(namespaceDisplayDomain),
          catchError(() => of(null)),
        ),
    );
    if (!this.profileSession.isCurrent(session) || this.threadId() !== threadId)
      return;
    const friendThreadId = this.convList
      .items()
      .find(
        (item) =>
          item.type === 'P2P' &&
          item.account === profile.account &&
          item.conversationState === 'ACTIVE',
      )?.threadId;
    this.route.popupDlg(
      PopupType.CONTACT_IDENTITY,
      {
        identity: {
          account: profile.account,
          name: profile.name,
          profile: profileRef,
          bio: profile.bio,
          domain: memberHomeDomain ?? '',
          namespaceId: profile.namespaceId,
          friendThreadId,
          relationship:
            profile.account === this.userService.sessionProfile()?.account
              ? 'SELF'
              : friendThreadId === undefined
                ? 'NONE'
                : 'FRIEND',
        },
      },
      undefined,
      { scopeThreadId: threadId },
    );
  }

  exitSelectionMode(): void {
    this.messageInteraction.resetSelection();
    this.syncMountedSelectionState();
  }

  openContextForwardDialog(): void {
    const context = this.messageContextMenu();
    if (!context || !this.canDirectForward(context.targetItem.data)) return;
    this.closeContextMenu();
    this.openForwardDialog([context.targetItem], 'DIRECT');
  }

  private canWithdraw(message: ChatMsgData): boolean {
    if (!message.isSelf) return false;
    const thread = this.userMsgTrd();
    if (thread?.type === 'P2P' && thread.conversationState === 'READ_ONLY')
      return false;
    if (thread?.type === 'GROUP' && this.readOnlyGroup()) return false;
    return true;
  }

  canMultiSelect(message: ChatMsgData): boolean {
    return isConfirmedMessage(message) && message.type === 'msg';
  }

  canWithdrawOrReport(message: ChatMsgData): boolean {
    return (
      isConfirmedMessage(message) &&
      message.contentType !== 'SYSTEM' &&
      (!message.isSelf || this.canWithdraw(message))
    );
  }

  confirmContextModeration(): void {
    const context = this.messageContextMenu();
    if (!context || !this.canWithdrawOrReport(context.targetItem.data)) return;
    const message = context.targetItem.data;
    const threadId = this.threadId();
    const seq = context.targetSeq;
    if (threadId === undefined || seq < 0) return;
    this.closeContextMenu();
    const withdraw = message.isSelf;
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: withdraw
          ? 'chat.withdrawConfirmTitle'
          : 'chat.reportConfirmTitle',
        messageKey: withdraw
          ? 'chat.withdrawConfirmBody'
          : 'chat.reportConfirmBody',
        confirmKey: withdraw ? 'chat.withdraw' : 'chat.report',
        cancelKey: 'common.cancel',
        danger: withdraw,
      },
      (ok) => {
        if (!ok) return;
        if (withdraw) this.withdrawMessage(threadId, seq);
        else this.reportMessage(threadId, seq);
      },
      { scopeThreadId: threadId },
    );
  }

  private withdrawMessage(threadId: number, seq: number): void {
    this.threadAdapter.withdrawMessage({ threadId, seq }).subscribe({
      next: (res) => {
        if (res.code !== BusinessCode.OK) {
          this.toast.warn(translateBizResult(res, this.transloco));
          return;
        }
        // Row replacement and detached-surface cleanup are owned by the
        // authoritative deletion notification, not this HTTP acknowledgement.
        // The backend enqueues a thread-content fan-out that pushes a
        // THREAD_FEED_UPDATED wake; the SSE → DB-worker pipeline advances
        // tombstoneEndSeq and re-drains the tombstone stream. No eager pull.
      },
      error: () =>
        this.toast.warn(this.transloco.translate('chat.withdrawFailed')),
    });
  }

  private reportMessage(threadId: number, seq: number): void {
    this.threadAdapter.reportMessage({ threadId, seq }).subscribe({
      next: (res) => {
        if (res.code !== BusinessCode.OK) {
          this.toast.warn(translateBizResult(res, this.transloco));
          return;
        }
        this.toast.info(this.transloco.translate('chat.reportSubmitted'));
      },
      error: () =>
        this.toast.warn(this.transloco.translate('chat.reportFailed')),
    });
  }

  canDirectForward(message: ChatMsgData): boolean {
    return (
      isConfirmedMessage(message) &&
      (message.contentType === 'PURE_TEXT' ||
        message.contentType === 'IMAGE' ||
        message.contentType === 'VIDEO' ||
        message.contentType === 'AUDIO' ||
        message.contentType === 'FILE' ||
        message.contentType === 'LINK' ||
        message.contentType === 'FORWARD' ||
        message.contentType === 'CONTACT_CARD')
    );
  }

  canCopyMessage(message: ChatMsgData): boolean {
    return isConfirmedMessage(message) && canCopyMessage(message);
  }

  canQuote(message: ChatMsgData): boolean {
    return isConfirmedMessage(message) && message.contentType !== 'SYSTEM';
  }

  openSelectedForwardDialog(): void {
    const items = this.messageInteraction.selectedItems();
    if (items.length) this.openForwardDialog(items, 'HISTORY');
  }

  private openForwardDialog(
    items: readonly CbItem<ChatMsgData>[],
    mode: 'DIRECT' | 'HISTORY',
  ): void {
    const source = this.convList
      .items()
      .find((thread) => thread.threadId === this.threadId());
    const sourceThreadId = this.threadId();
    if (!sourceThreadId) return;
    this.forwarding.open(
      items,
      mode,
      sourceThreadId,
      source?.type === 'GROUP' ? 'group' : 'chat',
      () => this.exitSelectionMode(),
    );
  }

  private replyVisual(
    message: ChatMsgData,
  ): Pick<
    import('../message-cards/chat-item').QuotePresentation,
    'image' | 'imageLabel' | 'imageIdentity' | 'imageSize' | 'imageShape'
  > {
    if (message.contentType === 'IMAGE' && message.images?.[0]?.src)
      return {
        image: message.images[0].src,
        imageSize: message.images[0].size,
        imageShape: 'thumbnail',
      };
    if (message.contentType === 'CONTACT_CARD') {
      try {
        const card = JSON.parse(message.text) as Record<string, unknown>;
        return {
          ...(typeof card['avatar'] === 'string'
            ? { image: card['avatar'] }
            : {}),
          ...(typeof card['displayName'] === 'string'
            ? { imageLabel: card['displayName'] }
            : {}),
          ...(typeof card['account'] === 'string'
            ? { imageIdentity: card['account'] }
            : {}),
          imageShape: 'avatar',
        };
      } catch {
        return {};
      }
    }
    if (message.contentType !== 'LINK') return {};
    try {
      const card = JSON.parse(message.text) as Record<string, unknown>;
      return typeof card['image'] === 'string'
        ? { image: card['image'], imageShape: 'thumbnail' }
        : {};
    } catch {
      return {};
    }
  }

  quoteAvatarType(identity: string | undefined): UserAvatarType {
    return identity?.startsWith('!')
      ? UserAvatarType.GROUP
      : UserAvatarType.OTHER;
  }

  private syncMountedSelectionState(): void {
    const active = this.selectionMode();
    const selected = this.selectedMessageIds();
    const contextId = this.messageContextMenu()?.targetSeq;
    this.contentRef()
      ?.nativeElement.querySelectorAll<HTMLElement>('[data-message-id]')
      .forEach((host) => {
        const id = Number(host.dataset['messageId']);
        const memberIds = (host.dataset['messageMemberIds'] ?? String(id))
          .split(',')
          .map(Number)
          .filter(Number.isFinite);
        applyMessageSelectionState(
          host,
          memberIds,
          active,
          selected,
          contextId,
        );
      });
  }

  @HostListener('document:visibilitychange')
  onAppVisibilityChange(): void {
    if (!isAndroidNative()) return;
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      // Commit only what was already visible before leaving the screen. Neither
      // in-flight SSE nor later background mounts may advance the read cursor.
      this.stableRead.noteFullyVisible(
        this.scroller?.getFullyVisibleIds() ?? [],
      );
      this.stableRead.flush();
      this.stableRead.reset();
      this.unreadDividerReady.set(false);
      this.source?.pauseLiveUpdates?.();
      if (this.currentTrdId !== null) {
        this.resumeAfterBackground = true;
        this.convList.resetUnreadEntryBoundary(this.currentTrdId);
      }
    }
    this.appVisible.set(visible);
  }

  /** The initial pane and a retained pane share the boundary calculation, but
   * reactivation replaces measured rows in place rather than remounting the kernel. */
  private applyUnreadDivider(threadId: number): void {
    const previous = this.scrollState.firstUnreadSeq;
    const next =
      this.convList.captureUnreadEntryBoundary(threadId)?.firstUnreadSeq ??
      null;
    if (previous === next) return;
    this.scrollState.open(next);
    this.pendingDividerRefresh = [
      ...new Set([previous, next].filter((seq): seq is number => seq !== null)),
    ];
    this.refreshMountedDivider();
    this.updateStickyOverlays();
  }

  private refreshMountedDivider(): void {
    const scroller = this.scroller;
    if (!scroller || this.pendingDividerRefresh.length === 0) return;
    const pending = this.pendingDividerRefresh;
    this.pendingDividerRefresh = [];
    for (const seq of pending) {
      if (
        scroller.getMountedGeometry(seq) &&
        !scroller.mutateItem(seq, (item) => ({ ...item }))
      )
        this.pendingDividerRefresh.push(seq);
    }
  }

  private latestTailEnd(): number {
    const opening = this.nav.chatOpening();
    return Math.max(
      this.convList.latestSeq(this.threadId() ?? 0) ?? 0,
      this.userMsgTrd()?.messageEndSeq ?? 0,
      opening && opening.threadId === this.threadId() ? opening.latestSeq : 0,
    );
  }

  private syncTailCue(newestItem: CbItem<ChatItemData> | null): HTMLElement[] {
    // The kernel selects the live-tail host. Row identity only locates that host;
    // neither mounted bodies nor album members are evidence of a fetched gap.
    const changed: HTMLElement[] = [];
    for (const [el, row] of this.tailCues) {
      if (row.sync(newestItem !== null && row.contains(newestItem.id))) changed.push(el);
    }
    return changed;
  }

  private onScroll(info: CbScrollInfo): void {
    this.updateTailCueVisibility();
    this.refreshMountedDivider();
    if (
      this.messageContextMenu() &&
      Math.abs(info.scrollTop - this.contextMenuScrollTop) > 0.5
    )
      this.closeContextMenu();
    this.lastMessageScrollTop = info.scrollTop;
    const unreadReanchor = this.scrollState.update(info, this.scroller);
    this.stableRead.noteScroll();
    if (unreadReanchor !== null) {
      if (this.lifecycle.binding) {
        // Re-anchoring mutates the scroller: defer until its scroll callback returns.
        clearTimeout(this.unreadReanchorTimer);
        this.unreadReanchorTimer = setTimeout(() => {
          this.unreadReanchorTimer = undefined;
          void jumpToMessage(this.scroller, unreadReanchor, 0);
        }, 0);
      }
    }
  }

  private pulseVisibleMention(
    item: CbItem<ChatItemData>,
    host: HTMLElement,
  ): void {
    if (
      item.data.type !== 'msg' ||
      item.data.contentType !== 'PURE_TEXT' ||
      item.data.isSelf ||
      (item.data.mentionState !== 'me' && item.data.mentionState !== 'all')
    )
      return;
    const isMe = item.data.mentionState === 'me';
    const className = isMe ? 'cb-mention-me-pulse' : 'cb-mention-all-pulse';
    const animName = isMe ? 'mention-me-visible' : 'mention-all-visible';
    host.classList.remove(className);
    void host.offsetWidth;
    host.classList.add(className);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      host.removeEventListener('animationend', onEnd);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      host.classList.remove(className);
    };
    const onEnd = (event: AnimationEvent) => {
      if (event.animationName === animName) {
        cleanup();
      }
    };
    host.addEventListener('animationend', onEnd);
    timer = setTimeout(cleanup, 1600);
  }

  updateStickyOverlays(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    const scroller = this.scroller;
    if (!vp || !ct || !scroller) {
      this.stickyOverlays()?.clear();
      return;
    }
    this.stickyOverlays()?.refresh(
      {
        viewport: vp,
        content: ct,
        header: this.headerRef()?.nativeElement,
        container: this.containerRef()?.nativeElement ?? vp,
        scroller,
      },
      document.documentElement.getAttribute('data-show-self-avatar') === 'true',
    );
  }

  /** Recompute the sticky-date pill when the keyboard-lift `transform` settles on the viewport. The
   *  transform fires no scroll event, so `onScroll` alone would leave the pill on its pre-lift label across
   *  a keyboard open/close; this closes that gap. {@link isViewportTransformEnd} filters to the viewport's
   *  own `transform` (ignoring bubbled item transitions like `cb-move`). */
  onViewportTransitionEnd(event: TransitionEvent): void {
    if (!isViewportTransformEnd(event, this.viewportRef()?.nativeElement))
      return;
    this.stickyOverlays()?.invalidateLayout();
    this.updateStickyOverlays();
  }

  scrollToLatest(): void {
    void this.scroller?.goToLatest();
  }

  scrollToUnread(): void {
    if (this.scrollState.firstUnreadSeq !== null)
      void jumpToMessage(this.scroller, this.scrollState.firstUnreadSeq, 0);
  }

  openUploadDetails(): void {
    const binding = this.lifecycle.binding;
    if (!binding || binding.signal.aborted) return;
    const { threadId } = binding;
    this.route.popupDlg(PopupType.UPLOAD_DETAIL, {
      threadId,
      messageActions: {
        cancel: async (cid: string) => {
          if (!binding.signal.aborted) await this.cancelPending(cid);
        },
        retry: async (cid: string) => {
          if (!binding.signal.aborted) await this.retrySend(cid);
        },
      },
    }, undefined, { scopeThreadId: threadId });
  }

  // ---------- ChatInputComponent intent → optimistic dispatch ----------

  /** The composer emits one structured intent; route it to the matching optimistic-send path. */
  onSendIntent(intent: ChatSendIntent): void {
    if (!this.composerBinding() || !this.interactionActive()) return;
    this.composer.dispatch(intent);
  }

  private async chooseCombinedSend(count: number): Promise<boolean | null> {
    if (count < 2) return false;
    return new Promise((resolve) => {
      this.route.popupDlg(
        PopupType.CONFIRM,
        {
          titleKey: 'chat.multiSend.title',
          messageKey: 'chat.multiSend.message',
          messageParams: { count },
          confirmKey: 'chat.multiSend.combined',
          cancelKey: 'chat.multiSend.separate',
        },
        (result) =>
          resolve(result === true ? true : result === false ? false : null),
      );
    });
  }

  private async sendChosenWebAttachments(
    files: readonly File[],
  ): Promise<void> {
    const binding = this.lifecycle.binding;
    if (!binding) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const combined = await this.chooseCombinedSend(list.length);
    if (combined === null || binding.signal.aborted) return;
    if (combined) await this.sendWebGallery(list);
    else await this.sendAttachments(list);
  }

  private async sendChosenNativeAttachments(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    const binding = this.lifecycle.binding;
    if (!binding) return;
    const combined = await this.chooseCombinedSend(files.length);
    if (combined === null || binding.signal.aborted) return;
    // Native gallery upload uses the same atomic server barrier; its streaming implementation is
    // added alongside the batch retry resource. Until then, the secondary behavior remains exact.
    if (combined) await this.sendNativeGallery(files);
    else await this.sendNativeAttachments(files);
  }

  /** Register the complete selection synchronously, then probe media metadata in parallel. Decoding a
   * large image or locating video metadata can delay that file's upload, but never the pending UI. */
  private async sendAttachments(
    files: ArrayLike<File>,
    waitForUploads = false,
  ): Promise<void> {
    const threadId = this.threadId();
    if (!threadId) return;
    const uploads: Promise<void>[] = [];
    for (const file of Array.from(files)) {
      const descriptor = this.browserSendFiles.retain(file, uuid());
      const task = {
        clientMessageId: this.newClientMessageId(),
        threadId,
        item: { type: uploadIntentForMime(file.type), file: descriptor },
      };
      try {
        await this.sendOutbox.enqueue(task);
      } catch (error) {
        this.browserSendFiles.release(descriptor.path);
        throw error;
      }
      const upload = this.transfers.executeWeb(task);
      // Execution records the failed phase; awaiting callers additionally receive the error.
      if (!waitForUploads) void upload.catch(() => undefined);
      uploads.push(upload);
    }
    if (waitForUploads) await Promise.all(uploads);
  }

  private async sendWebGallery(files: readonly File[]): Promise<void> {
    const threadId = this.threadId();
    if (!threadId || files.length < 2) return;
    const cid = this.newClientMessageId();
    const descriptors = files.map(file => ({
      ...this.browserSendFiles.retain(file, uuid()), intent: uploadIntentForMime(file.type),
    }));
    const task = {
      clientMessageId: cid, threadId,
      item: { type: 'GALLERY' as const, files: descriptors },
    };
    try {
      await this.sendOutbox.enqueue(task);
    } catch (error) {
      for (const file of descriptors) this.browserSendFiles.release(file.path);
      throw error;
    }
    await afterNextPaint();
    await this.transfers.executeWeb(task);
  }

  private async sendNativeGallery(files: readonly NativeUploadSelection[]): Promise<void> {
    const threadId = this.threadId();
    if (!threadId || files.length < 2) return;
    const task = {
      clientMessageId: this.newClientMessageId(), threadId,
      item: { type: 'GALLERY' as const, files: files.map(file => ({
        ...this.nativeFileReference(file),
        intent: file.kind === 'image' ? 'IMAGE' as const : file.kind === 'video' ? 'VIDEO' as const : 'FILE' as const,
      })) },
    };
    await this.sendOutbox.enqueue(task);
    await this.transfers.executeNative(task);
  }

  private nativeFileReference(file: NativeUploadSelection) {
    return { path: file.path, partId: file.partId, name: file.name, mimeType: file.mimeType, size: file.size };
  }

  private async sendNativeAttachments(files: readonly NativeUploadSelection[]): Promise<void> {
    const threadId = this.threadId();
    if (!threadId) return;
    for (const file of files) {
      const task = {
        clientMessageId: this.newClientMessageId(), threadId,
        item: {
          type: file.kind === 'image' ? 'IMAGE' as const : file.kind === 'video' ? 'VIDEO' as const : 'FILE' as const,
          file: this.nativeFileReference(file),
        },
      };
      await this.sendOutbox.enqueue(task);
      void this.transfers.executeNative(task).catch(() => undefined);
    }
  }

  private appendWebPaste(files: readonly File[], text: string): void {
    this.appendComposerText(text);
    this.pasteQueue.appendWeb(files);
  }

  private appendNativePaste(files: readonly NativeUploadSelection[]): void {
    this.pasteQueue.appendNative(files);
  }

  appendPanelPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    this.appendWebPaste(Array.from(data.files), data.getData('text/plain'));
  }

  removePasteItem(id: string): void {
    this.pasteQueue.remove(id);
  }

  cancelPaste(): void {
    this.pasteQueue.cancel();
  }

  async confirmPaste(): Promise<void> {
    const items = this.pasteItems();
    if (items.length === 0) return;
    const combined = await this.chooseCombinedSend(items.length);
    if (combined === null) return;
    this.pasteQueue.take();
    if (combined && items.every((item) => item.source === 'web')) {
      const files = items.map(
        (item) => (item as Extract<ThreadPasteItem, { source: 'web' }>).file,
      );
      for (const item of items) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      await this.sendWebGallery(files);
      return;
    }
    if (combined && items.every((item) => item.source === 'native')) {
      await this.sendNativeGallery(
        items.map(
          (item) =>
            (item as Extract<ThreadPasteItem, { source: 'native' }>).selection,
        ),
      );
      return;
    }
    for (const item of items) {
      if (item.source === 'web') {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        await this.sendAttachments([item.file], true);
      } else {
        await this.sendNativeAttachments([item.selection]);
      }
    }
  }

  private appendComposerText(text: string): void {
    if (!text) return;
    if (!this.nativeComposer.supported) {
      this.chatInput()?.appendText(text);
      return;
    }
    this.nativeDraft.append(text);
  }

  /** Recordings use the same durable attachment admission as selected browser files. */
  private sendVoice(blob: Blob, _duration: number, mimeType: string): void {
    const type = mimeType || 'audio/webm';
    const file = new File([blob], `voice.${mimeTypeToExt(type)}`, { type });
    void this.sendAttachments([file], true).catch(error => {
      this.toast.warn(error instanceof Error ? error.message : String(error));
    });
  }

  /** Daily quota failures are business responses (HTTP 200), so the HTTP error interceptor never sees
   * them. Keep the failed bubble/retry affordance and also explain why retrying today cannot succeed. */
  private surfaceSendFailure(res: StandardResponse<unknown>): void {
    if (
      res.code === BusinessCode.FRIEND_NOT_FOUND ||
      res.code === BusinessCode.GROUP_DISSOLVED
    ) {
      // Business refusals only explain the failed send. Relationship state
      // continues to arrive through the normal server feed.
      this.toast.warn(translateBizResult(res, this.transloco));
      return;
    }
    if (res.code === BusinessCode.FEDERATION_NAMESPACE_INACTIVE) {
      this.toast.warn(translateBizResult(res, this.transloco));
      return;
    }
    if (
      res.code === BusinessCode.QUOTA_EXCEEDED ||
      res.code === BusinessCode.FEDERATION_QUOTA_EXCEEDED ||
      res.code === BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE ||
      res.code === BusinessCode.FEDERATION_CAPABILITY_DISABLED
    ) {
      // A local-user quota trip means this user's send/upload is paused until reset/admin action — surface
      // the persistent composer banner so they aren't left guessing why retries keep failing today.
      if (res.code === BusinessCode.QUOTA_EXCEEDED) this.sendPaused.set(true);
      this.toast.warn(translateBizResult(res, this.transloco));
    }
  }

  private surfaceSendQuota(res: StandardResponse<unknown>): void {
    this.surfaceSendFailure(res);
  }

  /** Append one non-audio upload to the component-wide FIFO. The returned promise represents this
   * exact job (not the whole queue), which lets paste wait for its attachments before sending text. */
  private enqueueAttachmentUpload(
    clientMessageId: string,
    job: () => Promise<void>,
  ): Promise<void> {
    const threadId = this.threadId() ?? 0;
    return threadId
      ? this.attachmentUploads.enqueue(threadId, () =>
          this.transfers.isUploading(clientMessageId)
            ? job()
            : Promise.resolve(),
        )
      : Promise.resolve();
  }

  private async currentMaxFileBytes(): Promise<number | undefined> {
    try {
      const response = await firstValueFrom(this.userService.getMyQuota());
      return response.code === 0
        ? response.data?.breaker.maxFileBytes
        : undefined;
    } catch {
      // A failed preflight must not substitute a stale hard-coded policy; upload admission is authoritative.
      return undefined;
    }
  }

  /** Retry the durable intent without creating a history placeholder. */
  async retrySend(clientMessageId: string): Promise<void> {
    await this.sendRetry.retry(clientMessageId);
  }

  private async cancelPending(clientMessageId: string): Promise<void> {
    const row = this.sendOutbox.get(clientMessageId);
    if (!row) return;
    if (row.execution.kind === 'attachment') {
      await this.transfers.discard(clientMessageId);
    } else {
      await this.sendOutbox.remove(clientMessageId);
    }
  }

  private newClientMessageId(): string {
    return uuid();
  }

  /** Present the non-kernel blocked state and satisfy ChatPane's ready handshake.
   *  Keep the pane cold so unblocking the same thread starts a fresh message kernel. */
  private presentBlockedThread(threadId: number): void {
    const binding = this.lifecycle.binding;
    if (!binding || binding.threadId !== threadId) return;
    this.initialLoading.set(false);
    this.initialLoadFailed.set(false);
    this.unreadDividerReady.set(false);
    this.presentation.set('blocked');
    this.ready.emit(threadId);
  }

  private completeWindowNavigation(found: boolean): void {
    const finish = this.finishWindowJump;
    this.finishWindowJump = undefined;
    finish?.(found);
  }

  private replaceMessageWindow(options: CbWindowNavigation): Promise<boolean> {
    const thread = this.userMsgTrd();
    if (!thread || !this.lifecycle.binding || !this.scroller)
      return Promise.resolve(false);
    this.closeMessageWindow();
    this.windowJumpOptions = options;
    this.windowJumpState.set('loading');
    const result = new Promise<boolean>((resolve) => {
      this.finishWindowJump = resolve;
    });
    switch (options.kind) {
      case 'message':
        this.openMessageWindow(thread, {
          kind: 'jumpToMessage',
          messageSeq: options.messageId,
          anchor: options.anchor,
          highlight: options.highlight,
        });
        break;
      case 'latest':
        this.openMessageWindow(thread, { kind: 'goToLatest' });
        break;
    }
    return result;
  }

  retryWindowJump(): void {
    if (this.windowJumpOptions)
      void this.replaceMessageWindow(this.windowJumpOptions);
  }

  returnToLatest(): void {
    void this.replaceMessageWindow({ kind: 'latest' });
  }

  private teardown(): void {
    this.deletionSurfaceSubscription?.unsubscribe();
    this.deletionSurfaceSubscription = undefined;
    this.cancelPaste();
    this.nativeDraft.reset();
    this.messageInteraction.reset();
    this.closeMessageWindow();
    // Search visibility belongs to the navigation state, not the window.
  }

  /** Release data/geometry before replacing a window, without ending the conversation. */
  private closeMessageWindow(): void {
    this.stopAnchorResolution();
    this.completeWindowNavigation(false);
    this.windowJumpOptions = undefined;
    this.windowJumpState.set('idle');
    // Stop result delivery before unbind cancels the kernel's underlying work.
    this.initializationSubscription?.unsubscribe();
    this.initializationSubscription = undefined;
    clearTimeout(this.unreadReanchorTimer);
    this.unreadReanchorTimer = undefined;
    this.stableRead.flush();
    this.stableRead.reset();
    this.unreadDividerReady.set(false);
    this.pendingDividerRefresh = [];
    this.scrollState.reset();
    this.stickyOverlays()?.clear();
    this.scroller?.unbind();
    this.source = undefined;
  }

  /** Revoke the shared chatbox/composer binding, retaining prepared infrastructure. */
  unbind(): void {
    this.lifecycle.unbind();
  }

  /** Persist while the native context still owns the text. hide() clears its EditText after releasing
   *  the Web context, so neither its final TextWatcher event nor Activity destruction can save it. */
  private saveNativeComposerDraft(): void {
    const threadId = this.nativeComposerThreadId;
    if (!threadId) return;
    this.nativeDraft.save(threadId, escapeComposerText);
  }

  /** Only the host may create a binding; input updates never do so. */
  bind(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    const trd = this.userMsgTrd();
    if (!vp || !ct || !trd) return;
    const existing = this.lifecycle.binding;
    if (existing?.threadId === trd.threadId) {
      this.ready.emit(existing.threadId);
      return;
    }
    this.unbind();
    if (!this.scroller) this.prepareScroller(vp, ct);
    this.lifecycle.bind(trd.threadId);
  }

  retryInitialLoad(): void {
    const thread = this.userMsgTrd();
    if (
      !this.initialLoadFailed() ||
      !thread ||
      this.lifecycle.binding?.threadId !== thread.threadId
    )
      return;
    // Retry data loading, not conversation ownership or composer setup.
    this.closeMessageWindow();
    this.initialLoadFailed.set(false);
    this.initialLoading.set(true);
    this.presentation.set('loading');
    this.openMessageWindow(thread, { kind: 'openConversation' });
  }

  /** Whether this pane has a reusable loading, message, retry, or blocked shell for the bound thread. The A/B
   *  host's fg-resident branch reads this so it only re-inits a genuinely COLD pane (re-open after a close)
   *  and skips a spurious reset on an already-warm one — which matters because every `promote()` flips
   *  `fgSlot` and re-triggers the coordinator, so without this guard a warm pane would be reset on every
   *  switch. A plain method (not a signal): a synchronous snapshot read, intentionally untracked. */
  isWarm(): boolean {
    return (
      this.presentation() !== 'unbound' &&
      this.lifecycle.binding?.threadId === this.userMsgTrd()?.threadId
    );
  }

  // ---------- chat header MORE-menu integration ----------

  /** Window navigation owns loading/missing/error presentation. A false result
   * can also mean superseded navigation; never turn it into a second toast. */
  async onSearchJump(id: number): Promise<void> {
    await this.jumpToMessage(id);
  }

  /** Host-level navigation controls. These preserve the chatbox abstraction without exposing its scroller. */
  scrollToTop(): void {
    this.scroller?.scrollToTop();
  }

  scrollInfo(): CbScrollInfo | undefined {
    return this.scroller?.getInfo();
  }

  async jumpToMessage(id: number): Promise<boolean> {
    return this.jumpToHistoryAnchor({ kind: 'local', seq: id });
  }

  private anchorRequest?: AbortController;
  private anchorSubscription?: Subscription;
  private finishAnchorRequest?: (found: boolean) => void;

  private stopAnchorResolution(): void {
    this.anchorSubscription?.unsubscribe();
    this.anchorSubscription = undefined;
    this.anchorRequest?.abort();
    this.anchorRequest = undefined;
    const finish = this.finishAnchorRequest;
    this.finishAnchorRequest = undefined;
    finish?.(false);
  }

  jumpToHistoryAnchor(anchor: HistoryAnchor): Promise<boolean> {
    this.stopAnchorResolution();
    const source = this.source;
    const scroller = this.scroller;
    if (!source || !scroller) return Promise.resolve(false);
    if (anchor.kind === 'local')
      return jumpToMessage(scroller, anchor.seq).then(
        (found) => found !== false,
      );
    const request = new AbortController();
    this.anchorRequest = request;
    return new Promise<boolean>((resolve) => {
      this.finishAnchorRequest = resolve;
      const subscriber = new Subscriber<number | null>({
        complete: () => this.stopAnchorResolution(),
        next: (seq) => {
          // Release ownership before invoking navigation or UI callbacks:
          // either may synchronously start another request.
          subscriber.unsubscribe();
          this.anchorSubscription = undefined;
          this.finishAnchorRequest = undefined;
          this.anchorRequest = undefined;
          if (seq === null) {
            this.toast.warn(this.transloco.translate('chat.messageNotFound'));
            resolve(false);
          } else {
            void jumpToMessage(scroller, seq).then(
              (found) => resolve(found !== false),
              () => resolve(false),
            );
          }
        },
        error: () => {
          subscriber.unsubscribe();
          this.anchorSubscription = undefined;
          this.finishAnchorRequest = undefined;
          this.anchorRequest = undefined;
          this.toast.warn(this.transloco.translate('chat.messageJumpFailed'));
          resolve(false);
        },
      });
      this.anchorSubscription = subscriber;
      defer(() =>
        source.resolveHistoryAnchor
          ? source.resolveHistoryAnchor(anchor, request.signal)
          : Promise.resolve(null),
      ).subscribe(subscriber);
    });
  }

  private async jumpToQuoteAnchor(anchor: HistoryAnchor): Promise<void> {
    await this.jumpToHistoryAnchor(anchor);
  }

  /** Recreate the injected source while keeping the production chatbox shell mounted. */
  reload(): void {
    if (!this.lifecycle.binding) return;
    this.unbind();
    this.bind();
  }

  ngOnDestroy(): void {
    this.lifecycle.destroy();
  }
}

/** Read an image's real dimensions (for the optimistic bubble's album layout); 400×300 fallback on failure. */
async function readImageDims(f: File): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(f);
    const w = bmp.width,
      h = bmp.height;
    bmp.close();
    return { w, h };
  } catch {
    return { w: 400, h: 300 };
  }
}

function escapeComposerText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\n', '<br>');
}

/** Let Angular commit and the browser paint pending transfer state before any media decoder sees the file. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/** Read a file as a data URL (the optimistic image bubble's src until the server-URL real mounts on confirm). */
function readFileAsDataURL(f: File): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => resolve('');
    r.readAsDataURL(f);
  });
}

/** Probe a video's real dimensions + duration via <video> loadedmetadata (for the optimistic cell +
 *  the VIDEO message content). The server does NOT probe — these are client-measured, server-untrusted.
 *  0 fallbacks on failure (layoutAlbum's ratio() tolerates 0 with a 4:3 fallback). */
function readVideoMeta(
  f: File,
): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      const duration = Number.isFinite(v.duration) ? v.duration : 0;
      URL.revokeObjectURL(url);
      resolve({ w, h, duration });
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ w: 0, h: 0, duration: 0 });
    };
    v.src = url;
  });
}

/** Map a MediaRecorder audio MIME to a display extension for the synthesized voice File name. Cosmetic only —
 *  the backend re-derives the on-disk extension from the real bytes (magic-byte-trusted), so this never
 *  affects storage or serving; it just gives the clip a sensible filename. */
function mimeTypeToExt(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  return 'webm'; // default: the Chrome/Android/Tauri MediaRecorder output
}

function uploadIntentForMime(
  mime: string,
): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}
