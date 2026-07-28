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
import { TranslocoModule } from '@jsverse/transloco';
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
} from '../../lib/sticky-date';
import { HttpItemSource } from './http-item-source';
import { MediaProbeScheduler } from './media-probe-scheduler';
import {
  createMsgCbElement,
  createGhostCbElement,
  computeRowFlags,
} from '../message-cards/create-item';
import { VOICE_BAR_W, VOICE_BAR_H } from '../message-cards/media-row/layout';
import { mergeAlbumItems, absorbAlbumTail } from '../message-cards/merge-items';
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
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
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
import { StickyDateOverlayComponent } from '../message-cards/sticky-date-overlay/sticky-date-overlay.component';
import { uuid } from '../../lib/uuid';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { LayoutService } from '../../services/layout.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { FileDetailService } from '../file-detail-viewer/file-detail-viewer.service';
import { displayThreadName, type ConversationItem, type StandardResponse } from '../../services/model';
import { isMessageViewportAtBottom } from './message-scroll-state';
import {
  MediaTransferService,
  type MediaTransferKind,
} from '../../services/media-transfer.service';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';

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

  /** Emits the threadId once the kernel finishes `init()` on a thread open / re-init — the A/B buffer host
   *  awaits this before cross-fading a pane in, so the reveal never races a half-initialized kernel. Carries
   *  `threadId` (NOT `trd.id` — that's the ThreadParticipant row id, a different value) so the host can
   *  discard stale emits from a superseded reset. Not emitted on teardown. */
  readonly ready = output<number>();

  private readonly viewportRef =
    viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef =
    viewChild<ElementRef<HTMLDivElement>>('content');
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
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);
  private readonly convList = inject(ConversationListService);
  private readonly transfers = inject(MediaTransferService);
  private readonly nativeUploads = inject(NativeUploadService);

  private scroller?: ScrollerApi<ChatItemData>;
  private source?: HttpItemSource;
  private currentTrdId: number | null = null;
  /** True only once `initScroller`'s async `init()` has settled (set in its `.finally`, cleared at init
   *  start + in `teardown`). Distinct from `currentTrdId === trd.id` (which is set synchronously at init
   *  START): a pane mid-init has the right `currentTrdId` but is NOT yet ready. {@link reset} uses this to
   *  tell a WARM resident (init done → emit `ready` now, no re-fetch) from a COLD one (idled via
   *  `teardownKernel` → reinit). */
  private kernelReady = false;

  readonly atBottom = signal(true);
  /** Incoming message signals received while the user is reading history. Cleared only after the viewport
   *  reaches the visible newest zone, not merely the kernel's much wider newer-prefetch threshold. */
  readonly newMessageCount = signal(0);
  readonly newMessageLabel = computed(() => {
    const count = this.newMessageCount();
    return count > 99 ? '99+' : String(count);
  });
  readonly stickyDate = signal<string | null>(null);
  /** True while the kernel fetches the initial batch on a thread open (or re-init on switch). Internal load
   *  flag — NOT bound in the template; it arms/cancels the skeleton-reveal timer below. */
  readonly initialLoading = signal(true);
  /** The skeleton shows only when the initial load has outlasted SKELETON_DELAY — fast fetches (sub-~300ms,
   *  the common case on a fast network) produce no skeleton at all, just a clean content reveal. This avoids
   *  the flash an always-on skeleton causes, which is the dated IM pattern in a local-first / fast-network
   *  world. Bound in the template; cleared the moment the first batch lands. */
  readonly skeletonVisible = signal(false);

  /** True when the kernel's mounted window is empty — the thread is open but has no messages (a fresh P2P
   *  friendship, a newly-created group, or after clear-history). Maintained from onScroll's `mounted` count:
   *  the kernel's emit() fires on init's empty branch, on every mount, and on optimistic/incoming inserts, so
   *  the hero card reacts the instant the first message — including an optimistic send — mounts. Reset to false
   *  in teardown; the template additionally gates on !initialLoading() so the card never flashes mid-load. */
  readonly threadEmpty = signal(false);
  /** Reveal the skeleton only after this delay (ms) — the "don't flash on fast loads" gate. */
  private static readonly SKELETON_DELAY = 300;
  private skeletonTimer?: ReturnType<typeof setTimeout>;
  /** Scroll-driven SSE backstop for federated media status — one instance per open thread. Owns the
   *  in-flight ('downloading') seqs + the debounced/rate-limited bulk probe. See MediaProbeScheduler. */
  private readonly probe = new MediaProbeScheduler(
    this.msgService,
    this.msgRepo,
  );

  /** P2P block state, derived from the conv item's `blocked` field (patched live on block/unblock). When
   *  true the composer is swapped for an unblock banner — a blocked user can neither send nor be sent to. */
  readonly blockedPeer = computed(() => !!this.userMsgTrd()?.blocked);
  readonly uploadingTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers.tasks().filter(
      (task) => task.threadId === threadId && task.status === 'uploading',
    );
  });
  /** Uploading plus the service's short-lived completed tail. Keeping completed tasks in the same
   * aggregate card bridges sequential uploads: completing file N can never make the card empty for a
   * frame before file N+1 starts. The service removes the completed tail once the whole batch is quiet. */
  readonly sendingTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers.tasks().filter(
      (task) => task.threadId === threadId && task.status !== 'failed',
    );
  });
  readonly failedTransfers = computed(() => {
    const threadId = this.threadId();
    return this.transfers.tasks().filter(
      (task) => task.threadId === threadId && task.status === 'failed',
    );
  });
  readonly uploadProgress = computed(() => {
    const tasks = this.sendingTransfers();
    if (tasks.length === 0) return null;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    return Math.round((completed / tasks.length) * 100);
  });
  readonly uploadCountLabel = computed(() => {
    const tasks = this.sendingTransfers();
    const completed = tasks.filter((task) => task.status === 'completed').length;
    return `${completed}/${tasks.length}`;
  });
  readonly uploadBytesLabel = computed(() => {
    const tasks = this.sendingTransfers();
    const loaded = tasks.reduce(
      (sum, task) => sum + Math.min(Math.max(0, task.loaded), task.size),
      0,
    );
    const total = tasks.reduce((sum, task) => sum + Math.max(0, task.size), 0);
    return `${formatTransferBytes(loaded)} / ${formatTransferBytes(total)}`;
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
  /** Original File for each in-flight attachment send (keyed by clientMessageId), so a failed-send retry can
   *  replay the upload + send. Cleaned by sweepPendingFiles as confirms drop the pending entries. */
  private readonly pendingFiles = new Map<
    string,
    | { file: File; kind: 'image' | 'file' | 'video' }
    | { native: NativeUploadSelection }
  >();
  /** Voice notes have their own lifecycle and retry metadata. They are deliberately not attachments:
   * recordings render as voice bubbles immediately and never participate in image/file batching. */
  private readonly pendingVoices = new Map<
    string,
    { file: File; duration: number }
  >();
  /** Object URLs created for optimistic FILE cards (download anchor); revoked on teardown to avoid leaks. */
  private readonly blobUrls = new Set<string>();

  constructor() {
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
    });
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
      // SSE live path is SIGNAL-ONLY: onSseEvent filters by threadId and fires onSignal — the body is not
      // shaped/cached here (the conversation-list preview reads it in its own subscriber; the chatbox treats
      // the frame as "newer data exists, go pull it"). onMessageSignal pulls from the DB via getNewer /
      // init(-1), which is also where rawToItems runs once (so ids register once — no double-registration to
      // dedup away a self-send echo / reply on an empty thread). onMessageSignal is the optimistic-confirm
      // reconcile path (appendLive direct-mounts and would double-mount a self-send real beside its bubble).
      {
        onSignal: (seq: number) => {
          if (!this.atBottom()) this.newMessageCount.update((count) => count + 1);
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
      },
    );
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      source: this.source,
      hooks: {
        createItem: (item, prev) => this.createItem(item, prev),
        createSkeleton: () => createGhostCbElement(),
        mergeItems: mergeAlbumItems,
        absorbTail: absorbAlbumTail,
      },
      onScroll: (info) => this.onScroll(info),
      // Immunity frame: hold the kernel's viewport reflow while a route-transition slide is in flight.
      isFrozen: () => this.layout.reflowFrozen(),
    });
    this.initialLoading.set(true);
    this.skeletonVisible.set(false);
    this.kernelReady = false;
    clearTimeout(this.skeletonTimer);
    // Delay-gate: reveal the skeleton only if the first batch is still in flight past SKELETON_DELAY. A fast
    // fetch resolves first → skeletonVisible stays false → no flash, content just appears.
    this.skeletonTimer = setTimeout(() => {
      if (this.initialLoading()) this.skeletonVisible.set(true);
    }, MessageThreadComponent.SKELETON_DELAY);
    void this.scroller.init().finally(() => {
      clearTimeout(this.skeletonTimer);
      this.initialLoading.set(false);
      this.skeletonVisible.set(false);
      this.kernelReady = true;
      if (isDevMode()) {
        console.log('[chat-perf] scroller:ready', {
          threadId: trd.threadId,
          elapsedMs: Math.round(performance.now() - initStartedAt),
        });
      }
      this.ready.emit(trd.threadId);
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
    return createMsgCbElement(
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
    );
  }

  private onScroll(info: CbScrollInfo): void {
    // Drain optimistic sends queued while the newer end was trimmed: noNewer means the mounted tail IS the
    // global newest, so tailAnchorId() is now a safe anchor. Runs before the UI updates below for promptness.
    if (info.noNewer && this.pendingOptimistic.length > 0) {
      const queue = this.pendingOptimistic;
      this.pendingOptimistic = [];
      for (const item of queue) this.insertMsg(this.tailAnchorId(), item);
    }
    this.sweepPendingFiles();
    const atVisibleBottom = isMessageViewportAtBottom(info);
    this.atBottom.set(atVisibleBottom);
    if (atVisibleBottom) this.newMessageCount.set(0);
    this.threadEmpty.set(info.mounted === 0);
    this.updateStickyDate();
    this.probe.schedule(this.threadId() ?? 0);
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

  cancelUploadingTransfers(): void {
    for (const task of this.uploadingTransfers()) {
      this.transfers.discard(task.clientMessageId);
    }
  }

  retryFailedTransfers(): void {
    for (const task of this.failedTransfers()) {
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
          Array.from(intent.files).filter((file) => file.type.startsWith('image/')),
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
    const item = this.makeOptimisticItem(cid, trimmed, 'PURE_TEXT', null, null);
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

  /** Prepare the complete user selection first, then register every transfer synchronously. Consequently
   * the aggregate card's file count and total bytes are fixed on its first rendered frame — image/video
   * metadata probing can no longer make later tasks join an already-visible batch. */
  private async sendAttachments(
    files: ArrayLike<File>,
    waitForUploads = false,
  ): Promise<void> {
    if (!this.threadId()) return;
    const prepared = await Promise.all(
      Array.from(files)
        .map(async (file) => {
          const cid = this.newClientMessageId();
          if (file.type.startsWith('image/')) {
            return {
              file,
              cid,
              kind: 'image' as const,
              meta: await readImageDims(file),
            };
          }
          if (file.type.startsWith('video/')) {
            return {
              file,
              cid,
              kind: 'video' as const,
              meta: await readVideoMeta(file),
            };
          }
          return { file, cid, kind: 'file' as const, meta: null };
        }),
    );
    const uploads: Promise<void>[] = [];
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
      this.pendingFiles.set(entry.cid, {
        file: entry.file,
        kind: entry.kind,
      });
      if (entry.kind === 'image') {
        uploads.push(
          this.uploadAndSendImage(entry.cid, entry.file, item, entry.meta),
        );
      } else if (entry.kind === 'video') {
        uploads.push(
          this.uploadAndSendVideo(entry.cid, entry.file, item, entry.meta),
        );
      } else {
        uploads.push(this.uploadAndSendFile(entry.cid, entry.file, item));
      }
    }
    if (waitForUploads) await Promise.all(uploads);
  }

  private async sendNativeAttachments(
    files: readonly NativeUploadSelection[],
  ): Promise<void> {
    if (!this.threadId()) return;
    for (const file of files) {
      const cid = this.newClientMessageId();
      const contentType =
        file.kind === 'image' ? 'IMAGE' : file.kind === 'video' ? 'VIDEO' : 'FILE';
      const images: AlbumImage[] | null =
        file.kind === 'file'
          ? null
          : [{
              kind: file.kind,
              src: file.preview ?? '',
              w: file.w,
              h: file.h,
              size: file.size,
              duration: file.duration,
              name: file.name,
            }];
      const fileInfo: FileInfo | null =
        file.kind === 'file'
          ? {
              url: '',
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
            }
          : null;
      const item = this.makeOptimisticItem(cid, '', contentType, images, fileInfo);
      this.pendingFiles.set(cid, { native: file });
      this.dispatchPending(item);
      void this.uploadAndSendNative(cid, file, item);
    }
  }

  private async uploadAndSendNative(
    cid: string,
    file: NativeUploadSelection,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    this.transfers.start({
      clientMessageId: cid,
      threadId: tid,
      kind: file.kind,
      name: file.name,
      size: file.size,
      previewUrl: file.preview,
    });
    this.transfers.registerRetry(cid, () => {
      void this.uploadAndSendNative(cid, file, item, true);
    });
    this.transfers.registerCancel(cid, () => {
      this.nativeUploads.cancel(file.uploadId);
    });
    try {
      const contentType =
        file.kind === 'image' ? 'IMAGE' : file.kind === 'video' ? 'VIDEO' : 'FILE';
      const staged = await firstValueFrom(
        this.msgService.sendMedia({
          threadId: tid,
          contentType,
          clientMessageId: cid,
          meta:
            file.kind === 'video'
              ? { w: file.w, h: file.h, duration: file.duration }
              : undefined,
          retry,
        }).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) throw new Error(staged.message);
      const response = await this.nativeUploads.upload<StandardResponse<unknown>>(
        file,
        cid,
        file.kind === 'image'
          ? { w: String(file.w), h: String(file.h) }
          : {},
        (loaded, total) => this.transfers.progress(cid, loaded, total),
      );
      if (response.code !== 0) throw new Error(response.message);
      this.transfers.complete(cid);
      await this.markSent(item);
    } catch {
      this.transfers.fail(cid);
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
    this.blobUrls.add(preview);
    const images: AlbumImage[] = [{
      kind: 'audio',
      src: preview,
      w: VOICE_BAR_W,
      h: VOICE_BAR_H,
      size: f.size,
      duration,
      name: f.name,
    }];
    const item = this.makeOptimisticItem(cid, '', 'AUDIO', images, null);
    this.pendingVoices.set(cid, { file: f, duration });
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
        content: item.data.text,
        contentType: 'PURE_TEXT',
        clientMessageId: cid,
      }),
    )
      .then((res) => {
        if (res.code !== 0) void this.failPending(item);
        else void this.markSent(item); // 200 → spinner→check now, decoupled from the later SSE reorder
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
        if (res.code !== 0) void this.failPending(item);
        else void this.markSent(item);
      })
      .catch(() => void this.failPending(item));
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
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    this.trackTransfer(cid, tid, 'image', f, () =>
      this.uploadAndSendImage(cid, f, item, dims, true),
    );
    try {
      const staged = await firstValueFrom(
        this.msgService.sendMedia({
          threadId: tid,
          contentType: 'IMAGE',
          clientMessageId: cid,
          retry,
        }).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService.uploadMedia(
          f,
          dims.w,
          dims.h,
          cid,
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch {
      this.transfers.fail(cid);
      await this.failPending(item);
    }
  }

  private async uploadAndSendFile(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    this.trackTransfer(cid, tid, 'file', f, () =>
      this.uploadAndSendFile(cid, f, item, true),
    );
    try {
      const staged = await firstValueFrom(
        this.msgService.sendMedia({
          threadId: tid,
          contentType: 'FILE',
          clientMessageId: cid,
          retry,
        }).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
        return;
      }
      const ok = await this.uploadFileResult(f, cid);
      if (!ok) {
        this.transfers.fail(cid);
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch {
      this.transfers.fail(cid);
      await this.failPending(item);
    }
  }

  private async uploadAndSendVideo(
    cid: string,
    f: File,
    item: CbItem<ChatItemData>,
    meta: { w: number; h: number; duration: number },
    retry = false,
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    this.trackTransfer(cid, tid, 'video', f, () =>
      this.uploadAndSendVideo(cid, f, item, meta, true),
    );
    try {
      const staged = await firstValueFrom(
        this.msgService.sendMedia({
          threadId: tid,
          contentType: 'VIDEO',
          clientMessageId: cid,
          meta: { w: meta.w, h: meta.h, duration: meta.duration },
          retry,
        }).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService.uploadVideo(
          f,
          cid,
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch {
      this.transfers.fail(cid);
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
    try {
      const staged = await firstValueFrom(
        this.msgService.sendMedia({
          threadId: tid,
          contentType: 'AUDIO',
          clientMessageId: cid,
          meta: { duration: meta.duration },
          retry,
        }).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (staged.code !== 0) {
        this.transfers.fail(cid);
        await this.failPending(item);
        return;
      }
      const up = await firstValueFrom(
        this.msgService.uploadAudio(
          f,
          cid,
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
      );
      if (up.code !== 0 || up.data?.promoted !== true) {
        this.transfers.fail(cid);
        await this.failPending(item);
      } else {
        this.transfers.complete(cid);
        await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
      }
    } catch {
      this.transfers.fail(cid);
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
        this.msgService.uploadFile(
          f,
          cid,
          (loaded, total) => this.transfers.progress(cid, loaded, total),
        ).pipe(takeUntil(this.transfers.cancelled(cid))),
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
    const voice = this.pendingVoices.get(clientMessageId);
    if (voice) {
      void this.uploadAndSendAudio(
        clientMessageId,
        voice.file,
        item,
        { duration: voice.duration },
        true,
      );
      return;
    }
    const pending = this.pendingFiles.get(clientMessageId);
    if (pending) {
      if ('native' in pending) {
        void this.uploadAndSendNative(
          clientMessageId,
          pending.native,
          item,
          true,
        );
        return;
      }
      // Replay the original attachment send path.
      switch (pending.kind) {
        case 'image':
          void this.uploadAndSendImage(
            clientMessageId,
            pending.file,
            item,
            await readImageDims(pending.file),
            true,
          );
          break;
        case 'video':
          void this.uploadAndSendVideo(
            clientMessageId,
            pending.file,
            item,
            await readVideoMeta(pending.file),
            true,
          );
          break;
        default:
          void this.uploadAndSendFile(
            clientMessageId,
            pending.file,
            item,
            true,
          );
          break;
      }
    } else {
      this.dispatchHttpSendText(item);
    }
  }

  private async cancelPending(clientMessageId: string): Promise<void> {
    const source = this.source;
    const scroller = this.scroller;
    if (!source || !scroller || !source.discardPending(clientMessageId)) return;
    const pending = this.pendingFiles.get(clientMessageId);
    if (pending && 'native' in pending) {
      this.nativeUploads.discard(pending.native.uploadId);
    }
    this.pendingFiles.delete(clientMessageId);
    this.pendingVoices.delete(clientMessageId);
    this.transfers.discard(clientMessageId);
    await scroller.reconcilePending();
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
    const placeholderId = this.nextOptimisticId--;
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

  /** Next synthetic id for an in-flight optimistic send (decrements from -1 so it never collides with a server seq). */
  private nextOptimisticId = -1;

  private newClientMessageId(): string {
    // Always a spec-compliant UUID — the backend validates clientMessageId as a UUID. lib/uuid falls back to
    // crypto.getRandomValues (not secure-context-gated, unlike randomUUID) so this works on http non-localhost origins.
    return uuid();
  }

  /** Drop retained Files for pending entries that have resolved (confirmed/dropped from the source). Called from
   *  onScroll so confirms clean up promptly. Object URLs are revoked on teardown (they may still be rendering). */
  private sweepPendingFiles(): void {
    const source = this.source;
    if (!source || (this.pendingFiles.size === 0 && this.pendingVoices.size === 0)) return;
    const live = new Set(source.getPending().map((p) => p.clientMessageId));
    for (const cid of this.pendingFiles.keys()) {
      if (!live.has(cid)) {
        const pending = this.pendingFiles.get(cid);
        if (pending && 'native' in pending) {
          this.nativeUploads.discard(pending.native.uploadId);
        }
        this.pendingFiles.delete(cid);
      }
    }
    for (const cid of this.pendingVoices.keys()) {
      if (!live.has(cid)) this.pendingVoices.delete(cid);
    }
  }

  private teardown(): void {
    clearTimeout(this.skeletonTimer);
    this.probe.destroy();
    this.threadEmpty.set(false);
    this.atBottom.set(true);
    this.newMessageCount.set(0);
    this.scroller?.destroy(); // destroy() also calls source.destroy() (unsubscribes SSE)
    this.scroller = undefined;
    this.source = undefined;
    this.kernelReady = false;
    // (In-chat search visibility lives on NavStateMachineService now — cleared by openChat/closeChat on
    // thread switch / going home — so no per-pane reset is needed here.)
    this.pendingOptimistic = [];
    for (const pending of this.pendingFiles.values()) {
      if ('native' in pending) this.nativeUploads.discard(pending.native.uploadId);
    }
    this.pendingFiles.clear();
    this.pendingVoices.clear();
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.clear();
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

function formatTransferBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
