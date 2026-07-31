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
  viewChild,
} from '@angular/core';
import { firstValueFrom, takeUntil } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import {
  ChatBoxScroller,
  type ScrollerApi,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import {
  pickStickyDateLabel,
  isViewportTransformEnd,
  unreadDividerOverlapsStickyDate,
} from '../../lib/sticky-date';
import { HttpItemSource } from './http-item-source';
import { MediaProbeScheduler } from './media-probe-scheduler';
import {
  createMsgCbElement,
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
  conversationAvatarType,
  conversationAvatarIdentityId,
  conversationAvatarSrc,
} from '../user-avatar/conversation-avatar.util';
import {
  ChatInputComponent,
  type ChatSendIntent,
} from '../../lib/chat-input/chat-input.component';
import { KbdOffsetDirective } from '../../directives/kbd-offset.directive';
import { ComposerWidthSourceDirective } from '../../directives/composer-width-source.directive';
import { StickyDateOverlayComponent } from '../message-cards/sticky-date-overlay/sticky-date-overlay.component';
import { uuid } from '../../lib/uuid';
import { assetUrl } from '../../services/runtime';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';
import {
  avatarUrl as sizedAvatarUrl,
  UserService,
} from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { LayoutService } from '../../services/layout.service';
import { InputDeviceService } from '../../services/input-device.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { FileDetailService } from '../file-detail-viewer/file-detail-viewer.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  displayThreadName,
  type ConversationItem,
  type StandardResponse,
} from '../../services/model';
import { serializeNativeComposerText } from '../chat-editor/editor-message-serializer';
import { filterMentionCandidates } from '../chat-editor/mention-candidates';
import { isMessageViewportAtBottom } from './message-scroll-state';
import {
  MediaTransferService,
  type MediaTransferKind,
} from '../../services/media-transfer.service';
import {
  NativeUploadError,
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { AttachmentUploadQueueService } from '../../services/attachment-upload-queue.service';
import { DebugToolsService } from '../../services/debug-tools.service';
import { ToastService } from '../../services/toast.service';
import {
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
import { BusinessCode, translateBizResult } from '../../services/biz-code';
import { tauriInvoke } from '../../services/runtime';
import { ProfileRepository } from '../../services/profile-store.service';
import {
  categorizeFilename,
  fileExt,
  type FileCategory,
} from '../message-cards/file-meta.util';
import { PopupType, RouteService } from '../../services/route.service';
import { GroupService } from '../../services/group.service';
import { ChatAppearanceService } from '../../services/chat-appearance.service';
import { GroupEventService } from '../../services/group-event.service';
import {
  ALL_MENTION_ID,
  escapePlainText,
  toDisplayText,
  toRenderMessageEntities,
} from '../../lib/message-entity';
import type { ChatMember } from '../chat-editor/chat-editor.component';
import { StableReadTracker } from './stable-read-tracker';
import { messageOpenOptions } from './message-open-position';
import type { ForwardMessageItem } from '../forward-message-card/forward-message-card.component';
import type { ForwardDialogResult } from '../forward-dialog/forward-dialog.component';

type PreparedWebAttachment =
  | {
      file: File;
      cid: string;
      kind: 'image';
      probeMeta: () => Promise<{ w: number; h: number }>;
    }
  | {
      file: File;
      cid: string;
      kind: 'video';
      probeMeta: () => Promise<{ w: number; h: number; duration: number }>;
    }
  | {
      file: File;
      cid: string;
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
 * source's pending area, and fires the HTTP send. CONFIRMATION is the SSE echo (the backend always re-fans
 * NEW_MESSAGE to the sender, including for idempotent retries), routed through the kernel's onMessageSignal
 * (NOT appendLive — that direct-mounts and would double-mount the real beside the optimistic). On HTTP failure
 * the optimistic is morphed to a failed bubble (reconcilePending) with a retry affordance.
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
    ChatInputComponent,
    KbdOffsetDirective,
    ComposerWidthSourceDirective,
    StickyDateOverlayComponent,
    EmptyStateComponent,
    UserAvatarComponent,
    TranslocoModule,
  ],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  readonly threadId = input<number>();
  readonly userMsgTrd = input<ConversationItem>();
  /** The A/B host keeps two threads mounted; only the foreground layer may own the one native composer. */
  readonly nativeComposerActive = input(false);

  /** Emits the threadId once the kernel finishes `init()` on a thread open / re-init — the A/B buffer host
   *  awaits this before cross-fading a pane in, so the reveal never races a half-initialized kernel. Carries
   *  `threadId` (NOT `trd.id` — that's the ThreadParticipant row id, a different value) so the host can
   *  discard stale emits from a superseded reset. Not emitted on teardown. */
  readonly ready = output<number>();

  private readonly viewportRef =
    viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly containerRef =
    viewChild<ElementRef<HTMLDivElement>>('container');
  private readonly contentRef =
    viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly transferStackRef =
    viewChild<ElementRef<HTMLDivElement>>('transferStack');
  /** The chat header element — its bottom edge is the STABLE visible-top reference for the sticky-date
   *  pill. The viewport carries the keyboard-lift `transform`, so its own `getBoundingClientRect().top`
   *  slides under the header while the keyboard is up; the header does not transform, so its bottom is the
   *  true top of the visible content (see updateStickyDate). */
  private readonly headerRef = viewChild('msgHeader', {
    read: ElementRef<HTMLElement>,
  });
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly msgRepo = inject(MessageRepository);
  private readonly userService = inject(UserService);
  private readonly profileRepo = inject(ProfileRepository);
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  readonly inputDevice = inject(InputDeviceService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);
  private readonly nav = inject(NavStateMachineService);
  private readonly convList = inject(ConversationListService);
  private readonly transfers = inject(MediaTransferService);
  private readonly nativeUploads = inject(NativeUploadService);
  private readonly attachmentUploads = inject(AttachmentUploadQueueService);
  private readonly route = inject(RouteService);
  private readonly sendOutbox = inject(ThreadSendOutbox);
  private readonly debugTools = inject(DebugToolsService);
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);
  private readonly groupService = inject(GroupService);
  private readonly chatAppearance = inject(ChatAppearanceService);
  private readonly groupEvents = inject(GroupEventService);
  private readonly http = inject(HttpClient);
  readonly nativeComposer = inject(NativeComposerService);
  readonly mentionMembers = signal<ChatMember[]>([]);
  private nativeComposerContextId: number | null = null;
  private nativeComposerThreadId: number | null = null;
  private nativeComposerBoundsObserver?: ResizeObserver;
  private nativeComposerBoundsFrame = 0;
  private nativeComposerBoundsDirty = false;
  private nativeComposerBoundsTarget?: HTMLElement;
  private nativeComposerLastBounds?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  private readonly nativeVoiceItems = new Map<string, CbItem<ChatItemData>>();

  private scroller?: ScrollerApi<ChatItemData>;
  private source?: HttpItemSource;
  private currentTrdId: number | null = null;
  /** True only once `initScroller`'s async `init()` has settled (set in its `.finally`, cleared at init
   *  start + in `teardown`). Distinct from `currentTrdId === trd.id` (which is set synchronously at init
   *  START): a pane mid-init has the right `currentTrdId` but is NOT yet ready. {@link reset} uses this to
   *  tell a WARM resident (init done → emit `ready` now, no re-fetch) from a COLD one (idled via
   *  `teardownKernel` → reinit). */
  private kernelReady = false;
  /** Frozen at chat-open before any local/server read cursor advances. */
  private firstUnreadSeq: number | null = null;
  private readonly stableRead = new StableReadTracker((seq) => {
    const threadId = this.threadId();
    if (threadId !== undefined) this.convList.markReadStable(threadId, seq);
  });

  readonly atBottom = signal(true);
  /** Incoming message signals received while the user is reading history. Cleared only after the viewport
   *  reaches the visible newest zone, not merely the kernel's much wider newer-prefetch threshold. */
  readonly newMessageCount = signal(0);
  /** The frozen unread boundary is above the visible viewport; shown as the upward counterpart to latest. */
  readonly unreadBoundaryAbove = signal(false);
  readonly newMessageLabel = computed(() => {
    const count = this.newMessageCount();
    return count > 99 ? '99+' : String(count);
  });
  readonly stickyDate = signal<string | null>(null);
  /** True while the kernel fetches the initial batch on a thread open (or re-init on switch). Used only to
   *  keep the empty-thread state hidden until init settles; ChatPane owns the switch-loading spinner. */
  readonly initialLoading = signal(true);
  readonly selectionMode = signal(false);
  readonly selectedMessageIds = signal<ReadonlySet<number>>(new Set());
  readonly selectedCount = computed(() => this.selectedMessageIds().size);
  private readonly selectedMessageItems = new Map<
    number,
    CbItem<ChatItemData>
  >();
  readonly messageContextMenu = signal<{
    item: CbItem<ChatItemData>;
    x: number;
    y: number;
  } | null>(null);

  /** True when the kernel's mounted window is empty — the thread is open but has no messages (a fresh P2P
   *  friendship, a newly-created group, or after clear-history). Maintained from onScroll's `mounted` count:
   *  the kernel's emit() fires on init's empty branch, on every mount, and on optimistic/incoming inserts, so
   *  the hero card reacts the instant the first message — including an optimistic send — mounts. Reset to false
   *  in teardown; the template additionally gates on !initialLoading() so the card never flashes mid-load. */
  private readonly mountedMessageCount = signal(0);
  /** Scroll-driven SSE backstop for federated media status — one instance per open thread. Owns the
   *  in-flight ('downloading') seqs + the debounced/rate-limited bulk probe. See MediaProbeScheduler. */
  private readonly probe = new MediaProbeScheduler(
    this.msgService,
    this.msgRepo,
  );

  /** P2P block state, derived from the conv item's `blocked` field (patched live on block/unblock). When
   *  true the composer is swapped for an unblock banner — a blocked user can neither send nor be sent to. */
  readonly blockedPeer = computed(() => !!this.userMsgTrd()?.blocked);
  /** The media viewer must also suppress the native sibling composer, which otherwise sits outside the
   *  WebView DOM and can remain visible above a CDK overlay. The browser composer uses the same flag. */
  readonly mediaViewerOpen = computed(() =>
    this.nav.paneStack().some((pane) => pane.kind === 'gallery'),
  );
  /** Native composer is a sibling of the WebView, so CSS stacking cannot place a web overlay above it.
   *  Treat every chat aside/transient pane as a higher semantic layer and unmount the native surface
   *  while that layer is active. This covers peer profile/group info as well as dialogs and viewers. */
  readonly nativeComposerOccluded = computed(
    () => this.nav.aside().length > 0 || this.nav.paneStack().length > 0,
  );
  readonly uploadingTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers
      .tasks()
      .filter(
        (task) =>
          task.threadId === threadId &&
          task.kind !== 'audio' &&
          task.status === 'uploading',
      );
  });
  /** Only actively uploading attachments are shown in the aggregate send box. A completed upload leaves
   * immediately; when the last upload completes Angular removes the whole tail-cap card. */
  readonly sendingTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers
      .tasks()
      .filter(
        (task) =>
          task.threadId === threadId &&
          task.kind !== 'audio' &&
          task.status === 'uploading',
      );
  });
  readonly failedTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers
      .tasks()
      .filter(
        (task) =>
          task.threadId === threadId &&
          task.kind !== 'audio' &&
          task.status === 'failed',
      );
  });
  readonly retryableFailedTransfers = computed(() =>
    this.failedTransfers().filter((task) => task.retryable !== false),
  );
  /** The per-thread queue uploads attachments serially. Highlight only the task currently moving bytes;
   * before its first progress event, the first queued task is the active one. */
  readonly currentUploadingTransferId = computed(() => {
    const tasks = this.sendingTransfers().filter(
      (task) => task.status === 'uploading',
    );
    const active = tasks.find(
      (task) => task.loaded > 0 && task.loaded < task.size,
    );
    return active?.clientMessageId ?? tasks[0]?.clientMessageId ?? null;
  });
  readonly displayedSendingTransfers = computed(() => {
    const tasks = this.sendingTransfers();
    const currentId = this.currentUploadingTransferId();
    if (!currentId) return tasks;
    const current = tasks.find((task) => task.clientMessageId === currentId);
    return current
      ? [current, ...tasks.filter((task) => task.clientMessageId !== currentId)]
      : tasks;
  });
  readonly transferExt = (name: string): string => fileExt(name);
  readonly transferCategory = (name: string): FileCategory =>
    categorizeFilename(name);
  readonly transferProgress = (loaded: number, size: number): number =>
    size > 0
      ? Math.min(100, Math.max(0, Math.round((loaded / size) * 100)))
      : 0;
  /** The global attachment card is one logical mounted tail item regardless of the number of files it
   * aggregates. Include it in empty-state accounting even though the kernel stores it in its measured tail
   * slot rather than in the message cursor array. */
  readonly threadEmpty = computed(
    () =>
      this.mountedMessageCount() === 0 &&
      this.sendingTransfers().length === 0 &&
      this.failedTransfers().length === 0,
  );
  readonly uploadCountLabel = computed(() => {
    return String(this.sendingTransfers().length);
  });
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

  /** Optimistic sends queued while the newer end was trimmed (scrolled into history); drained in onScroll once
   *  the kernel reports noNewer (the mounted tail is the global newest → safe to anchor on). */
  private pendingOptimistic: CbItem<ChatItemData>[] = [];
  /** Non-audio attachments share one FIFO upload lane. All selected tasks are registered before the
   * first upload starts, so the aggregate send box is the only pending UI and keeps the full batch in
   * selection order. Voice notes deliberately bypass this lane. */

  constructor() {
    effect((onCleanup) => {
      const trd = this.userMsgTrd();
      const threadId = this.threadId();
      if (!trd || trd.type !== 'GROUP' || threadId === undefined) {
        this.mentionMembers.set([]);
        return;
      }
      let active = true;
      const load = () => {
        this.groupService.getThreadMembers(threadId).subscribe((res) => {
          if (!active || res.code !== 0) return;
          const members = (res.data ?? []).map((member) => ({
            id: member.account,
            label: member.name,
            avatarUrl: assetUrl(sizedAvatarUrl(member.avatar, 32)),
          }));
          if (trd.role === 'OWNER' || trd.role === 'ADMIN') {
            members.unshift({
              id: ALL_MENTION_ID,
              label: this.transloco.translate('chat.mentionAll'),
              avatarUrl: '',
            });
          }
          this.mentionMembers.set(members);
        });
      };
      load();
      const sub = this.groupEvents.rosterChanged$.subscribe((groupId) => {
        if (groupId === trd.group.id) load();
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
      if (this.currentTrdId === trd.id) return;
      this.teardown();
      this.initScroller(vp.nativeElement, ct.nativeElement, trd);
      this.currentTrdId = trd.id;
    });
    // Immunity frame drain: when a route-transition freeze ends, apply any viewport resize the kernel
    // deferred so the message list re-pins to the post-animation viewport exactly once.
    effect(() => {
      if (this.layout.reflowFrozen()) return; // act only on the unfrozen edge
      this.scroller?.flushViewportResize();
      if (this.nativeComposerBoundsDirty) this.scheduleNativeComposerBounds();
    });
    effect(() => {
      const threadId = this.threadId();
      const shouldShow =
        this.nativeComposer.supported &&
        this.nativeComposerActive() &&
        threadId !== undefined &&
        !this.initialLoading() &&
        !this.blockedPeer() &&
        !this.nativeComposerOccluded() &&
        !this.selectionMode();
      if (!shouldShow) {
        this.hideNativeComposer();
        return;
      }
      const theme = this.theme.effective();
      if (this.nativeComposerThreadId === threadId) {
        if (this.nativeComposerContextId !== null)
          this.nativeComposer.update(this.nativeComposerContextId, { theme });
        return;
      }
      this.hideNativeComposer();
      const contextId = ++nativeComposerContextSequence;
      this.nativeComposerContextId = contextId;
      this.nativeComposerThreadId = threadId;
      this.nativeComposer.show({
        version: 1,
        contextId,
        threadId: String(threadId),
        placeholder: this.transloco.translate('chat.messagePlaceholder'),
        initialDraft: '',
        sending: false,
        canRecord: true,
        canUpload: true,
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
      if (!progress || !this.nativeVoiceItems.has(progress.clientMessageId))
        return;
      this.transfers.progress(
        progress.clientMessageId,
        progress.loaded,
        progress.total,
      );
    });
  }

  private hideNativeComposer(): void {
    this.nativeComposerBoundsObserver?.disconnect();
    this.nativeComposerBoundsObserver = undefined;
    if (this.nativeComposerBoundsFrame)
      cancelAnimationFrame(this.nativeComposerBoundsFrame);
    this.nativeComposerBoundsFrame = 0;
    this.nativeComposerBoundsDirty = false;
    this.nativeComposerBoundsTarget = undefined;
    this.nativeComposerLastBounds = undefined;
    const contextId = this.nativeComposerContextId;
    if (contextId !== null) this.nativeComposer.hide(contextId);
    this.nativeComposerContextId = null;
    this.nativeComposerThreadId = null;
  }

  private observeNativeComposerBounds(contextId: number): void {
    // Observe the shell-owned pane rather than the chatbox: message/composer/keyboard layout changes inside
    // the chat must not feed back into the native overlay's horizontal bounds.
    const chatbox = this.containerRef()?.nativeElement;
    if (!chatbox) return;
    const target = chatbox.closest<HTMLElement>('.chat-slot');
    if (!target) return;
    this.nativeComposerBoundsTarget = target;
    this.nativeComposerBoundsObserver = new ResizeObserver(() => {
      if (contextId !== this.nativeComposerContextId) return;
      this.scheduleNativeComposerBounds();
    });
    this.nativeComposerBoundsObserver.observe(target);
    this.scheduleNativeComposerBounds();
  }

  /** Coalesce wrapper changes and publish only a settled, post-animation layout rectangle. */
  private scheduleNativeComposerBounds(): void {
    this.nativeComposerBoundsDirty = true;
    if (this.layout.reflowFrozen() || this.nativeComposerBoundsFrame) return;
    this.nativeComposerBoundsFrame = requestAnimationFrame(() => {
      this.nativeComposerBoundsFrame = 0;
      if (this.layout.reflowFrozen()) return;
      const target = this.nativeComposerBoundsTarget;
      const contextId = this.nativeComposerContextId;
      if (!target || contextId === null) return;
      const rect = target.getBoundingClientRect();
      const next = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      const previous = this.nativeComposerLastBounds;
      this.nativeComposerBoundsDirty = false;
      if (
        previous &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
      ) {
        return;
      }
      this.nativeComposerLastBounds = next;
      this.nativeComposer.setBounds(
        contextId,
        new DOMRectReadOnly(next.left, next.top, next.width, next.height),
      );
    });
  }

  private handleNativeComposerEvent(event: NativeComposerEvent): void {
    switch (event.kind) {
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
          this.onSendIntent(
            mentions.length === 0 && /^https?:\/\/\S+$/i.test(text)
              ? { kind: 'link', url: text }
              : { kind: 'text', text: stored },
          );
        }
        this.nativeComposer.acknowledge(event.actionId, accepted);
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
      case 'resolveMedia':
        void this.resolveNativeMentionMedia(event);
        return;
      case 'pickAttachment':
        void this.pickNativeComposerAttachment(event);
        return;
      case 'geometry':
      case 'draft':
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
    const cid = event.clientMessageId;
    if (event.phase === 'started') {
      if (this.nativeVoiceItems.has(cid)) return;
      const duration = event.durationMs / 1000;
      const images: AlbumImage[] = [
        {
          kind: 'audio',
          src: '',
          w: VOICE_BAR_W,
          h: VOICE_BAR_H,
          size: event.size,
          duration,
          name: 'voice.m4a',
        },
      ];
      const item = this.makeOptimisticItem(cid, '', 'AUDIO', images, null);
      this.nativeVoiceItems.set(cid, item);
      this.transfers.start({
        clientMessageId: cid,
        threadId: event.threadId,
        kind: 'audio',
        name: 'voice.m4a',
        size: event.size,
      });
      this.transfers.registerCancel(cid, () => {
        void tauriInvoke('cancel_upload', { clientMessageId: cid });
      });
      this.dispatchPending(item);
      return;
    }
    const item = this.nativeVoiceItems.get(cid);
    if (!item) return;
    if (event.phase === 'completed') {
      this.transfers.complete(cid);
      void this.markSent(item);
      this.nativeVoiceItems.delete(cid);
    } else {
      const reason =
        event.error ||
        String(this.transloco.translate('transfer.uploadFailed'));
      this.transfers.fail(cid, reason);
      this.toast.warn(reason, { duration: 6000 });
      void this.failPending(item);
    }
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
    this.source = new HttpItemSource(
      trd,
      this.msgRepo,
      this.userService,
      this.wsService,
      this.sendOutbox,
      // SSE live path is SIGNAL-ONLY: onSseEvent filters by threadId and fires onSignal — the body is not
      // shaped/cached here (the conversation-list preview reads it in its own subscriber; the chatbox treats
      // the frame as "newer data exists, go pull it"). onMessageSignal pulls from the DB via getNewer /
      // init(-1), which is also where rawToItems runs once (so ids register once — no double-registration to
      // dedup away a self-send echo / reply on an empty thread). onMessageSignal is the optimistic-confirm
      // reconcile path (appendLive direct-mounts and would double-mount a self-send real beside its bubble).
      {
        onSignal: (seq: number) => {
          if (!this.atBottom())
            this.newMessageCount.update((count) => count + 1);
          // onMessageSignal is async — without a .catch a kernel throw here would be an unhandled rejection
          // and the just-signaled live item would never mount (silent drop in the open chatbox). The seq is the
          // message's per-thread seq (== its item id); the kernel tracks the MAX seen during the init-fetch
          // window to decide whether a post-init replay is actually needed.
          void this.scroller
            ?.onMessageSignal(seq)
            .catch((e) => console.error('[chat] onMessageSignal rejected', e));
        },
        // mediaStatus change (MEDIA_STATUS SSE / scroll probe / retry ack) → re-render the one card in place.
        // updateItemData is synchronous + height-neutral, so no async/catch and no anchor shift.
        onMediaStatus: (seq: number, status: MediaStatus) => {
          this.scroller?.updateItemData(seq, { mediaStatus: status });
          this.probe.track(seq, status === MEDIA_STATUS.DOWNLOADING);
        },
        // Profile hydration is deliberately off the init critical path. Patch any currently mounted row
        // once it arrives; album member ids resolve to their merged mounted entry in the kernel.
        onProfile: (
          seq: number,
          profile: {
            name: string;
            avatar: string;
            avatarIdentityId: number;
            isSelf: boolean;
          },
        ) => {
          this.scroller?.updateItemData(seq, profile);
        },
      },
      this.profileRepo,
    );
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      source: this.source,
      hooks: {
        createItem: (item, prev) => this.createItem(item, prev),
        createSkeleton: () => createGhostCbElement(),
        mergeItems: (items) =>
          mergeAlbumItemsAtBoundary(items, this.firstUnreadSeq),
        absorbTail: (target, incoming) =>
          incoming.id === this.firstUnreadSeq
            ? null
            : absorbAlbumTail(target, incoming),
      },
      onScroll: (info) => this.onScroll(info),
      onFullyVisibleEnter: (entries) => {
        for (const entry of entries) {
          this.pulseVisibleMention(entry.item, entry.el);
          const ids = entry.item.ids ?? [entry.item.id];
          this.stableRead.noteFullyVisible(ids);
        }
      },
      // Reveal the locally cached latest page immediately. Older history is backfilled after ready,
      // so a one-message preview cache never makes pane switching wait for the network.
      config: { deferInitFill: true },
      // Immunity frame: hold the kernel's viewport reflow while a route-transition slide is in flight.
      isFrozen: () => this.layout.reflowFrozen(),
    });
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
    this.kernelReady = false;
    const boundary = this.convList.unreadEntryBoundary(trd.threadId);
    this.firstUnreadSeq = boundary?.firstUnreadSeq ?? null;
    const openOptions = messageOpenOptions(
      this.chatAppearance.openPosition(),
      this.firstUnreadSeq,
    );
    void this.scroller
      .init(
        openOptions
          ? {
              ...openOptions,
              onFallbackToLatest: () => {
                this.firstUnreadSeq = null;
                this.unreadBoundaryAbove.set(false);
              },
            }
          : undefined,
      )
      .finally(() => {
        this.initialLoading.set(false);
        this.kernelReady = true;
        // `onScroll` normally runs after the initial batch mounts, but the first paint must not depend on that
        // kernel callback: explicitly recompute once init has settled so a top-anchored unread divider suppresses
        // the floating date pill before the pane is handed to the user.
        this.updateStickyDate();
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
        this.source?.finishLocalInit(
          this.convList.latestSeq(trd.threadId),
          trd.lastMessageSeq,
        );
        // A missed-message sync commonly leaves exactly one preview body in IDB after login. Backfill one
        // older page only after the pane is ready; the kernel preserves the bottom/current-item anchor.
        void this.scroller
          ?.backfillOlder?.()
          .catch((e) => console.error('[chat] history backfill rejected', e));
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
    const { isShowHead, isGroupStart, showDate } = computeRowFlags(item, prev);
    if (item.data.mediaStatus === MEDIA_STATUS.DOWNLOADING)
      this.probe.track(item.id, true);
    const isUnreadStart =
      this.firstUnreadSeq !== null &&
      (item.id === this.firstUnreadSeq ||
        item.ids?.includes(this.firstUnreadSeq) === true);
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
    );
    const selection = this.messageSelectionState(item);
    rendered.el.classList.toggle(
      'cb-message--selection-mode',
      this.selectionMode(),
    );
    rendered.el.classList.toggle('cb-message--selected', selection === 'all');
    rendered.el.classList.toggle(
      'cb-message--partially-selected',
      selection === 'some',
    );
    rendered.el.setAttribute('aria-selected', String(selection === 'all'));
    rendered.el
      .querySelectorAll<HTMLElement>('[data-media-message-id]')
      .forEach((cell) => {
        const memberId = Number(cell.dataset['mediaMessageId']);
        cell.classList.toggle(
          'msg-media-cell--selected',
          this.selectionMode() && this.selectedMessageIds().has(memberId),
        );
      });
    return rendered;
  }

  private onMessageInteraction(
    event: 'activate' | 'contextmenu',
    item: CbItem<ChatItemData>,
    pointer?: { x: number; y: number },
    memberId?: number,
  ): void {
    if (event === 'contextmenu' && this.inputDevice.hasPhysicalKeyboard()) {
      const menuWidth = 192;
      const menuHeight = 132;
      const viewportInset = 8;
      this.messageContextMenu.set({
        item,
        x: Math.max(
          viewportInset,
          Math.min(
            pointer?.x ?? viewportInset,
            window.innerWidth - menuWidth - viewportInset,
          ),
        ),
        y: Math.max(
          viewportInset,
          Math.min(
            pointer?.y ?? viewportInset,
            window.innerHeight - menuHeight - viewportInset,
          ),
        ),
      });
      this.syncMountedSelectionState();
      return;
    }
    this.messageContextMenu.set(null);
    if (!this.selectionMode()) this.selectionMode.set(true);
    if (memberId !== undefined) this.toggleAlbumMemberSelection(item, memberId);
    else this.toggleMessageSelection(item);
  }

  selectContextMessage(): void {
    const context = this.messageContextMenu();
    if (!context) return;
    this.messageContextMenu.set(null);
    this.selectionMode.set(true);
    if (this.messageSelectionState(context.item) !== 'all')
      this.toggleMessageSelection(context.item);
  }

  dismissContextMenu(): void {
    this.messageContextMenu.set(null);
    this.syncMountedSelectionState();
  }

  async copyContextMessage(): Promise<void> {
    const context = this.messageContextMenu();
    if (!context) return;
    this.messageContextMenu.set(null);
    await this.writeMessageClipboard(
      messageCopyBody(context.item.data, this.messageCopyLabels()),
      1,
      false,
    );
  }

  async copySelectedMessages(): Promise<void> {
    const messages = [...this.selectedMessageIds()]
      .map((id) => this.selectedMessageItems.get(id)?.data)
      .filter((message): message is ChatMsgData => message !== undefined);
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
      invite: this.transloco.translate('chat.preview.invite'),
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

  exitSelectionMode(): void {
    this.selectionMode.set(false);
    this.selectedMessageIds.set(new Set());
    this.selectedMessageItems.clear();
    this.syncMountedSelectionState();
  }

  private toggleMessageSelection(item: CbItem<ChatItemData>): void {
    const memberIds = this.messageMemberIds(item);
    const next = new Set(this.selectedMessageIds());
    const remove = memberIds.every((id) => next.has(id));
    for (const id of memberIds) {
      if (remove) {
        next.delete(id);
        this.selectedMessageItems.delete(id);
      } else {
        next.add(id);
        this.selectedMessageItems.set(id, this.albumMemberItem(item, id));
      }
    }
    this.selectedMessageIds.set(next);
    this.syncMountedSelectionState();
  }

  private toggleAlbumMemberSelection(
    item: CbItem<ChatItemData>,
    memberId: number,
  ): void {
    if (!this.messageMemberIds(item).includes(memberId)) return;
    const next = new Set(this.selectedMessageIds());
    if (next.has(memberId)) {
      next.delete(memberId);
      this.selectedMessageItems.delete(memberId);
    } else {
      next.add(memberId);
      this.selectedMessageItems.set(
        memberId,
        this.albumMemberItem(item, memberId),
      );
    }
    this.selectedMessageIds.set(next);
    this.syncMountedSelectionState();
  }

  private messageMemberIds(item: CbItem<ChatItemData>): number[] {
    if ((item.ids?.length ?? 0) > 1) return [...item.ids!];
    return [item.id];
  }

  private messageSelectionState(
    item: CbItem<ChatItemData>,
  ): 'none' | 'some' | 'all' {
    const ids = this.messageMemberIds(item);
    const count = ids.filter((id) => this.selectedMessageIds().has(id)).length;
    return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
  }

  private albumMemberItem(
    item: CbItem<ChatItemData>,
    memberId: number,
  ): CbItem<ChatItemData> {
    if ((item.ids?.length ?? 0) < 2) return item;
    const media = item.data.images?.find((entry) => entry.msgId === memberId);
    return {
      ...item,
      id: memberId,
      ids: undefined,
      data: {
        ...item.data,
        msgId: memberId,
        images: media ? [media] : item.data.images,
      },
    };
  }

  openContextForwardDialog(): void {
    const context = this.messageContextMenu();
    if (!context) return;
    this.messageContextMenu.set(null);
    this.openForwardDialog([context.item]);
  }

  openSelectedForwardDialog(): void {
    const items = [...this.selectedMessageIds()]
      .map((id) => this.selectedMessageItems.get(id))
      .filter((item): item is CbItem<ChatItemData> => item !== undefined);
    if (items.length) this.openForwardDialog(items);
  }

  private openForwardDialog(items: readonly CbItem<ChatItemData>[]): void {
    const messages = items
      .slice()
      .sort((a, b) => a.data.createdAtMs - b.data.createdAtMs)
      .map(
        (item): ForwardMessageItem => ({
          id: item.id,
          name: item.data.name,
          summary: this.forwardSummary(item.data),
          original: item.data,
        }),
      );
    const source = this.convList
      .items()
      .find((thread) => thread.threadId === this.threadId());
    const sourceThreadId = this.threadId();
    if (!sourceThreadId) return;
    this.route.popupDlg(
      PopupType.FORWARD,
      {
        messages,
        recordKind: source?.type === 'GROUP' ? 'group' : 'chat',
      },
      (result) => {
        if (result) void this.sendForward(result, sourceThreadId);
      },
    );
  }

  private async sendForward(
    result: ForwardDialogResult,
    sourceThreadId: number,
  ): Promise<void> {
    const sourceMessages = result.messages.map((message) => ({
      threadId: sourceThreadId,
      seq: message.id,
    }));
    const outcomes = await Promise.all(
      result.threadIds.map(
        async (
          threadId,
        ): Promise<{
          ok: boolean;
          response?: StandardResponse<unknown>;
        }> => {
          try {
            const response = await firstValueFrom(
              this.msgService.sendForward({
                threadId,
                sourceMessages,
                clientMessageId: this.newClientMessageId(),
              }),
            );
            return { ok: response.code === 0, response };
          } catch {
            return { ok: false };
          }
        },
      ),
    );
    const sent = outcomes.filter((outcome) => outcome.ok).length;
    if (sent === outcomes.length) {
      this.toast.info(
        this.transloco.translate('forward.sent', { count: sent }),
      );
      this.exitSelectionMode();
      return;
    }
    if (sent > 0) {
      this.toast.warn(
        this.transloco.translate('forward.partiallySent', {
          sent,
          total: outcomes.length,
        }),
      );
      this.exitSelectionMode();
      return;
    }
    const businessFailure = outcomes.find(
      (outcome) => outcome.response,
    )?.response;
    this.toast.warn(
      businessFailure
        ? translateBizResult(businessFailure, this.transloco)
        : this.transloco.translate('forward.sendFailed'),
    );
  }

  private forwardSummary(message: ChatMsgData): string {
    if (message.contentType === 'PURE_TEXT' || message.contentType === 'LINK')
      return (
        message.text.trim() || this.transloco.translate('forward.emptyMessage')
      );
    if (message.contentType === 'FILE')
      return (
        message.file?.name || this.transloco.translate('chat.preview.file')
      );
    const keys: Partial<Record<ChatMsgData['contentType'], string>> = {
      IMAGE: 'chat.preview.photo',
      VIDEO: 'chat.preview.video',
      AUDIO: 'chat.preview.voice',
      INVITE: 'chat.preview.invite',
      CALL: 'forward.call',
    };
    return this.transloco.translate(
      keys[message.contentType] ?? 'forward.message',
    );
  }

  private syncMountedSelectionState(): void {
    const active = this.selectionMode();
    const selected = this.selectedMessageIds();
    const contextId = this.messageContextMenu()?.item.id;
    this.contentRef()
      ?.nativeElement.querySelectorAll<HTMLElement>('[data-message-id]')
      .forEach((host) => {
        const id = Number(host.dataset['messageId']);
        const memberIds = (host.dataset['messageMemberIds'] ?? String(id))
          .split(',')
          .map(Number)
          .filter(Number.isFinite);
        const selectedMembers = memberIds.filter((memberId) =>
          selected.has(memberId),
        ).length;
        const state =
          selectedMembers === 0
            ? 'none'
            : selectedMembers === memberIds.length
              ? 'all'
              : 'some';
        host.classList.toggle('cb-message--selection-mode', active);
        host.classList.toggle(
          'cb-message--selected',
          active && state === 'all',
        );
        host.classList.toggle(
          'cb-message--partially-selected',
          active && state === 'some',
        );
        host.classList.toggle('cb-message--context-active', id === contextId);
        host.setAttribute('aria-selected', String(active && state === 'all'));
        host
          .querySelectorAll<HTMLElement>('[data-media-message-id]')
          .forEach((cell) => {
            const memberId = Number(cell.dataset['mediaMessageId']);
            cell.classList.toggle(
              'msg-media-cell--selected',
              active && selected.has(memberId),
            );
          });
      });
  }

  private onScroll(info: CbScrollInfo): void {
    // Drain optimistic sends queued while the newer end was trimmed: noNewer means the mounted tail IS the
    // global newest, so tailAnchorId() is now a safe anchor. Runs before the UI updates below for promptness.
    if (info.noNewer && this.pendingOptimistic.length > 0) {
      const queue = this.pendingOptimistic;
      this.pendingOptimistic = [];
      for (const item of queue) this.insertMsg(this.tailAnchorId(), item);
    }
    const atVisibleBottom = isMessageViewportAtBottom(info);
    this.atBottom.set(atVisibleBottom);
    if (atVisibleBottom) this.newMessageCount.set(0);
    this.mountedMessageCount.set(info.mounted);
    this.updateStickyDate();
    this.probe.schedule(this.threadId() ?? 0);
    this.updateUnreadBoundaryPosition(info);
    this.stableRead.noteScroll();
  }

  private updateUnreadBoundaryPosition(info: CbScrollInfo): void {
    const target = this.firstUnreadSeq;
    const viewport = this.viewportRef()?.nativeElement;
    if (target === null || !viewport) {
      this.unreadBoundaryAbove.set(false);
      return;
    }
    const divider =
      this.contentRef()?.nativeElement.querySelector<HTMLElement>(
        '.cb-unread-divider',
      );
    if (divider) {
      this.unreadBoundaryAbove.set(
        divider.getBoundingClientRect().bottom <
          viewport.getBoundingClientRect().top + 8,
      );
      return;
    }
    this.unreadBoundaryAbove.set(
      info.oldestId !== null && info.oldestId > target,
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

  /** Telegram-style sticky date overlay: the text of the last date-separator row at/above the VISIBLE top.
   *  The visible top is the header's bottom edge (stable — the header does NOT carry the keyboard-lift
   *  transform), NOT the viewport's `getBoundingClientRect().top` (which slides under the header while the
   *  keyboard is up, so it would pick the date of a message now hidden behind the header). Falls back to
   *  the viewport top before the header ref is available (early init). The pick is the pure
   *  {@link pickStickyDateLabel} helper so the logic is unit-tested. */
  private updateStickyDate(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) {
      this.stickyDate.set(null);
      return;
    }
    const visibleTop =
      this.headerRef()?.nativeElement.getBoundingClientRect().bottom ??
      vp.getBoundingClientRect().top;
    const unreadDivider = ct.querySelector<HTMLElement>('.cb-unread-divider');
    if (
      unreadDividerOverlapsStickyDate(
        unreadDivider?.getBoundingClientRect() ?? null,
        visibleTop,
      )
    ) {
      this.stickyDate.set(null);
      return;
    }
    const rows = Array.from(ct.querySelectorAll<HTMLElement>('.msg-date')).map(
      (d) => ({
        top: d.getBoundingClientRect().top,
        label: d.textContent?.trim() ?? null,
      }),
    );
    this.stickyDate.set(pickStickyDateLabel(rows, visibleTop, 14));
  }

  /** Recompute the sticky-date pill when the keyboard-lift `transform` settles on the viewport. The
   *  transform fires no scroll event, so `onScroll` alone would leave the pill on its pre-lift label across
   *  a keyboard open/close; this closes that gap. {@link isViewportTransformEnd} filters to the viewport's
   *  own `transform` (ignoring bubbled item transitions like `cb-move`). */
  onViewportTransitionEnd(event: TransitionEvent): void {
    if (!isViewportTransformEnd(event, this.viewportRef()?.nativeElement))
      return;
    this.updateStickyDate();
  }

  scrollToLatest(): void {
    this.scroller?.scrollToBottom();
  }

  scrollToUnread(): void {
    if (this.firstUnreadSeq !== null)
      this.scroller?.scrollToIndex(this.firstUnreadSeq, 'top', true);
  }

  openUploadDetails(): void {
    this.route.popupDlg(PopupType.UPLOAD_DETAIL, {
      threadId: this.threadId(),
    });
  }

  cancelUploadingTransfers(): void {
    for (const task of this.uploadingTransfers()) {
      this.transfers.discard(task.clientMessageId);
    }
  }

  retryFailedTransfers(): void {
    for (const task of this.retryableFailedTransfers()) {
      this.transfers.retry(task.clientMessageId);
    }
  }

  cancelFailedTransfers(): void {
    for (const task of this.failedTransfers()) {
      this.transfers.discard(task.clientMessageId);
    }
  }

  // ---------- ChatInputComponent intent → optimistic dispatch ----------

  /** The composer emits one structured intent; route it to the matching optimistic-send path. */
  onSendIntent(intent: ChatSendIntent): void {
    switch (intent.kind) {
      case 'text':
        this.sendText(intent.text);
        return;
      case 'image':
        void this.sendAttachments(
          Array.from(intent.files).filter((file) =>
            file.type.startsWith('image/'),
          ),
        );
        return;
      case 'file':
        void this.sendAttachments(intent.files);
        return;
      case 'native-files':
        void this.sendNativeAttachments(intent.files);
        return;
      case 'link':
        this.sendLink(intent.url);
        return;
      case 'paste':
        void this.sendPaste(intent.files, intent.text);
        return;
      case 'audio':
        this.sendVoice(intent.blob, intent.duration, intent.mimeType);
        return;
    }
  }

  private sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const cid = this.newClientMessageId();
    const item = this.makeOptimisticItem(
      cid,
      toDisplayText(trimmed),
      'PURE_TEXT',
      null,
      null,
    );
    item.data.wireText = trimmed;
    const rendered = toRenderMessageEntities(
      trimmed,
      this.userService.sessionProfile()?.account,
    );
    item.data.textSegments = rendered.segments;
    item.data.mentionState = rendered.mentionState;
    this.dispatchPending(item);
    this.dispatchHttpSendText(item);
  }

  /** Send a bare URL as a LINK card. The optimistic item carries a bare `{ url }` card (rendered at
   *  once); the server rebuilds it with OG metadata + a localized og:image, and the NEW_MESSAGE echo
   *  (matched by clientMessageId) reconciles the bare card → rich card. The wire `content` is the bare
   *  URL — the server is authoritative for the card body. */
  private sendLink(url: string): void {
    if (!this.threadId()) return;
    const cid = this.newClientMessageId();
    const item = this.makeOptimisticItem(
      cid,
      JSON.stringify({ url }),
      'LINK',
      null,
      null,
    );
    this.dispatchPending(item);
    this.dispatchHttpSendLink(item, url);
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
      if (file.type.startsWith('image/'))
        return {
          file,
          cid,
          kind: 'image',
          probeMeta: () => readImageDims(file),
        };
      if (file.type.startsWith('video/'))
        return {
          file,
          cid,
          kind: 'video',
          probeMeta: () => readVideoMeta(file),
        };
      return { file, cid, kind: 'file', probeMeta: null };
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
        this.uploadAndSendImage(entry.cid, entry.file, item, meta, retry, true),
      );
    }
    if (entry.kind === 'video') {
      const meta = await entry.probeMeta();
      return this.enqueueAttachmentUpload(entry.cid, () =>
        this.uploadAndSendVideo(entry.cid, entry.file, item, meta, retry, true),
      );
    }
    return this.enqueueAttachmentUpload(entry.cid, () =>
      this.uploadAndSendFile(entry.cid, entry.file, item, retry, true),
    );
  }

  private async sendNativeAttachments(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    if (!this.threadId()) return;
    const pendingUploads: Array<{
      file: NativeUploadSelection;
      cid: string;
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
      this.sendOutbox.retainResource(cid, {
        type: 'native-attachment',
        selection: file,
        release: () => this.nativeUploads.release(file.uploadId),
        discard: () => this.nativeUploads.discard(file.uploadId),
      });
      this.registerPending(item);
      pendingUploads.push({ file, cid, item });
    }
    // Mirror the browser-file path: every pending row uses the common insertion/pinning flow
    // before transfer-state updates begin.
    for (const { file, cid, item } of pendingUploads) {
      void this.queueNativeUpload(cid, file, item);
    }
  }

  private queueNativeUpload(
    cid: string,
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
      void this.queueNativeUpload(cid, file, item, true);
    });
    this.transfers.registerCancel(cid, () => {
      this.nativeUploads.cancel(file.uploadId);
    });
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendNative(cid, file, item, retry),
    );
  }

  private async uploadAndSendNative(
    cid: string,
    file: NativeUploadSelection,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    try {
      const contentType =
        file.kind === 'image'
          ? 'IMAGE'
          : file.kind === 'video'
            ? 'VIDEO'
            : 'FILE';
      const staged = await firstValueFrom(
        this.msgService
          .sendMedia({
            threadId: tid,
            contentType,
            clientMessageId: cid,
            meta:
              file.kind === 'video'
                ? { w: file.w, h: file.h, duration: file.duration }
                : undefined,
            retry,
          })
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.surfaceSendQuota(staged);
        throw new Error(staged.message);
      }
      const response = await this.nativeUploads.upload<
        StandardResponse<unknown>
      >(
        file,
        cid,
        file.kind === 'image' ? { w: String(file.w), h: String(file.h) } : {},
        (loaded, total) => this.transfers.progress(cid, loaded, total),
      );
      if (response.code !== 0) {
        this.surfaceSendQuota(response);
        throw new Error(response.message);
      }
      this.transfers.complete(cid);
      await this.markSent(item);
    } catch (error) {
      if (error instanceof NativeUploadError && error.code !== undefined) {
        this.surfaceSendQuota({
          code: error.code,
          message: error.message,
          data:
            error.retryAfter === undefined
              ? undefined
              : { retryAfter: error.retryAfter },
        });
      }
      if (this.debugTools.enabled()) {
        console.error(
          '[upload] native send failed',
          JSON.stringify({
            clientMessageId: cid,
            uploadId: file.uploadId,
            kind: file.kind,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      const reason =
        error instanceof Error && error.message
          ? error.message
          : this.transloco.translate('transfer.uploadFailed');
      this.transfers.fail(cid, reason);
      this.toast.warn(reason, { duration: 6000 });
      await this.failPending(item);
    }
  }

  /** Confirmed paste-panel contents are still ordinary independent messages. Send attachments in panel
   *  order, then the optional text message; no batch identifier or compound-message protocol is involved. */
  private async sendPaste(files: readonly File[], text: string): Promise<void> {
    await this.sendAttachments(files, true);
    if (text) this.sendText(text);
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
    this.sendOutbox.retainResource(cid, {
      type: 'voice',
      file: f,
      duration,
      previewUrl: preview,
    });
    this.dispatchPending(item);
    void this.uploadAndSendAudio(cid, f, item, { duration });
  }

  private dispatchHttpSendText(item: CbItem<ChatItemData>): void {
    const cid = item.clientMessageId!;
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    firstValueFrom(
      this.msgService.sendMessage({
        threadId: tid,
        content: item.data.wireText ?? item.data.text,
        contentType: 'PURE_TEXT',
        clientMessageId: cid,
      }),
    )
      .then((res) => {
        if (res.code !== 0) {
          this.surfaceSendQuota(res);
          void this.failPending(item);
        } else void this.markSent(item); // 200 → spinner→check now, decoupled from the later SSE reorder
      })
      .catch(() => void this.failPending(item));
  }

  /** LINK send: the wire content is the bare URL (the server builds the card). Same reconcile contract
   *  as text — 200 → spinner→check; the SSE echo swaps the bare optimistic card for the server-built one. */
  private dispatchHttpSendLink(item: CbItem<ChatItemData>, url: string): void {
    const cid = item.clientMessageId!;
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    firstValueFrom(
      this.msgService.sendMessage({
        threadId: tid,
        content: url,
        contentType: 'LINK',
        clientMessageId: cid,
      }),
    )
      .then((res) => {
        if (res.code !== 0) {
          this.surfaceSendQuota(res);
          void this.failPending(item);
        } else void this.markSent(item);
      })
      .catch(() => void this.failPending(item));
  }

  /** Daily quota failures are business responses (HTTP 200), so the HTTP error interceptor never sees
   * them. Keep the failed bubble/retry affordance and also explain why retrying today cannot succeed. */
  private surfaceSendQuota(res: StandardResponse<unknown>): void {
    if (
      res.code === BusinessCode.QUOTA_EXCEEDED ||
      res.code === BusinessCode.FEDERATION_QUOTA_EXCEEDED
    ) {
      this.toast.warn(translateBizResult(res, this.transloco));
    }
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
    file: File,
    item: CbItem<ChatItemData>,
    dims: { w: number; h: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'image', file, () =>
      this.queueImageUpload(cid, file, item, dims, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendImage(cid, file, item, dims, retry, true),
    );
  }

  private queueFileUpload(
    cid: string,
    file: File,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'file', file, () =>
      this.queueFileUpload(cid, file, item, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendFile(cid, file, item, retry, true),
    );
  }

  private queueVideoUpload(
    cid: string,
    file: File,
    item: CbItem<ChatItemData>,
    meta: { w: number; h: number; duration: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return Promise.resolve();
    this.trackTransfer(cid, tid, 'video', file, () =>
      this.queueVideoUpload(cid, file, item, meta, true),
    );
    return this.enqueueAttachmentUpload(cid, () =>
      this.uploadAndSendVideo(cid, file, item, meta, retry, true),
    );
  }

  /** Send-media-first flow: POST /send-media stages a PendingMedia (durable intent, keyed by cid),
   *  then the upload (carrying the same cid via the x-client-message-id header) writes the file and the
   *  server promotes the stage to a real Message. The NEW_MESSAGE SSE echo (matched by cid) reconciles
   *  the optimistic bubble — so on upload success there is nothing to do here. Any failure → failPending. */
  private async uploadAndSendImage(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    dims: { w: number; h: number },
    retry = false,
    tracked = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    if (!tracked)
      this.trackTransfer(cid, tid, 'image', f, () =>
        this.queueImageUpload(cid, f, item, dims, true),
      );
    if (await this.rejectOversizedUpload(cid, item, f, 10)) return;
    try {
      const staged = await firstValueFrom(
        this.msgService
          .sendMedia({
            threadId: tid,
            contentType: 'IMAGE',
            clientMessageId: cid,
            retry,
          })
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.surfaceSendQuota(staged);
        this.transfers.fail(cid, translateBizResult(staged, this.transloco));
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService
          .uploadMedia(f, dims.w, dims.h, cid, (loaded, total) =>
            this.transfers.progress(cid, loaded, total),
          )
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0) {
        this.surfaceSendQuota(up);
        this.transfers.fail(cid, translateBizResult(up, this.transloco));
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch (error) {
      this.transfers.fail(cid, this.uploadFailureReason(error));
      await this.failPending(item);
    }
  }

  private async uploadAndSendFile(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    retry = false,
    tracked = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    if (!tracked)
      this.trackTransfer(cid, tid, 'file', f, () =>
        this.queueFileUpload(cid, f, item, true),
      );
    if (await this.rejectOversizedUpload(cid, item, f, 50)) return;
    try {
      const staged = await firstValueFrom(
        this.msgService
          .sendMedia({
            threadId: tid,
            contentType: 'FILE',
            clientMessageId: cid,
            retry,
          })
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.surfaceSendQuota(staged);
        this.transfers.fail(cid, translateBizResult(staged, this.transloco));
        await this.failPending(item);
        return;
      }
      const ok = await this.uploadFileResult(f, cid);
      if (!ok) {
        this.transfers.fail(
          cid,
          this.transloco.translate('transfer.uploadFailed'),
        );
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch (error) {
      this.transfers.fail(cid, this.uploadFailureReason(error));
      await this.failPending(item);
    }
  }

  private async uploadAndSendVideo(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    meta: { w: number; h: number; duration: number },
    retry = false,
    tracked = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    if (!tracked)
      this.trackTransfer(cid, tid, 'video', f, () =>
        this.queueVideoUpload(cid, f, item, meta, true),
      );
    if (await this.rejectOversizedUpload(cid, item, f, 100)) return;
    try {
      const staged = await firstValueFrom(
        this.msgService
          .sendMedia({
            threadId: tid,
            contentType: 'VIDEO',
            clientMessageId: cid,
            meta: { w: meta.w, h: meta.h, duration: meta.duration },
            retry,
          })
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.surfaceSendQuota(staged);
        this.transfers.fail(cid, translateBizResult(staged, this.transloco));
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService
          .uploadVideo(f, cid, (loaded, total) =>
            this.transfers.progress(cid, loaded, total),
          )
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0) {
        this.surfaceSendQuota(up);
        this.transfers.fail(cid, translateBizResult(up, this.transloco));
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch (error) {
      this.transfers.fail(cid, this.uploadFailureReason(error));
      await this.failPending(item);
    }
  }

  private async uploadAndSendAudio(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    meta: { duration: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    this.trackTransfer(cid, tid, 'audio', f, () =>
      this.uploadAndSendAudio(cid, f, item, meta, true),
    );
    if (await this.rejectOversizedUpload(cid, item, f, 50)) return;
    try {
      const staged = await firstValueFrom(
        this.msgService
          .sendMedia({
            threadId: tid,
            contentType: 'AUDIO',
            clientMessageId: cid,
            meta: { duration: meta.duration },
            retry,
          })
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.surfaceSendQuota(staged);
        this.transfers.fail(cid, translateBizResult(staged, this.transloco));
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService
          .uploadAudio(f, cid, (loaded, total) =>
            this.transfers.progress(cid, loaded, total),
          )
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0 || up.data?.promoted !== true) {
        if (up.code !== 0) this.surfaceSendQuota(up);
        this.transfers.fail(
          cid,
          up.code !== 0
            ? translateBizResult(up, this.transloco)
            : this.transloco.translate('transfer.uploadFailed'),
        );
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch (error) {
      this.transfers.fail(cid, this.uploadFailureReason(error));
      await this.failPending(item);
    }
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

  private uploadFailureReason(error: unknown): string {
    return error instanceof Error && error.message
      ? error.message
      : this.transloco.translate('transfer.uploadFailed');
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
  private async uploadFileResult(
    f: File,
    cid: string,
  ): Promise<{
    url: string;
    name: string;
    size: number;
    mimeType: string;
  } | null> {
    try {
      // Both upload paths report bytes through the callback but still reduce to the same final
      // {code,message,data} envelope here.
      const up = await firstValueFrom(
        this.msgService
          .uploadFile(f, cid, (loaded, total) =>
            this.transfers.progress(cid, loaded, total),
          )
          .pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      return up.data ?? null;
    } catch {
      return null;
    }
  }

  /** Retry a failed send (the row's retry output → createMsgCbElement onRetry → here, with msgId = clientMessageId).
   *  Flip the SAME entry back to 'sending' (stable identity, in-place morph), then replay the send. The idempotent
   *  retry re-fans NEW_MESSAGE to the sender, so the SSE echo reconciles the bubble normally. */
  async retrySend(clientMessageId: string): Promise<void> {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source) return;
    const item = source.retryPending(clientMessageId);
    if (!item) return;
    await scroller.reconcilePending(); // morph failed→sending in place
    const resource = this.sendOutbox.resource(clientMessageId);
    if (resource?.type === 'voice') {
      void this.uploadAndSendAudio(
        clientMessageId,
        resource.file,
        item,
        { duration: resource.duration },
        true,
      );
      return;
    }
    if (resource) {
      if (resource.type === 'native-attachment') {
        void this.queueNativeUpload(
          clientMessageId,
          resource.selection,
          item,
          true,
        );
        return;
      }
      // Replay the original attachment send path.
      switch (resource.mediaKind) {
        case 'image':
          void this.queueImageUpload(
            clientMessageId,
            resource.file,
            item,
            await readImageDims(resource.file),
            true,
          );
          break;
        case 'video':
          void this.queueVideoUpload(
            clientMessageId,
            resource.file,
            item,
            await readVideoMeta(resource.file),
            true,
          );
          break;
        default:
          void this.queueFileUpload(clientMessageId, resource.file, item, true);
          break;
      }
    } else {
      this.dispatchHttpSendText(item);
    }
  }

  private async cancelPending(clientMessageId: string): Promise<void> {
    const source = this.source;
    const scroller = this.scroller;
    if (!source || !scroller) return;
    const item = source.pendingByClientMessageId(clientMessageId);
    if (!item || !source.discardPending(clientMessageId)) return;
    this.transfers.discard(clientMessageId);
    scroller.removeItem(item.id);
  }

  /** Mark an optimistic send FAILED: the source flips its pending entry to status:'failed' (stable identity);
   *  the kernel's reconcilePending morphs the bubble in place (sending→failed) + FLIPs it to the tail. Self-heals
   *  the lost-HTTP-response race: if the SSE echo already dropped the pending entry, failPending finds nothing. */
  private async failPending(item: CbItem<ChatItemData>): Promise<void> {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source || item.clientMessageId === undefined) return;
    if (!source.failPending(item.clientMessageId)) return; // already confirmed/dropped — nothing to fail
    await scroller.reconcilePending();
  }

  /** Mark an optimistic send SENT (the HTTP-200 / upload-success milestone): the source flips its pending entry to
   *  status:'sent' in place (stable identity, stays at its tail position); the kernel's confirmPending morphs the
   *  bubble in place (sending→sent) + tags cb-confirmed so the spinner→check→fade choreography plays WITHOUT touching
   *  the reorder animation (owned by the later SSE echo). Self-heals the SSE-beats-HTTP race: if the echo already
   *  dropped the pending entry, markPendingSent returns false and confirmPending is skipped — the real carries the
   *  choreography instead. */
  private async markSent(item: CbItem<ChatMsgData>): Promise<void> {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source || item.clientMessageId === undefined) return;
    if (!source.markPendingSent(item.clientMessageId)) return; // already confirmed/dropped — the real owns the choreography
    scroller.confirmPending(item.clientMessageId);
  }

  // ---------- optimistic-insert orchestration (ported from the playground) ----------

  /** Route an optimistic send so it anchors on the GLOBAL newest only once that end is mounted. When pinned
   *  (noNewer, the common case) this is synchronous. When the newer end is trimmed (scrolled into history),
   *  queue the item and scrollToBottom() — the follow chain mounts the newest and onScroll drains the queue. */
  private dispatchPending(item: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller) return;
    if (scroller.getInfo().noNewer) {
      this.insertMsg(this.tailAnchorId(), item);
    } else {
      this.pendingOptimistic.push(item);
      scroller.scrollToBottom();
    }
  }

  /** Keep an attachment send in the source outbox for retry/SSE reconciliation without mounting a
   * second per-file optimistic bubble. The aggregate transfer card is the sole pending presentation. */
  private registerPending(item: CbItem<ChatItemData>): void {
    this.source?.addPending(item);
  }

  /** Register the optimistic item with the source pending area + mount it after the tail (insertAfter, optimistic)
   *  + pin to reveal it. No confirm timer — confirmation is the SSE echo.
   *  NB: do NOT bail on an empty `afterId`. The FIRST send into an EMPTY thread has tailAnchorId()===-1 (nothing is
   *  mounted → newestId is null); the kernel's insertAfter treats an empty window as "insert as the sole entry", so
   *  bailing here would silently swallow the first message of a fresh conversation — no pending bubble ever appears.
   *  (Mirrors the playground insertMsg, whose comment calls out this exact case.) */
  private insertMsg(afterId: number, item: CbItem<ChatItemData>): boolean {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source) return false;
    source.addPending(item);
    const ok = scroller.insertAfter(afterId, item, { optimistic: true });
    if (ok) scroller.scrollToBottom(); // insertAfter is viewport-stable; a send always means "show my message"
    return ok;
  }

  /** The id to anchor a newest-end insert after: the current tail (a prior pending, or the real newest). -1 if empty
   *  (the kernel's insertAfter ignores afterId when the window is empty, so the sentinel never reaches indexOfId). */
  private tailAnchorId(): number {
    const id = this.scroller?.getInfo().newestId ?? null;
    return id != null ? id : -1;
  }

  /** Build a fully-shaped optimistic self message. id/msgId = a synthetic NEGATIVE placeholder (msgId is a number
   *  now, so the in-flight bubble cannot carry the clientMessageId as its id); the client tracks the bubble by the
   *  separate clientMessageId (the kernel's reconcile key) until the server echo arrives. Negative ids never collide
   *  with server-assigned seqs (always positive). status:'sending', kind:'pending'. Any album cell's msgId is stamped
   *  to the same placeholder so the dev-badge range stays self-consistent before the real lands. */
  private makeOptimisticItem(
    clientMessageId: string,
    text: string,
    contentType: ChatMsgData['contentType'],
    images: AlbumImage[] | null,
    file: FileInfo | null,
  ): CbItem<ChatItemData> {
    const profile = this.userService.sessionProfile();
    const now = new Date();
    const placeholderId = this.sendOutbox.allocatePlaceholderId();
    const stampedImages =
      images?.map((im) => ({ ...im, msgId: placeholderId })) ?? null;
    const data: ChatMsgData = {
      type: 'msg',
      msgId: placeholderId,
      creator: profile?.id ?? 0,
      isSelf: true,
      name: profile?.name ?? 'Me',
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType,
      images: stampedImages,
      file,
      createdAtMs: now.getTime(),
      status: 'sending',
      kind: 'pending',
    };
    return { id: placeholderId, data, clientMessageId };
  }

  private newClientMessageId(): string {
    // Always a spec-compliant UUID — the backend validates clientMessageId as a UUID. lib/uuid falls back to
    // crypto.getRandomValues (not secure-context-gated, unlike randomUUID) so this works on http non-localhost origins.
    return uuid();
  }

  private teardown(): void {
    this.selectionMode.set(false);
    this.selectedMessageIds.set(new Set());
    this.messageContextMenu.set(null);
    this.stableRead.reset();
    this.firstUnreadSeq = null;
    this.unreadBoundaryAbove.set(false);
    this.probe.destroy();
    this.mountedMessageCount.set(0);
    this.atBottom.set(true);
    this.newMessageCount.set(0);
    this.scroller?.destroy(); // destroy() also calls source.destroy() (unsubscribes SSE)
    this.scroller = undefined;
    this.source = undefined;
    this.kernelReady = false;
    // (In-chat search visibility lives on NavStateMachineService now — cleared by openChat/closeChat on
    // thread switch / going home — so no per-pane reset is needed here.)
    this.pendingOptimistic = [];
  }

  /** Tear down the kernel + source but keep the COMPONENT instance alive. The A/B buffer host demotes a pane
   *  to background and idles its kernel here (bounding memory + SSE to one warm pane). Resets `currentTrdId`
   *  so the pane is COLD — a subsequent re-selection of this thread drives {@link reset} to re-initialize
   *  via {@link reinit}; idempotent. */
  teardownKernel(): void {
    this.teardown();
    this.currentTrdId = null;
  }

  /** Force an in-place re-init for the current bound thread (teardown + rebuild), emitting `ready` when the
   *  fresh kernel settles. The constructor init effect does NOT re-fire here (its deps — viewport/content/
   *  userMsgTrd — are unchanged), so this is the sole re-init path when the data beneath a pane changes
   *  (clear-history) or when a resident pane is cold ({@link reset}). */
  private reinit(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    const trd = this.userMsgTrd();
    if (!vp || !ct || !trd) return;
    this.teardown();
    this.currentTrdId = null;
    this.initScroller(vp, ct, trd);
    this.currentTrdId = trd.id;
  }

  /** Whether the kernel is live for the currently-bound thread (init settled AND not since idled). The A/B
   *  host's fg-resident branch reads this so it only re-inits a genuinely COLD pane (re-open after a close)
   *  and skips a spurious reset on an already-warm one — which matters because every `promote()` flips
   *  `fgSlot` and re-triggers the coordinator, so without this guard a warm pane would be reset on every
   *  switch. A plain method (not a signal): a synchronous snapshot read, intentionally untracked. */
  isWarm(): boolean {
    const trd = this.userMsgTrd();
    return !!trd && this.kernelReady && this.currentTrdId === trd.id;
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
    if (this.kernelReady && this.currentTrdId === trd.id) {
      queueMicrotask(() => this.ready.emit(trd.threadId));
      return;
    }
    this.reinit();
  }

  // ---------- chat header MORE-menu integration ----------

  /** Jump the kernel to a search match seq (from the search bar's prev/next). The kernel re-seeds around
   *  an unmounted seq and flashes the row via the existing highlight path. */
  onSearchJump(id: number): void {
    this.scroller?.scrollToIndex(id, 'center', true);
  }

  /** Clear-history landed on the server: the now-empty view (filtered by the caller's clearedAt watermark)
   *  must reload from scratch. Data changed beneath a possibly-warm pane, so force a re-init regardless of
   *  warmth ({@link reinit}, not {@link reset}). */
  async onHistoryCleared(): Promise<void> {
    const threadId = this.threadId();
    if (threadId !== undefined) {
      // Clear-for-me is a server-side watermark, not a Message delete. Purge the local mirror before
      // re-init so cache-first startup cannot briefly remount pre-watermark rows while THREAD_META is
      // still propagating the new clearedAt into the conversation item.
      await this.msgRepo.deleteByThread(threadId);
    }
    this.reinit();
  }

  /** Unblock the P2P peer from the blocked banner (mirrors the header menu's unblock path). */
  unblockPeer(): void {
    const trd = this.userMsgTrd();
    const peerId = trd?.peerUser?.id;
    if (peerId === undefined) return;
    this.userService
      .setBlock({ userId: peerId, block: false })
      .subscribe((res) => {
        if (res.code === 0)
          this.convList.applyThreadMeta(trd!.threadId, { blocked: false });
      });
  }

  ngOnDestroy(): void {
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
