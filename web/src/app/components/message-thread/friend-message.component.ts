import {
  Component,
  computed,
  effect,
  ElementRef,
  EnvironmentInjector,
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
import { firstValueFrom, Subscription } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import {
  ChatBoxScroller,
  type ScrollerApi,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import { isViewportTransformEnd } from '../../lib/sticky-date';
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
  type AlbumImage,
  type ChatItemData,
  type ChatMsgData,
  type AuthoredContentType,
  type FileInfo,
  type MediaStatus,
} from '../message-cards/chat-item';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import {
  conversationAvatarAccount,
  conversationAvatarDomain,
  conversationAvatarType,
  conversationAvatarIdentityId,
  conversationAvatarSrc,
} from '../user-avatar/conversation-avatar.util';
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
import { assetUrl } from '../../services/runtime';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';
import {
  MediaAvailabilityRegistration,
  MediaAvailabilityService,
} from '../../services/media-availability.service';
import {
  avatarUrl,
  UserService,
} from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { LayoutService } from '../../services/layout.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { FileDetailService } from '../file-detail-viewer/file-detail-viewer.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  displayThreadName,
  displayUserAccount,
  parseUserIdentityKey,
  type ConversationItem,
  type StandardResponse,
} from '../../services/model';
import { serializeNativeComposerText } from '../chat-editor/editor-message-serializer';
import { filterMentionCandidates } from '../chat-editor/mention-candidates';
import {
  MediaTransferService,
  type MediaTransferKind,
} from '../../services/media-transfer.service';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
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
  type NativeVoiceUploadEvent,
} from '../../services/native-composer.service';
import { ThemeService } from '../../services/theme.service';
import { CallBannerComponent } from '../call-banner/call-banner.component';
import { CallPresentationService } from '../../services/call-presentation.service';
import { BusinessCode, translateBizResult } from '../../services/biz-code';
import { tauriInvoke } from '../../services/runtime';
import { ProfileRepository } from '../../services/profile-store.service';
import { PopupType, RouteService } from '../../services/route.service';
import { ChatboxPopupComponent } from '../chatbox-popup/chatbox-popup.component';
import {
  MemberProfileRepository,
  type ResolvedMemberProfile,
} from '../../services/member-profile-store.service';
import { ChatContextService } from './chat-context.service';
import { ChatAppearanceService } from '../../services/chat-appearance.service';
import { FederationNamespaceService } from '../../services/federation-namespace.service';
import { ALL_MENTION_ID, escapePlainText } from '../../lib/message-entity';
import type { ChatMember } from '../chat-editor/chat-editor.component';
import { StableReadTracker } from './stable-read-tracker';
import { messageOpenOptions } from './message-open-position';
import {
  applyMessageSelectionState,
  messageMemberIds,
} from './message-selection';
import { MessageInteractionController } from './message-interaction.controller';
import { jumpToMessage } from './message-jump';
import { MessageForwardController } from './message-forward.controller';
import {
  ThreadPasteQueueController,
  type ThreadPasteItem,
} from './thread-paste-queue.controller';
import { ThreadOptimisticController } from './thread-optimistic.controller';
import { ThreadScrollController } from './thread-scroll.controller';
import { ThreadSendRetryController } from './thread-send-retry.controller';
import { ThreadTransferController } from './thread-transfer.controller';
import { ThreadComposerController } from './thread-composer.controller';
import { NativeComposerBoundsController } from './native-composer-bounds.controller';
import { ThreadAttachmentUploadController } from './thread-attachment-upload.controller';
import { ThreadMessageSendController } from './thread-message-send.controller';
import { NativeComposerDraftController } from './native-composer-draft.controller';
import {
  NativeVoiceUploadController,
  nativeVoicePreview,
} from './native-voice-upload.controller';

type PreparedWebAttachment =
  | {
      file: File;
      cid: string;
      partId: string;
      kind: 'image';
      probeMeta: () => Promise<{ w: number; h: number }>;
    }
  | {
      file: File;
      cid: string;
      partId: string;
      kind: 'video';
      probeMeta: () => Promise<{ w: number; h: number; duration: number }>;
    }
  | {
      file: File;
      cid: string;
      partId: string;
      kind: 'audio';
      probeMeta: null;
    }
  | {
      file: File;
      cid: string;
      partId: string;
      kind: 'file';
      probeMeta: null;
    };

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
    MessageHeaderComponent,
    CallBannerComponent,
    ChatInputComponent,
    PastePanelComponent,
    KbdOffsetDirective,
    ComposerWidthSourceDirective,
    ChatboxStickyOverlaysComponent,
    ChatboxPopupComponent,
    EmptyStateComponent,
    UserAvatarComponent,
    TranslocoModule,
  ],
  templateUrl: './friend-message.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  private readonly callLayout = inject(LayoutService);
  private readonly callPresentation = inject(CallPresentationService);
  readonly showCallBanner = computed(
    () =>
      this.callLayout.mode() === 'compact' && this.callPresentation.minimized(),
  );
  readonly assetUrl = assetUrl;
  readonly UserAvatarType = UserAvatarType;
  readonly displayUserAccount = displayUserAccount;
  readonly threadId = input<number>();
  readonly userMsgTrd = input<ConversationItem>();
  private readonly chatContext = inject(ChatContextService);
  /** The A/B host keeps two threads mounted; only the foreground layer may own the one native composer. */
  readonly nativeComposerActive = input(false);
  private readonly chatInput = viewChild(ChatInputComponent);

  /** Emits the threadId once the kernel finishes `init()` on a thread open / re-init — the A/B buffer host
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
  private readonly transferStackRef =
    viewChild<ElementRef<HTMLDivElement>>('transferStack');
  /** The chat header element — its bottom edge is the STABLE visible-top reference for the sticky-date
   *  pill. The viewport carries the keyboard-lift `transform`, so its own `getBoundingClientRect().top`
   *  slides under the header while the keyboard is up; the header does not transform, so its bottom is the
   *  true top of the visible content (see updateStickyOverlays). */
  private readonly headerRef = viewChild('msgHeader', {
    read: ElementRef<HTMLElement>,
  });
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly msgRepo = inject(MessageRepository);
  private readonly mediaAvailability = inject(MediaAvailabilityService);
  private readonly deletedSub: Subscription;
  private readonly userService = inject(UserService);
  readonly selfUserId = computed(() => this.userService.sessionProfile()?.id);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);
  private readonly nav = inject(NavStateMachineService);
  private readonly convList = inject(ConversationListService);
  private readonly namespaces = inject(FederationNamespaceService);
  private readonly transfers = inject(MediaTransferService);
  private readonly transferState = new ThreadTransferController(
    this.transfers,
    () => this.threadId(),
  );
  private readonly nativeUploads = inject(NativeUploadService);
  private readonly pasteQueue = new ThreadPasteQueueController((uploadId) =>
    this.nativeUploads.discard(uploadId),
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
  private readonly optimistic = new ThreadOptimisticController(() =>
    this.sendOutbox.allocatePlaceholderId(),
  );
  private readonly sendRetry = new ThreadSendRetryController(
    this.sendOutbox,
    this.optimistic,
    {
      webGallery: (cid, parts, item) =>
        void this.uploadWebGallery(cid, parts, item, true),
      nativeGallery: (cid, parts, item) =>
        void this.uploadNativeGallery(cid, parts, item, true),
      voice: (cid, resource, item) =>
        void this.uploadAndSendAudio(
          cid,
          resource.partId,
          resource.file,
          item,
          { duration: resource.duration },
          true,
        ),
      nativeAttachment: (cid, resource, item) =>
        void this.queueNativeUpload(
          cid,
          resource.partId,
          resource.selection,
          item,
          true,
        ),
      webAttachment: async (cid, resource, item) => {
        if (resource.mediaKind === 'image')
          return this.queueImageUpload(
            cid,
            resource.partId,
            resource.file,
            item,
            await readImageDims(resource.file),
            true,
          );
        if (resource.mediaKind === 'video')
          return this.queueVideoUpload(
            cid,
            resource.partId,
            resource.file,
            item,
            await readVideoMeta(resource.file),
            true,
          );
        if (resource.mediaKind === 'audio')
          return this.uploadAndSendAudio(
            cid,
            resource.partId,
            resource.file,
            item,
            { duration: 0 },
            true,
          );
        return this.queueFileUpload(
          cid,
          resource.partId,
          resource.file,
          item,
          true,
        );
      },
      text: (item) => this.messageSender.retryText(item),
    },
  );
  private readonly attachmentSender = new ThreadAttachmentUploadController(
    this.threadAdapter,
    this.transfers,
    this.transloco,
    this.nativeUploads,
    this.debugTools,
    this.toast,
    {
      threadId: () => this.threadId(),
      failPending: (item) => this.failPending(item),
      markAccepted: (item) => this.markAccepted(item),
      surfaceQuota: (response) => this.surfaceSendQuota(response),
    },
  );
  private readonly messageSender = new ThreadMessageSendController(
    this.threadAdapter,
    this.msgService,
    {
      threadId: () => this.threadId(),
      selfAccount: () => this.userService.sessionProfile()?.account,
      consumeQuote: () => this.messageInteraction.consumeQuote(),
      makeItem: (cid, text, contentType) =>
        this.makeOptimisticItem(cid, text, contentType, null, null),
      newClientMessageId: () => this.newClientMessageId(),
      dispatch: (item) => this.dispatchPending(item),
      source: () => this.source,
      fail: (item) => this.failPending(item),
      accept: (item) => this.markAccepted(item),
      surfaceFailure: (response, threadId) =>
        this.surfaceSendFailure(response, threadId),
    },
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
      this.messageSender.link(intent.generationId, intent.content),
    contact: (intent) => this.messageSender.contact(intent),
    paste: (intent) => this.appendWebPaste(intent.files, intent.text),
    audio: (intent) =>
      this.sendVoice(intent.blob, intent.duration, intent.mimeType),
  });
  private readonly theme = inject(ThemeService);
  private readonly forwarding = new MessageForwardController(
    this.threadAdapter,
    this.convList,
    this.route,
    this.toast,
    this.transloco,
    () => this.newClientMessageId(),
  );
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly chatAppearance = inject(ChatAppearanceService);
  private readonly http = inject(HttpClient);
  readonly nativeComposer = inject(NativeComposerService);
  private readonly composerDrafts = inject(ComposerDraftService);
  private readonly linkGenerations = inject(LinkCardGenerationService);
  private readonly nativeDraft = new NativeComposerDraftController(
    this.composerDrafts,
    this.linkGenerations,
  );
  readonly mentionMembers = signal<ChatMember[]>([]);
  readonly searchMentionMembers = async (
    query: string,
  ): Promise<ChatMember[]> => {
    const threadId = this.threadId();
    const trd = this.userMsgTrd();
    if (threadId === undefined || trd?.type !== 'GROUP') return [];
    const roster = await this.memberProfiles.queryPage(threadId, {
      take: 20,
      search: query,
    });
    const members = roster.map((member) => ({
      id: member.account,
      label: member.name,
      avatarUrl: assetUrl(avatarUrl(member.avatar)),
    }));
    if (
      this.chatContext.canAdministerGroup() &&
      this.transloco
        .translate('chat.mentionAll')
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    )
      members.unshift({
        id: ALL_MENTION_ID,
        label: this.transloco.translate('chat.mentionAll'),
        avatarUrl: '',
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
  private readonly nativeVoiceUploads = new NativeVoiceUploadController(
    this.transfers,
    this.transloco,
    this.toast,
    {
      makeItem: (cid, duration, size) =>
        this.makeOptimisticItem(
          cid,
          '',
          'AUDIO',
          nativeVoicePreview(duration, size),
          null,
        ),
      dispatch: (item) => this.dispatchPending(item),
      accept: (item) => this.markAccepted(item),
      fail: (item) => this.failPending(item),
    },
  );

  private scroller?: ScrollerApi<ChatItemData>;
  private source?: MessageThreadSource;
  private currentTrdId: number | null = null;
  /** True only once `initScroller`'s async `init()` has settled (set in its `.finally`, cleared at init
   *  start + in `teardown`). Distinct from `currentTrdId === trd.id` (which is set synchronously at init
   *  START): a pane mid-init has the right `currentTrdId` but is NOT yet ready. {@link reset} uses this to
   *  tell a WARM resident (init done → emit `ready` now, no re-fetch) from a COLD one (idled via
   *  `teardownKernel` → reinit). */
  private kernelReady = false;
  private readonly scrollState = new ThreadScrollController();
  private readonly stableRead = new StableReadTracker((seq) => {
    const threadId = this.threadId();
    if (threadId !== undefined) {
      this.convList.markReadStable(threadId, seq);
      this.convList.flushRead(threadId);
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
  readonly initialLoading = signal(true);
  readonly initialLoadFailed = signal(false);
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
      this.userMsgTrd()?.friendshipActive === false,
  );
  readonly authorityNamespaceInactive = computed(() => {
    const thread = this.userMsgTrd();
    if (!thread || thread.authorityNamespaceId === 0) return false;
    const domain =
      thread.type === 'P2P' ? thread.peerUser.domain : thread.group.domain;
    return !this.namespaces.isActive(domain, thread.authorityNamespaceId);
  });
  readonly leftGroup = computed(
    () =>
      this.userMsgTrd()?.type === 'GROUP' &&
      this.userMsgTrd()?.group?.dissolvedAt == null &&
      this.userMsgTrd()?.conversationState === 'READ_ONLY',
  );
  readonly dissolvedGroup = computed(
    () =>
      this.userMsgTrd()?.type === 'GROUP' &&
      this.userMsgTrd()?.group?.dissolvedAt != null,
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
   *  while that layer is active. This covers peer profile/group info as well as dialogs and viewers. */
  readonly nativeComposerOccluded = computed(
    () =>
      this.nav.aside().length > 0 ||
      this.nav
        .paneStack()
        .some(
          (pane) => pane.kind !== 'dialog' || pane.presentation !== 'chatbox',
        ) ||
      this.pasteOpen(),
  );
  readonly uploadingTransfers = this.transferState.uploading;
  readonly sendingTransfers = this.transferState.sending;
  readonly failedTransfers = this.transferState.failed;
  readonly retryableFailedTransfers = this.transferState.retryableFailed;
  readonly currentUploadingTransferId = this.transferState.currentUploadingId;
  readonly displayedSendingTransfers = this.transferState.displayedSending;
  readonly transferExt = (name: string): string =>
    this.transferState.extension(name);
  readonly transferCategory = (name: string) =>
    this.transferState.category(name);
  readonly transferProgress = (loaded: number, size: number): number =>
    this.transferState.progress(loaded, size);
  /** The global attachment card is one logical mounted tail item regardless of the number of files it
   * aggregates. Include it in empty-state accounting even though the kernel stores it in its measured tail
   * slot rather than in the message cursor array. */
  readonly threadEmpty = computed(
    () =>
      this.mountedMessageCount() === 0 &&
      this.sendingTransfers().length === 0 &&
      this.failedTransfers().length === 0,
  );
  readonly uploadCountLabel = this.transferState.countLabel;
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
  readonly emptyAvatarIdentityId = computed<number | undefined>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarIdentityId(t) : undefined;
  });
  readonly emptyAvatarAccount = computed<string | undefined>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarAccount(t) : undefined;
  });
  readonly emptyAvatarDomain = computed<string | undefined>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarDomain(t) : undefined;
  });
  readonly emptyAvatarSrc = computed<string | null | undefined>(() => {
    const t = this.userMsgTrd();
    return t ? conversationAvatarSrc(t) : undefined;
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

  constructor() {
    this.deletedSub = this.msgRepo.deletedLive$.subscribe(
      ({ threadId, seqs }) => {
        if (threadId !== this.currentTrdId || !this.scroller) return;
        for (const seq of seqs) this.onMessageDeleted(threadId, seq);
      },
    );
    effect((onCleanup) => {
      const trd = this.userMsgTrd();
      const threadId = this.threadId();
      if (!trd || trd.type !== 'GROUP' || threadId === undefined) {
        this.mentionMembers.set([]);
        return;
      }
      let active = true;
      const load = async () => {
        if (!active) return;
        const members: ChatMember[] = [];
        if (this.chatContext.canAdministerGroup()) {
          members.unshift({
            id: ALL_MENTION_ID,
            label: this.transloco.translate('chat.mentionAll'),
            avatarUrl: '',
          });
        }
        this.mentionMembers.set(members);
      };
      void load();
      const sub = this.memberProfiles.changed$.subscribe((threadIds) => {
        if (threadIds.includes(threadId)) void load();
      });
      onCleanup(() => {
        active = false;
        sub.unsubscribe();
      });
    });
    // The aggregate attachment card is a single kernel tail item. Moving the Angular-owned node into the
    // kernel's measured tail cap makes it part of the scrollable content/total-height model instead of a
    // fixed row above the composer. The cap's ResizeObserver accounts for show/hide and progress updates.
    effect(() => {
      // Keep the effect reactive to task changes even when the conditional view has not been created yet.
      this.sendingTransfers();
      this.failedTransfers();
      const stack = this.transferStackRef()?.nativeElement;
      const content = this.contentRef()?.nativeElement;
      if (!stack || !content) return;
      const tailCap = content.querySelector<HTMLElement>('.cb-tail-cap');
      if (tailCap && stack.parentElement !== tailCap)
        tailCap.appendChild(stack);
    });
    effect(() => {
      const request = this.transfers.latestRequest();
      if (!request || request.threadId !== this.threadId()) return;
      // Reading the nonce makes repeated clicks for the same thread distinct. The kernel may still be
      // initializing after navigation; init's normal bottom positioning handles that cold case.
      request.nonce;
      queueMicrotask(() => this.scroller?.scrollToBottom());
    });
    effect(() => {
      const vp = this.viewportRef();
      const ct = this.contentRef();
      const trd = this.userMsgTrd();
      if (!vp || !ct || !trd) return;
      if (this.blockedPeer()) {
        // teardown reads and resets several UI signals. Keep those reads out of this effect's dependency
        // graph or their resets can continuously retrigger the blocked branch. Mark the pane cold as well,
        // so unblocking the same conversation initializes a fresh kernel instead of matching the stale id.
        if (this.currentTrdId !== null || this.scroller) {
          untracked(() => this.teardown());
          this.currentTrdId = null;
        }
        return;
      }
      if (this.currentTrdId === trd.threadId) return;
      this.teardown();
      this.initScroller(vp.nativeElement, ct.nativeElement, trd);
      this.currentTrdId = trd.threadId;
    });
    // A background A/B pane may finish initialization before it is promoted. Only the foreground pane starts
    // read tracking; start() immediately commits the fully-visible HWM collected during kernel layout.
    effect(() => {
      const active = this.nativeComposerActive();
      const loading = this.initialLoading();
      if (active && !loading && this.kernelReady) this.stableRead.start();
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
        this.nativeComposerActive() &&
        threadId !== undefined &&
        !this.initialLoading() &&
        !this.blockedPeer() &&
        !this.friendshipEnded() &&
        !this.authorityNamespaceInactive() &&
        !this.leftGroup() &&
        !this.dissolvedGroup() &&
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
        composingQuote?.seq !== undefined
          ? {
              seq: composingQuote.seq,
              preview: `${composingQuote.author ?? ''}: ${composingQuote.body ?? ''}`,
            }
          : undefined;
      if (this.nativeComposerThreadId === threadId) {
        if (this.nativeComposerContextId !== null)
          this.nativeComposer.update(this.nativeComposerContextId, {
            theme,
            quote: quote ?? null,
          });
        return;
      }
      this.hideNativeComposer();
      const initialDraft = this.nativeDraft.open(threadId);
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
    effect(() => {
      const event = this.nativeComposer.voiceUpload();
      if (!event || event.threadId !== this.threadId()) return;
      this.handleNativeVoiceUpload(event);
    });
    effect(() => {
      const progress = this.nativeComposer.uploadProgress();
      if (!progress) return;
      this.nativeVoiceUploads.progress(
        progress.clientMessageId,
        progress.loaded,
        progress.total,
      );
    });
  }

  private onMessageDeleted(threadId: number, seq: number): void {
    this.galleryViewer.closeIfDeleted(threadId, seq);
    this.fileDetail.closeIfDeleted(threadId, seq);
    this.messageInteraction.removeMessage(seq);
    this.scroller?.mutateItem(seq, (item) => {
      if (item.data.type !== 'msg') return null;
      const images = item.data.images;
      if (!images || images.length < 2) return null;
      const remaining = images.filter((image) => image.msgId !== seq);
      if (remaining.length === images.length) return null;
      if (remaining.length === 0) return null;
      const head = remaining[0];
      const headId = head.msgId;
      if (headId === undefined) return null;
      const ids = remaining
        .map((image) => image.msgId)
        .filter((id): id is number => id !== undefined);
      return {
        ...item,
        id: headId,
        ids: ids.length > 1 ? ids : undefined,
        data: {
          ...item.data,
          msgId: headId,
          contentType: head.kind === 'video' ? 'VIDEO' : 'IMAGE',
          images: remaining,
        },
      };
    });
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
        }
        return;
      }
      case 'queryMentions': {
        const items = filterMentionCandidates(
          this.mentionMembers(),
          event.query,
        ).map((member) => ({
          kind:
            member.id === ALL_MENTION_ID ? ('all' as const) : ('user' as const),
          id: member.id,
          label: member.label,
          avatar:
            member.id === ALL_MENTION_ID
              ? ({ kind: 'builtin', icon: 'everyone' } as const)
              : ({
                  kind: 'user',
                  url: member.avatarUrl || undefined,
                  fallbackText: avatarFallbackText(member.label),
                  colorSeed: member.id,
                } as const),
        }));
        this.nativeComposer.update(event.contextId, {
          mentionResults: {
            requestId: event.requestId,
            items,
          },
        });
        return;
      }
      case 'cancelQuote':
        this.cancelQuote();
        return;
      case 'resolveMedia':
        void this.resolveNativeMentionMedia(event);
        return;
      case 'pickAttachment':
        void this.pickNativeComposerAttachment(event);
        return;
      case 'pasteFiles':
        this.appendNativePaste(event.files);
        return;
      case 'draft':
        this.nativeDraft.set(event.text);
        return;
      case 'linkMarkers':
        this.nativeDraft.set(event.text);
        this.nativeDraft.consumeLink(event.links[0]?.href ?? null, event.text);
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

  private async resolveNativeMentionMedia(
    event: Extract<NativeComposerEvent, { kind: 'resolveMedia' }>,
  ): Promise<void> {
    try {
      // HttpClient is intentional: TauriHttpBackend routes media:// and http://media.localhost through
      // Rust's authenticated media_request command. Android WebView fetch() rejects custom schemes.
      const blob = await firstValueFrom(
        this.http.get(event.url, { responseType: 'blob' }),
      );
      if (blob.size > 512 * 1024) throw new Error('avatar is too large');
      const base64 = await blobToBase64(blob);
      this.nativeComposer.update(event.contextId, {
        mediaResolved: {
          requestId: event.requestId,
          mimeType: blob.type || 'application/octet-stream',
          base64,
        },
      });
    } catch {
      this.nativeComposer.update(event.contextId, {
        mediaResolved: { requestId: event.requestId, error: 'unavailable' },
      });
    }
  }

  private async pickNativeComposerAttachment(
    event: Extract<NativeComposerEvent, { kind: 'pickAttachment' }>,
  ): Promise<void> {
    try {
      const files = await this.nativeUploads.pick(
        event.source === 'gallery' ? 'image' : 'file',
      );
      if (files.length) this.onSendIntent({ kind: 'native-files', files });
      this.nativeComposer.acknowledge(event.actionId, true);
    } catch {
      this.nativeComposer.acknowledge(event.actionId, false);
    }
  }

  private handleNativeVoiceUpload(event: NativeVoiceUploadEvent): void {
    this.nativeVoiceUploads.handle(event);
  }

  private initScroller(
    viewport: HTMLDivElement,
    content: HTMLDivElement,
    trd: ConversationItem,
  ): void {
    const initStartedAt = performance.now();
    if (isDevMode()) {
      console.log('[chat-perf] scroller:init', {
        threadId: trd.threadId,
      });
    }
    this.source = this.threadAdapter.createSource(trd, {
      onNewerAvailable: () => {
        this.scrollState.noteNewerAvailable();
        this.scroller?.notifyNewerAvailable?.();
      },
      // Shared media availability change → re-render the one card in place.
      // updateItemData is synchronous + height-neutral, so no async/catch and no anchor shift.
      onMediaStatus: (seq: number, status: MediaStatus) => {
        const data = this.scroller?.getMountedGeometry(seq)?.item.data;
        if (!data || data.type !== 'msg') return;
        const images = (data.images ?? []).map((image) =>
          image.msgId === seq ? { ...image, status } : image,
        );
        const states = images.map(
          (image) => image.status ?? MEDIA_STATUS.READY,
        );
        const aggregate = states.includes(MEDIA_STATUS.FAILED)
          ? MEDIA_STATUS.FAILED
          : states.includes(MEDIA_STATUS.DOWNLOADING)
            ? MEDIA_STATUS.DOWNLOADING
            : states.includes(MEDIA_STATUS.PENDING)
              ? MEDIA_STATUS.PENDING
              : status;
        this.scroller?.updateItemData(seq, {
          images,
          mediaStatus: aggregate,
        });
      },
      onQuoteDeleted: (replySeq: number, targetSeq: number) => {
        this.scroller?.mutateItem(replySeq, (item) => ({
          ...item,
          data: { ...item.data, quote: { seq: targetSeq, unavailable: true } },
        }));
      },
      // Profile hydration is deliberately off the init critical path. Patch any currently mounted row
      // once it arrives; album member ids resolve to their merged mounted entry in the kernel.
      onProfile: (
        seq: number,
        profile: {
          name: string;
          avatar: string;
          avatarIdentityId: string;
          avatarAccount: string;
          avatarDomain: string;
          isSelf: boolean;
        },
      ) => {
        this.scroller?.updateItemData(seq, profile);
      },
    });
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      source: this.source,
      initOpts: { chatId: trd.threadId },
      hooks: {
        createItem: (item, prev) => this.createItem(item, prev),
        createSkeleton: () => createGhostCbElement(),
        mergeItems: (items) =>
          mergeAlbumItemsAtBoundary(items, this.scrollState.firstUnreadSeq),
        absorbTail: (target, incoming) =>
          incoming.id === this.scrollState.firstUnreadSeq
            ? null
            : absorbAlbumTail(target, incoming),
      },
      onScroll: (info) => this.onScroll(info),
      onViewportPaint: () => this.updateStickyOverlays(),
      onFullyVisibleEnter: (entries) => {
        for (const entry of entries) {
          this.pulseVisibleMention(entry.item, entry.el);
          const ids = entry.item.ids ?? [entry.item.id];
          this.stableRead.noteFullyVisible(ids);
        }
      },
      // Reveal the locally cached latest page immediately. Older history is backfilled after ready,
      // so a one-message preview cache never makes pane switching wait for the network.
      config: {
        ...this.threadAdapter.scrollerConfig(),
        deferInitFill: true,
      },
      // Immunity frame: hold the kernel's viewport reflow while a route-transition slide is in flight.
      isFrozen: () => this.layout.reflowFrozen(),
    });
    this.threadAdapter.configureScroller(this.scroller);
    this.optimistic.bind(this.scroller, this.source);
    // The tail cap is created synchronously with the scroller. If transfers survived a pane remount, the
    // conditional stack may already exist and needs one post-construction placement pass.
    queueMicrotask(() => {
      const stack = this.transferStackRef()?.nativeElement;
      const tailCap =
        this.contentRef()?.nativeElement.querySelector<HTMLElement>(
          '.cb-tail-cap',
        );
      if (stack && tailCap && stack.parentElement !== tailCap)
        tailCap.appendChild(stack);
    });
    this.initialLoading.set(true);
    this.initialLoadFailed.set(false);
    this.kernelReady = false;
    const boundary = this.convList.unreadEntryBoundary(trd.threadId);
    this.scrollState.open(boundary?.firstUnreadSeq ?? null);
    const openOptions = messageOpenOptions(
      this.chatAppearance.openPosition(),
      this.scrollState.firstUnreadSeq,
    );
    const source = this.source;
    const scroller = this.scroller;
    void scroller
      .init(
        openOptions
          ? {
              ...openOptions,
              onFallbackToLatest: () => {
                // A local-only init miss is not evidence that the server-side unread anchor disappeared.
                // Keep the frozen boundary and position it after finishLocalInit drives the catch-up demand.
                this.scrollState.markUnreadReanchorNeeded();
              },
            }
          : undefined,
      )
      .then(() => {
        if (this.source !== source || this.scroller !== scroller) return;
        this.initialLoading.set(false);
        this.kernelReady = true;
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
        this.ready.emit(trd.threadId);
        // Only after the DB/scroller phase is complete may the source compare the locally-loaded tail with
        // BOTH remote ceilings and fall through to HTTP: the live-session HWM plus the durable thread
        // metadata. The latter is load-bearing after an IndexedDB→SQLite migration / fresh install, where
        // the thread row can say lastMessageSeq=258 while the local messages table is legitimately empty.
        source.finishLocalInit?.(
          this.convList.latestSeq(trd.threadId),
          trd.lastMessageSeq,
        );
        // A missed-message sync commonly leaves exactly one preview body in IDB after login. Backfill one
        // older page only after the pane is ready; the kernel preserves the bottom/current-item anchor.
        void scroller
          .backfillOlder?.()
          .catch((e) => console.error('[chat] history backfill rejected', e));
      })
      .catch((error) => {
        if (this.source !== source || this.scroller !== scroller) return;
        this.initialLoading.set(false);
        this.initialLoadFailed.set(true);
        this.kernelReady = false;
        if (isDevMode())
          console.warn('[chat] initial message load failed', error);
      });
  }

  /** Kernel createItem hook: compute grouping flags from the older neighbor prev, wrap the real component.
   *  Passes onRetry so a failed self-send row's retry glyph calls back into retrySend (msgId = clientMessageId), and
   *  onOpenImage so clicking an image cell opens the gallery viewer. */
  private createItem(
    item: CbItem<ChatItemData>,
    prev: CbItem<ChatItemData> | null,
  ): CbElement<ChatItemData> {
    // Real items only — the topmost skeleton-slot decision (prev/boundary/noOlder) lives in the kernel's createVs,
    // rendered via the createSkeleton hook supplied below. createItem never branches on ghost-vs-real: that rule
    // drifted between playground and production and is what swallowed the empty-thread first message.
    if (item.data.serverGap) {
      return createServerGapCbElement(
        item,
        String(
          this.transloco.translate(
            item.data.serverGap.state === 'SERVER_PENDING'
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
      (msgId) => this.retrySend(msgId),
      (images, index) =>
        this.galleryViewer.open(images, index, this.threadId() ?? 0),
      (data) => this.fileDetail.open(data, this.threadId() ?? 0),
      (clientMessageId) => void this.cancelPending(clientMessageId),
      isUnreadStart
        ? String(this.transloco.translate('chat.unreadDivider'))
        : undefined,
      (event, selectedItem, pointer, memberId) =>
        this.onMessageInteraction(event, selectedItem, pointer, memberId),
      (bundleId) => this.route.popupDlg(PopupType.FORWARD_DETAIL, { bundleId }),
      (seq) => this.onSearchJump(seq),
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
    this.bindMediaAvailability(rendered, item);
    return rendered;
  }

  private bindMediaAvailability(
    rendered: CbElement<ChatItemData>,
    initialItem: CbItem<ChatItemData>,
  ): void {
    const registrations = new Map<number, MediaAvailabilityRegistration>();
    const sync = (item: CbItem<ChatItemData>) => {
      const wanted = this.mediaStatuses(item);
      for (const [seq, registration] of registrations) {
        if (!wanted.has(seq)) {
          registration.unregister();
          registrations.delete(seq);
        }
      }
      const threadId = this.threadId() ?? 0;
      if (threadId === 0) return;
      for (const [seq, status] of wanted) {
        if (!registrations.has(seq)) {
          registrations.set(
            seq,
            this.mediaAvailability.register(threadId, seq, status),
          );
        }
      }
    };
    sync(initialItem);
    const baseUpdate = rendered.update.bind(rendered);
    rendered.update = (item, prev) => {
      baseUpdate(item, prev);
      sync(item);
    };
    const baseDestroy = rendered.destroy.bind(rendered);
    rendered.destroy = () => {
      for (const registration of registrations.values()) {
        registration.unregister();
      }
      registrations.clear();
      baseDestroy();
    };
  }

  private mediaStatuses(item: CbItem<ChatItemData>): Map<number, MediaStatus> {
    const statuses = new Map<number, MediaStatus>();
    const data = item.data;
    if (data.type !== 'msg' || item.id < 1) return statuses;
    if (
      !['IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'GALLERY'].includes(data.contentType)
    ) {
      return statuses;
    }
    for (const image of data.images ?? []) {
      if (image.msgId && image.msgId > 0) {
        statuses.set(
          image.msgId,
          image.status ?? data.mediaStatus ?? MEDIA_STATUS.READY,
        );
      }
    }
    if (statuses.size === 0 && data.msgId > 0) {
      statuses.set(data.msgId, data.mediaStatus ?? MEDIA_STATUS.READY);
    }
    return statuses;
  }

  private onMessageInteraction(
    intent: 'select' | 'open-menu',
    item: CbItem<ChatItemData>,
    pointer?: { x: number; y: number },
    memberId?: number,
  ): void {
    if (item.data.serverGap) return;
    if (intent === 'open-menu') {
      const contextItem =
        memberId === undefined
          ? (item as CbItem<ChatMsgData>)
          : this.messageInteraction.targetItem(
              item as CbItem<ChatMsgData>,
              memberId,
            );
      const menuItemCount =
        2 +
        (this.canCopyMessage(contextItem.data) ? 1 : 0) +
        (this.canQuote(contextItem.data) ? 1 : 0) +
        (this.canDirectForward(contextItem.data) ? 1 : 0) +
        (this.canWithdrawOrReport(contextItem.data) ? 1 : 0);
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
    identityKey: string,
    _anchor: DOMRect,
  ): Promise<void> {
    const identity = parseUserIdentityKey(identityKey);
    if (!identity) return;
    const conversation = this.userMsgTrd();
    if (conversation?.type === 'P2P') {
      if (
        conversation.peerUser.account !== identity.account ||
        (conversation.peerUser.domain || 'local') !== identity.domain
      )
        return;
      this.dismissContextMenu();
      this.nav.openAside('profile');
      return;
    }
    const threadId = this.threadId();
    if (threadId === undefined) return;
    const profile = await this.memberProfiles.getByIdentity(
      threadId,
      identityKey,
    );
    if (!profile) return;
    this.dismissContextMenu();
    const friendThreadId = this.convList
      .items()
      .find(
        (item) =>
          item.type === 'P2P' &&
          item.peerUser.account === profile.account &&
          (item.peerUser.domain || 'local') === profile.domain &&
          item.peerUser.namespaceId === profile.namespaceId &&
          item.friendshipActive !== false,
      )?.threadId;
    this.route.popupDlg(
      PopupType.CONTACT_IDENTITY,
      {
        identity: {
          account: profile.account,
          name: profile.name,
          avatar: profile.avatar,
          bio: profile.bio,
          domain: profile.domain || 'local',
          namespaceId: profile.namespaceId,
          friendThreadId,
          relationship:
            profile.account === this.userService.sessionProfile()?.account &&
            profile.domain === 'local' &&
            profile.namespaceId === 0
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

  canWithdrawOrReport(message: ChatMsgData): boolean {
    return (
      message.msgId >= 0 &&
      message.status !== 'sending' &&
      message.status !== 'failed' &&
      message.contentType !== 'CALL' &&
      message.contentType !== 'SYSTEM'
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
        this.scroller?.removeItem(seq);
        const deletionSeq = (res.data as { deletionSeq?: unknown } | undefined)
          ?.deletionSeq;
        if (
          this.threadAdapter.syncWithdrawalsAfterMutation() &&
          typeof deletionSeq === 'number' &&
          Number.isSafeInteger(deletionSeq)
        )
          void this.msgRepo.updateTombstoneTarget(threadId, deletionSeq);
      },
      error: () =>
        this.toast.warn(this.transloco.translate('chat.withdrawFailed')),
    });
  }

  private reportMessage(threadId: number, seq: number): void {
    this.threadAdapter.reportMessages({ threadId, seqs: [seq] }).subscribe({
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
      message.contentType === 'PURE_TEXT' ||
      message.contentType === 'IMAGE' ||
      message.contentType === 'VIDEO' ||
      message.contentType === 'AUDIO' ||
      message.contentType === 'FILE' ||
      message.contentType === 'LINK' ||
      message.contentType === 'FORWARD'
    );
  }

  canCopyMessage(message: ChatMsgData): boolean {
    return canCopyMessage(message);
  }

  canQuote(message: ChatMsgData): boolean {
    return message.contentType !== 'SYSTEM';
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
    NonNullable<ChatMsgData['quote']>,
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

  private onScroll(info: CbScrollInfo): void {
    if (
      this.messageContextMenu() &&
      Math.abs(info.scrollTop - this.contextMenuScrollTop) > 0.5
    )
      this.closeContextMenu();
    this.lastMessageScrollTop = info.scrollTop;
    // Drain optimistic sends queued while the newer end was trimmed: noNewer means the mounted tail IS the
    // global newest, so tailAnchorId() is now a safe anchor. Runs before the UI updates below for promptness.
    this.optimistic.drainAtNewest(info.noNewer);
    const unreadReanchor = this.scrollState.update(info, this.scroller);
    this.stableRead.noteScroll();
    if (unreadReanchor !== null)
      queueMicrotask(
        () => void jumpToMessage(this.scroller, unreadReanchor, 'top'),
      );
  }

  private pulseVisibleMention(
    item: CbItem<ChatItemData>,
    host: HTMLElement,
  ): void {
    if (
      item.data.type !== 'msg' ||
      item.data.isSelf ||
      (item.data.mentionState !== 'me' && item.data.mentionState !== 'all')
    )
      return;
    const className =
      item.data.mentionState === 'me'
        ? 'cb-mention-me-pulse'
        : 'cb-mention-all-pulse';
    host.classList.remove(className);
    void host.offsetWidth;
    host.classList.add(className);
    const clear = () => host.classList.remove(className);
    host.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 1600);
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
    this.scroller?.scrollToBottom(true);
  }

  scrollToUnread(): void {
    if (this.scrollState.firstUnreadSeq !== null)
      void jumpToMessage(this.scroller, this.scrollState.firstUnreadSeq, 'top');
  }

  openUploadDetails(): void {
    this.route.popupDlg(PopupType.UPLOAD_DETAIL, {
      threadId: this.threadId(),
    });
  }

  cancelUploadingTransfers(): void {
    this.transferState.cancelUploading();
  }

  retryFailedTransfers(): void {
    this.transferState.retryFailed();
  }

  cancelFailedTransfers(): void {
    this.transferState.cancelFailed();
  }

  // ---------- ChatInputComponent intent → optimistic dispatch ----------

  /** The composer emits one structured intent; route it to the matching optimistic-send path. */
  onSendIntent(intent: ChatSendIntent): void {
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
    const list = Array.from(files);
    if (list.length === 0) return;
    const combined = await this.chooseCombinedSend(list.length);
    if (combined === null) return;
    if (combined) await this.sendWebGallery(list);
    else await this.sendAttachments(list);
  }

  private async sendChosenNativeAttachments(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    const combined = await this.chooseCombinedSend(files.length);
    if (combined === null) return;
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
    const prepared: PreparedWebAttachment[] = Array.from(files).map((file) => {
      const cid = this.newClientMessageId();
      const partId = uuid();
      if (file.type.startsWith('image/'))
        return {
          file,
          cid,
          partId,
          kind: 'image',
          probeMeta: () => readImageDims(file),
        };
      if (file.type.startsWith('video/'))
        return {
          file,
          cid,
          partId,
          kind: 'video',
          probeMeta: () => readVideoMeta(file),
        };
      if (file.type.startsWith('audio/'))
        return { file, cid, partId, kind: 'audio', probeMeta: null };
      return { file, cid, partId, kind: 'file', probeMeta: null };
    });
    const uploads: Promise<void>[] = [];
    const pendingUploads: Array<{
      entry: PreparedWebAttachment;
      item: CbItem<ChatItemData>;
    }> = [];
    for (const entry of prepared) {
      const contentType =
        entry.kind === 'image'
          ? 'IMAGE'
          : entry.kind === 'video'
            ? 'VIDEO'
            : entry.kind === 'audio'
              ? 'AUDIO'
              : 'FILE';
      const item = this.makeOptimisticItem(
        entry.cid,
        '',
        contentType,
        null,
        null,
      );
      this.sendOutbox.retainResource(entry.cid, {
        type: 'web-attachment',
        file: entry.file,
        partId: entry.partId,
        mediaKind: entry.kind,
      });
      this.registerPending(item);
      this.trackTransfer(entry.cid, threadId, entry.kind, entry.file, () =>
        this.startPreparedWebAttachment(entry, item, true),
      );
      pendingUploads.push({ entry, item });
    }
    // Zoneless rendering happens on a later frame. Starting createImageBitmap/<video> in this same
    // browser task can still touch a large file before that frame is painted, so explicitly cross a
    // paint boundary after publishing the complete pending batch.
    await afterNextPaint();
    // Every task is visible before probe/upload completion can mutate the aggregate card.
    for (const { entry, item } of pendingUploads) {
      uploads.push(this.startPreparedWebAttachment(entry, item));
    }
    if (waitForUploads) await Promise.all(uploads);
  }

  private async sendWebGallery(files: readonly File[]): Promise<void> {
    const threadId = this.threadId();
    if (!threadId || files.length < 2) return;
    const cid = this.newClientMessageId();
    const previewUrls: string[] = [];
    const parts = files.map((file, position) => {
      const intent = uploadIntentForMime(file.type);
      const previewUrl = intent === 'FILE' ? '' : URL.createObjectURL(file);
      if (previewUrl) previewUrls.push(previewUrl);
      return { file, partId: uuid(), position, intent, previewUrl };
    });
    const images: AlbumImage[] = parts.map((part) => ({
      kind: part.intent.toLowerCase() as AlbumImage['kind'],
      src: part.previewUrl,
      w: part.intent === 'AUDIO' ? VOICE_BAR_W : 0,
      h: part.intent === 'AUDIO' ? VOICE_BAR_H : 0,
      size: part.file.size,
      name: part.file.name,
      mimeType: part.file.type,
    }));
    const item = this.makeOptimisticItem(cid, '', 'GALLERY', images, null);
    this.sendOutbox.retainResource(cid, {
      type: 'web-gallery',
      parts: parts.map(({ file, partId, position, intent }) => ({
        file,
        partId,
        position,
        intent,
      })),
      previewUrls,
    });
    this.registerPending(item);
    await afterNextPaint();
    await this.uploadWebGallery(cid, parts, item);
  }

  private uploadWebGallery(
    cid: string,
    parts: Parameters<ThreadAttachmentUploadController['uploadWebGallery']>[1],
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    return this.attachmentSender.uploadWebGallery(cid, parts, item, retry);
  }

  private async sendNativeGallery(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    const threadId = this.threadId();
    if (!threadId || files.length < 2) return;
    const cid = this.newClientMessageId();
    const parts = files.map((selection, position) => ({
      selection,
      partId: uuid(),
      position,
    }));
    const item = this.makeOptimisticItem(
      cid,
      '',
      'GALLERY',
      files.map((file) => ({
        kind: file.kind,
        src: file.preview ?? '',
        w: file.w,
        h: file.h,
        size: file.size,
        duration: file.duration,
        name: file.name,
        mimeType: file.mimeType,
      })),
      null,
    );
    this.sendOutbox.retainResource(cid, {
      type: 'native-gallery',
      parts,
      release: () =>
        files.forEach((file) => this.nativeUploads.release(file.uploadId)),
      discard: () =>
        files.forEach((file) => this.nativeUploads.discard(file.uploadId)),
    });
    this.registerPending(item);
    await this.uploadNativeGallery(cid, parts, item);
  }

  private uploadNativeGallery(
    cid: string,
    parts: Parameters<
      ThreadAttachmentUploadController['uploadNativeGallery']
    >[1],
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    return this.attachmentSender.uploadNativeGallery(cid, parts, item, retry);
  }

  private async startPreparedWebAttachment(
    entry: PreparedWebAttachment,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const limitMb =
      entry.kind === 'image' ? 10 : entry.kind === 'video' ? 100 : 50;
    if (await this.rejectOversizedUpload(entry.cid, item, entry.file, limitMb))
      return;
    if (entry.kind === 'image') {
      const meta = await entry.probeMeta();
      return this.enqueueAttachmentUpload(entry.cid, () =>
        this.uploadAndSendImage(
          entry.cid,
          entry.partId,
          entry.file,
          item,
          meta,
          retry,
          true,
        ),
      );
    }
    if (entry.kind === 'video') {
      const meta = await entry.probeMeta();
      return this.enqueueAttachmentUpload(entry.cid, () =>
        this.uploadAndSendVideo(
          entry.cid,
          entry.partId,
          entry.file,
          item,
          meta,
          retry,
          true,
        ),
      );
    }
    if (entry.kind === 'audio') {
      return this.enqueueAttachmentUpload(entry.cid, () =>
        this.uploadAndSendAudio(
          entry.cid,
          entry.partId,
          entry.file,
          item,
          { duration: 0 },
          retry,
        ),
      );
    }
    return this.enqueueAttachmentUpload(entry.cid, () =>
      this.uploadAndSendFile(
        entry.cid,
        entry.partId,
        entry.file,
        item,
        retry,
        true,
      ),
    );
  }

  private async sendNativeAttachments(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    if (!this.threadId()) return;
    const pendingUploads: Array<{
      file: NativeUploadSelection;
      cid: string;
      partId: string;
      item: CbItem<ChatItemData>;
    }> = [];
    for (const file of files) {
      const cid = this.newClientMessageId();
      const contentType =
        file.kind === 'image'
          ? 'IMAGE'
          : file.kind === 'video'
            ? 'VIDEO'
            : 'FILE';
      const images: AlbumImage[] | null =
        file.kind === 'file'
          ? null
          : [
              {
                kind: file.kind,
                src: file.preview ?? '',
                w: file.w,
                h: file.h,
                size: file.size,
                duration: file.duration,
                name: file.name,
              },
            ];
      const fileInfo: FileInfo | null =
        file.kind === 'file'
          ? {
              url: '',
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
            }
          : null;
      const item = this.makeOptimisticItem(
        cid,
        '',
        contentType,
        images,
        fileInfo,
      );
      const partId = uuid();
      this.sendOutbox.retainResource(cid, {
        type: 'native-attachment',
        selection: file,
        partId,
        release: () => this.nativeUploads.release(file.uploadId),
        discard: () => this.nativeUploads.discard(file.uploadId),
      });
      this.registerPending(item);
      pendingUploads.push({ file, cid, item, partId });
    }
    // Mirror the browser-file path: every pending row uses the common insertion/pinning flow
    // before transfer-state updates begin.
    for (const { file, cid, item, partId } of pendingUploads) {
      void this.queueNativeUpload(cid, partId, file, item);
    }
  }

  private queueNativeUpload(
    cid: string,
    partId: string,
    file: NativeUploadSelection,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.transfers.start({
      clientMessageId: cid,
      threadId: tid,
      kind: file.kind,
      name: file.name,
      size: file.size,
      previewUrl: file.preview,
    });
    this.transfers.registerRetry(cid, () => {
      void this.queueNativeUpload(cid, partId, file, item, true);
    });
    this.transfers.registerCancel(cid, () => {
      this.nativeUploads.cancel(file.uploadId);
    });
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendNative(cid, partId, file, item, retry),
    );
  }

  private uploadAndSendNative(
    cid: string,
    partId: string,
    file: NativeUploadSelection,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    return this.attachmentSender.uploadNative(cid, partId, file, item, retry);
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

  /** Send an in-app recording through the dedicated voice pending path. */
  private sendVoice(blob: Blob, duration: number, mimeType: string): void {
    if (!this.threadId()) return;
    const cid = this.newClientMessageId();
    const f = new File([blob], `voice.${mimeTypeToExt(mimeType)}`, {
      type: mimeType || 'audio/webm',
    });
    const preview = URL.createObjectURL(blob);
    const images: AlbumImage[] = [
      {
        kind: 'audio',
        src: preview,
        w: VOICE_BAR_W,
        h: VOICE_BAR_H,
        size: f.size,
        duration,
        name: f.name,
      },
    ];
    const item = this.makeOptimisticItem(cid, '', 'AUDIO', images, null);
    const partId = uuid();
    this.sendOutbox.retainResource(cid, {
      type: 'voice',
      file: f,
      partId,
      duration,
      previewUrl: preview,
    });
    this.dispatchPending(item);
    void this.uploadAndSendAudio(cid, partId, f, item, { duration });
  }

  /** Daily quota failures are business responses (HTTP 200), so the HTTP error interceptor never sees
   * them. Keep the failed bubble/retry affordance and also explain why retrying today cannot succeed. */
  private surfaceSendFailure(
    res: StandardResponse<unknown>,
    threadId: number,
  ): void {
    if (res.code === BusinessCode.FRIEND_NOT_FOUND) {
      this.convList.applyThreadMeta(threadId, { friendshipActive: false });
      this.toast.warn(translateBizResult(res, this.transloco));
      return;
    }
    if (res.code === BusinessCode.GROUP_DISSOLVED) {
      this.convList.applyGroupUpdate(threadId, { dissolvedAt: Date.now() });
      this.toast.warn(translateBizResult(res, this.transloco));
      return;
    }
    if (res.code === BusinessCode.FEDERATION_NAMESPACE_INACTIVE) {
      this.convList.markAuthorityNamespaceInactive(threadId);
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
    this.surfaceSendFailure(res, this.threadId() ?? 0);
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

  private queueImageUpload(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    dims: { w: number; h: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'image', file, () =>
      this.queueImageUpload(cid, partId, file, item, dims, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendImage(cid, partId, file, item, dims, retry, true),
    );
  }

  private queueFileUpload(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'file', file, () =>
      this.queueFileUpload(cid, partId, file, item, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendFile(cid, partId, file, item, retry, true),
    );
  }

  private queueVideoUpload(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    meta: { w: number; h: number; duration: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'video', file, () =>
      this.queueVideoUpload(cid, partId, file, item, meta, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendVideo(cid, partId, file, item, meta, retry, true),
    );
  }

  /** Send-media-first flow: POST /send-media stages a PendingMedia (durable intent, keyed by cid),
   *  then the upload (carrying the same cid via the x-client-message-id header) writes the file and the
   *  server promotes the stage to a real Message. The State Feed wake and canonical pull reconcile
   *  the optimistic bubble — so on upload success there is nothing to do here. Any failure → failPending. */
  private uploadAndSendImage(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    dims: { w: number; h: number },
    retry = false,
    tracked = false,
  ): Promise<void> {
    if (!tracked)
      this.trackTransfer(cid, this.threadId() ?? 0, 'image', file, () =>
        this.queueImageUpload(cid, partId, file, item, dims, true),
      );
    return this.attachmentSender.uploadImage(cid, partId, file, item, retry);
  }

  private uploadAndSendFile(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry = false,
    tracked = false,
  ): Promise<void> {
    if (!tracked)
      this.trackTransfer(cid, this.threadId() ?? 0, 'file', file, () =>
        this.queueFileUpload(cid, partId, file, item, true),
      );
    return this.attachmentSender.uploadFile(cid, partId, file, item, retry);
  }

  private uploadAndSendVideo(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    meta: { w: number; h: number; duration: number },
    retry = false,
    tracked = false,
  ): Promise<void> {
    if (!tracked)
      this.trackTransfer(cid, this.threadId() ?? 0, 'video', file, () =>
        this.queueVideoUpload(cid, partId, file, item, meta, true),
      );
    return this.attachmentSender.uploadVideo(cid, partId, file, item, retry);
  }

  private uploadAndSendAudio(
    cid: string,
    partId: string,
    file: File,
    item: CbItem<ChatItemData>,
    meta: { duration: number },
    retry = false,
  ): Promise<void> {
    this.trackTransfer(cid, this.threadId() ?? 0, 'audio', file, () =>
      this.uploadAndSendAudio(cid, partId, file, item, meta, true),
    );
    return this.attachmentSender.uploadAudio(cid, partId, file, item, retry);
  }

  private trackTransfer(
    clientMessageId: string,
    threadId: number,
    kind: MediaTransferKind,
    file: File,
    retry: () => Promise<void>,
  ): void {
    this.transfers.start({ clientMessageId, threadId, kind, file });
    this.transfers.registerRetry(clientMessageId, () => {
      void retry();
    });
  }

  private async rejectOversizedUpload(
    clientMessageId: string,
    item: CbItem<ChatItemData>,
    file: File,
    limitMb: number,
  ): Promise<boolean> {
    if (file.size <= limitMb * 1024 * 1024) return false;
    this.transfers.fail(
      clientMessageId,
      this.transloco.translate('transfer.fileTooLarge', { limit: limitMb }),
      false,
    );
    await this.failPending(item);
    return true;
  }

  /** Reduce uploadFile's event stream to its final response body (the uploaded file metadata). Null on
   *  error. `cid` promotes a staged send; on a successful response the server has already committed the
   *  Message and the SSE echo reconciles the bubble. */
  /** Retry a failed send (the row's retry output → createMsgCbElement onRetry → here, with msgId = clientMessageId).
   *  Flip the SAME entry back to 'sending' (stable identity, in-place morph), then replay the send. The idempotent
   *  retry republishes the content head, so the canonical pull reconciles the bubble normally. */
  async retrySend(clientMessageId: string): Promise<void> {
    await this.sendRetry.retry(clientMessageId);
  }

  private async cancelPending(clientMessageId: string): Promise<void> {
    if (this.optimistic.cancel(clientMessageId))
      this.transfers.discard(clientMessageId);
  }

  /** Mark an optimistic send FAILED: the source flips its pending entry to status:'failed' (stable identity);
   *  the kernel's reconcilePending morphs the bubble in place (sending→failed) + FLIPs it to the tail. Self-heals
   *  the lost-HTTP-response race: if the SSE echo already dropped the pending entry, failPending finds nothing. */
  private async failPending(item: CbItem<ChatItemData>): Promise<void> {
    await this.optimistic.fail(item);
  }

  /** Record HTTP/upload acceptance without confirming delivery visually. The optimistic row becomes `accepted`:
   *  its spinner stays visible, but cancellation and dimming stop. The push echo is the sole owner of the later
   *  spinner→check choreography. If the echo already won the race it has removed pending, so this is a no-op. */
  private async markAccepted(item: CbItem<ChatItemData>): Promise<void> {
    if (!(await this.optimistic.accept(item))) return;
    // A successful send means the local-user quota breaker is no longer tripped — drop the pause banner.
    this.sendPaused.set(false);
  }

  // ---------- optimistic-insert orchestration (ported from the playground) ----------

  /** Route an optimistic send so it anchors on the GLOBAL newest only once that end is mounted. When pinned
   *  (noNewer, the common case) this is synchronous. When the newer end is trimmed (scrolled into history),
   *  queue the item and scrollToBottom() — the follow chain mounts the newest and onScroll drains the queue. */
  private dispatchPending(item: CbItem<ChatItemData>): void {
    this.optimistic.dispatch(item);
  }

  /** Keep an attachment send in the source outbox for retry/SSE reconciliation without mounting a
   * second per-file optimistic bubble. The aggregate transfer card is the sole pending presentation. */
  private registerPending(item: CbItem<ChatItemData>): void {
    this.optimistic.register(item);
  }

  /** Build a fully-shaped optimistic self message. id/msgId = a synthetic NEGATIVE placeholder (msgId is a number
   *  now, so the in-flight bubble cannot carry the clientMessageId as its id); the client tracks the bubble by the
   *  separate clientMessageId (the kernel's reconcile key) until the server echo arrives. Negative ids never collide
   *  with server-assigned seqs (always positive). status:'sending', kind:'pending'. Any album cell's msgId is stamped
   *  to the same placeholder so the dev-badge range stays self-consistent before the real lands. */
  private makeOptimisticItem(
    clientMessageId: string,
    text: string,
    contentType: AuthoredContentType,
    images: AlbumImage[] | null,
    file: FileInfo | null,
  ): CbItem<ChatMsgData> {
    const profile = this.userService.sessionProfile();
    if (!profile) throw new Error('session profile is required to send');
    return this.optimistic.makeItem(
      clientMessageId,
      profile,
      this.userMsgTrd()?.type === 'GROUP',
      text,
      contentType,
      images,
      file,
    );
  }

  private newClientMessageId(): string {
    return this.optimistic.newClientMessageId();
  }

  private teardown(): void {
    this.cancelPaste();
    this.nativeDraft.reset();
    this.messageInteraction.reset();
    this.stableRead.flush();
    this.stableRead.reset();
    this.scrollState.reset();
    this.stickyOverlays()?.clear();
    this.scroller?.destroy(); // destroy() also calls source.destroy() (unsubscribes SSE)
    this.scroller = undefined;
    this.source = undefined;
    this.optimistic.reset();
    this.kernelReady = false;
    // (In-chat search visibility lives on NavStateMachineService now — cleared by openChat/closeChat on
    // thread switch / going home — so no per-pane reset is needed here.)
  }

  /** Tear down the kernel + source but keep the COMPONENT instance alive. The A/B buffer host demotes a pane
   *  to background and idles its kernel here (bounding memory + SSE to one warm pane). Resets `currentTrdId`
   *  so the pane is COLD — a subsequent re-selection of this thread drives {@link reset} to re-initialize
   *  via {@link reinit}; idempotent. */
  teardownKernel(): void {
    this.chatInput()?.saveDraft();
    this.teardown();
    this.currentTrdId = null;
  }

  /** Android sends this only when its native composer is genuinely destroyed. Temporary hide operations
   *  (dialogs, selection mode, attachment surfaces) deliberately do not publish the draft. */
  private saveNativeComposerDraft(): void {
    const threadId = this.threadId();
    if (!threadId) return;
    this.nativeDraft.save(threadId, escapeComposerText);
  }

  /** Force an in-place re-init for the current bound thread (teardown + rebuild), emitting `ready` when the
   *  fresh kernel settles. The constructor init effect does NOT re-fire here (its deps — viewport/content/
   *  userMsgTrd — are unchanged), so this is the sole re-init path when the data beneath a pane changes
   *  (for example, after a server-applied history boundary) or when a resident pane is cold
   *  ({@link reset}). */
  private reinit(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    const trd = this.userMsgTrd();
    if (!vp || !ct || !trd) return;
    this.teardown();
    this.currentTrdId = null;
    this.initScroller(vp, ct, trd);
    this.currentTrdId = trd.threadId;
  }

  retryInitialLoad(): void {
    if (!this.initialLoadFailed()) return;
    this.initialLoadFailed.set(false);
    this.initialLoading.set(true);
    this.reinit();
  }

  /** Whether the kernel is live for the currently-bound thread (init settled AND not since idled). The A/B
   *  host's fg-resident branch reads this so it only re-inits a genuinely COLD pane (re-open after a close)
   *  and skips a spurious reset on an already-warm one — which matters because every `promote()` flips
   *  `fgSlot` and re-triggers the coordinator, so without this guard a warm pane would be reset on every
   *  switch. A plain method (not a signal): a synchronous snapshot read, intentionally untracked. */
  isWarm(): boolean {
    const trd = this.userMsgTrd();
    return !!trd && this.kernelReady && this.currentTrdId === trd.threadId;
  }

  /** Ensure this pane is initialized for its CURRENT bound thread, emitting `ready` when so. The A/B host
   *  calls this when re-selecting a thread already bound to a (possibly idled) pane: the input-keyed init
   *  effect cannot re-fire on an unchanged ConversationItem, so without this nudge `ready` would never emit
   *  and the switch would strand. WARM (kernel already settled for this thread) → `ready` now, preserving
   *  the instant fast-flip-back the A/B buffer exists for (no re-fetch); COLD (idled via teardownKernel, or
   *  mid-init) → {@link reinit} → `ready`. The warm emit is deferred to a microtask so it lands outside the
   *  host's coordinator effect run, mirroring the async `ready` of a cold reinit. */
  reset(): void {
    const trd = this.userMsgTrd();
    if (!trd) return;
    if (this.kernelReady && this.currentTrdId === trd.threadId) {
      queueMicrotask(() => this.ready.emit(trd.threadId));
      return;
    }
    this.reinit();
  }

  // ---------- chat header MORE-menu integration ----------

  /** Jump the kernel to a search match seq (from the search bar's prev/next). The kernel re-seeds around
   *  an unmounted seq and flashes the row via the existing highlight path. */
  async onSearchJump(id: number): Promise<void> {
    const found = await jumpToMessage(this.scroller, id);
    if (found === false) {
      this.toast.warn(this.transloco.translate('chat.messageNotFound'));
    }
  }

  /** Host-level navigation controls. These preserve the chatbox abstraction without exposing its scroller. */
  scrollToTop(): void {
    this.scroller?.scrollToTop();
  }

  scrollInfo(): CbScrollInfo | undefined {
    return this.scroller?.getInfo();
  }

  async jumpToMessage(id: number): Promise<boolean> {
    return (await jumpToMessage(this.scroller, id)) !== false;
  }

  /** Recreate the injected source while keeping the production chatbox shell mounted. */
  reload(): void {
    this.reinit();
  }

  ngOnDestroy(): void {
    this.deletedSub.unsubscribe();
    this.hideNativeComposer();
    this.teardown();
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

/** Bridge-safe avatar payload. Return only the base64 body; MIME travels in a separate field. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('invalid data URL'));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function avatarFallbackText(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return `${Array.from(words[0])[0] ?? ''}${Array.from(words[1])[0] ?? ''}`.toLocaleUpperCase();
  return (Array.from(words[0] ?? '')[0] ?? '?').toLocaleUpperCase();
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
