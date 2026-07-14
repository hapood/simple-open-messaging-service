import {
  Component,
  computed,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpEventType, HttpResponse } from '@angular/common/http';
import { firstValueFrom, filter, map } from 'rxjs';
import { TranslocoModule } from '@jsverse/transloco';
import {
  ChatBoxScroller,
  type ScrollerApi,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import { HttpItemSource } from './http-item-source';
import { MediaProbeScheduler } from './media-probe-scheduler';
import { createMsgCbElement, createGhostCbElement, computeRowFlags } from '../message-cards/create-item';
import { mergeAlbumItems, absorbAlbumTail } from '../message-cards/merge-items';
import { MEDIA_STATUS, type AlbumImage, type ChatItemData, type ChatMsgData, type FileInfo, type MediaStatus } from '../message-cards/chat-item';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { ChatInputComponent, type ChatSendIntent } from '../../lib/chat-input/chat-input.component';
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
import type { ConversationItem, StandardResponse } from '../../services/model';

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
  imports: [MessageHeaderComponent, ChatInputComponent, KbdOffsetDirective, StickyDateOverlayComponent, TranslocoModule],
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

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  /** Soft-keyboard occlusion height (from the KbdOffsetDirective on `.msg-container`). Bound as the
   *  input bar's margin-bottom so the flex column turns it into a bottom inset and the viewport
   *  (flex:1) shrinks to match — the kernel re-pins to a correct bottom. Public so the template can
   *  read `kbdOffset()?.offset()` (private members are not template-accessible under strict templates). */
  readonly kbdOffset = viewChild(KbdOffsetDirective);
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly msgRepo = inject(MessageRepository);
  private readonly userService = inject(UserService);
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);
  private readonly convList = inject(ConversationListService);

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
  readonly stickyDate = signal<string | null>(null);
  /** True while the kernel fetches the initial batch on a thread open (or re-init on switch). Internal load
   *  flag — NOT bound in the template; it arms/cancels the skeleton-reveal timer below. */
  readonly initialLoading = signal(true);
  /** The skeleton shows only when the initial load has outlasted SKELETON_DELAY — fast fetches (sub-~300ms,
   *  the common case on a fast network) produce no skeleton at all, just a clean content reveal. This avoids
   *  the flash an always-on skeleton causes, which is the dated IM pattern in a local-first / fast-network
   *  world. Bound in the template; cleared the moment the first batch lands. */
  readonly skeletonVisible = signal(false);
  /** Reveal the skeleton only after this delay (ms) — the "don't flash on fast loads" gate. */
  private static readonly SKELETON_DELAY = 300;
  private skeletonTimer?: ReturnType<typeof setTimeout>;
  /** Scroll-driven SSE backstop for federated media status — one instance per open thread. Owns the
   *  in-flight ('downloading') seqs + the debounced/rate-limited bulk probe. See MediaProbeScheduler. */
  private readonly probe = new MediaProbeScheduler(this.msgService, this.msgRepo);

  /** P2P block state, derived from the conv item's `blocked` field (patched live on block/unblock). When
   *  true the composer is swapped for an unblock banner — a blocked user can neither send nor be sent to. */
  readonly blockedPeer = computed(() => !!this.userMsgTrd()?.blocked);

  /** Optimistic sends queued while the newer end was trimmed (scrolled into history); drained in onScroll once
   *  the kernel reports noNewer (the mounted tail is the global newest → safe to anchor on). */
  private pendingOptimistic: CbItem<ChatItemData>[] = [];
  /** Original File for each in-flight image/file send (keyed by clientMessageId), so a failed-send retry can
   *  replay the upload + send. Cleaned by sweepPendingFiles as confirms drop the pending entries. */
  private readonly pendingFiles = new Map<string, { file: File; kind: 'image' | 'file' | 'video' | 'audio' }>();
  /** Object URLs created for optimistic FILE cards (download anchor); revoked on teardown to avoid leaks. */
  private readonly blobUrls = new Set<string>();

  constructor() {
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

  private initScroller(viewport: HTMLDivElement, content: HTMLDivElement, trd: ConversationItem): void {
    this.source = new HttpItemSource(
      trd, this.userService.sessionProfile()?.id ?? 0, this.msgRepo, this.userService, this.wsService,
      // SSE live path is SIGNAL-ONLY: onSseEvent filters by threadId and fires onSignal — the body is not
      // shaped/cached here (the conversation-list preview reads it in its own subscriber; the chatbox treats
      // the frame as "newer data exists, go pull it"). onMessageSignal pulls from the DB via getNewer /
      // init(-1), which is also where rawToItems runs once (so ids register once — no double-registration to
      // dedup away a self-send echo / reply on an empty thread). onMessageSignal is the optimistic-confirm
      // reconcile path (appendLive direct-mounts and would double-mount a self-send real beside its bubble).
      {
        onSignal: (seq: number) => {
          // onMessageSignal is async — without a .catch a kernel throw here would be an unhandled rejection
          // and the just-signaled live item would never mount (silent drop in the open chatbox). The seq is the
          // message's per-thread seq (== its item id); the kernel tracks the MAX seen during the init-fetch
          // window to decide whether a post-init replay is actually needed.
          void this.scroller?.onMessageSignal(seq).catch((e) => console.error('[chat] onMessageSignal rejected', e));
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
      hooks: { createItem: (item, prev) => this.createItem(item, prev), createSkeleton: () => createGhostCbElement(), mergeItems: mergeAlbumItems, absorbTail: absorbAlbumTail },
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
    void this.scroller.init()
      .finally(() => {
        clearTimeout(this.skeletonTimer);
        this.initialLoading.set(false);
        this.skeletonVisible.set(false);
        this.kernelReady = true;
        this.ready.emit(trd.threadId);
      });
  }

  /** Kernel createItem hook: compute grouping flags from the older neighbor prev, wrap the real component.
   *  Passes onRetry so a failed self-send row's retry glyph calls back into retrySend (msgId = clientMessageId), and
   *  onOpenImage so clicking an image cell opens the gallery viewer. */
  private createItem(item: CbItem<ChatItemData>, prev: CbItem<ChatItemData> | null): CbElement<ChatItemData> {
    // Real items only — the topmost skeleton-slot decision (prev/boundary/noOlder) lives in the kernel's createVs,
    // rendered via the createSkeleton hook supplied below. createItem never branches on ghost-vs-real: that rule
    // drifted between playground and production and is what swallowed the empty-thread first message.
    const { isShowHead, isGroupStart, showDate } = computeRowFlags(item, prev);
    if (item.data.mediaStatus === MEDIA_STATUS.DOWNLOADING) this.probe.track(item.id, true);
    return createMsgCbElement(
      item, isShowHead, isGroupStart, showDate, this.envInjector,
      (msgId) => this.retrySend(msgId),
      (images, index) => this.galleryViewer.open(images, index, this.threadId() ?? 0),
      (data) => this.fileDetail.open(data, this.threadId() ?? 0),
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
    this.atBottom.set(info.atBottom);
    this.updateStickyDate();
    this.probe.schedule(this.threadId() ?? 0);
  }

  /** Telegram-style sticky date overlay: the text of the last date-separator row at/above the viewport top. */
  private updateStickyDate(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) { this.stickyDate.set(null); return; }
    const vTop = vp.getBoundingClientRect().top;
    let current: string | null = null;
    for (const d of Array.from(ct.querySelectorAll<HTMLElement>('.msg-date'))) {
      if (d.getBoundingClientRect().top <= vTop + 14) current = d.textContent?.trim() ?? null;
    }
    this.stickyDate.set(current);
  }

  // ---------- ChatInputComponent intent → optimistic dispatch ----------

  /** The composer emits one structured intent; route it to the matching optimistic-send path. */
  onSendIntent(intent: ChatSendIntent): void {
    switch (intent.kind) {
      case 'text': this.sendText(intent.text); return;
      case 'image': void this.sendImages(intent.files); return;
      case 'file': void this.sendFiles(intent.files); return;
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

  private async sendImages(files: FileList): Promise<void> {
    if (!this.threadId()) return;
    for (const f of Array.from(files).filter((f) => f.type.startsWith('image/'))) {
      const cid = this.newClientMessageId();
      const dims = await readImageDims(f);
      const dataURL = await readFileAsDataURL(f);
      const images: AlbumImage[] = [{ kind: 'image', src: dataURL, w: dims.w, h: dims.h, size: f.size }];
      const item = this.makeOptimisticItem(cid, '', 'IMAGE', images, null);
      this.pendingFiles.set(cid, { file: f, kind: 'image' });
      this.dispatchPending(item);
      void this.uploadAndSendImage(cid, f, item, dims);
    }
  }

  private async sendFiles(files: FileList): Promise<void> {
    if (!this.threadId()) return;
    for (const f of Array.from(files)) {
      // Route by MIME: video/audio become VIDEO/AUDIO media cards; everything else stays a FILE message.
      if (f.type.startsWith('video/')) {
        void this.sendVideo(f);
      } else if (f.type.startsWith('audio/')) {
        void this.sendAudio(f);
      } else {
        void this.sendFile(f);
      }
    }
  }

  /** Send a generic (non-video/audio) file as a FILE message. */
  private async sendFile(f: File): Promise<void> {
    const cid = this.newClientMessageId();
    const url = URL.createObjectURL(f);
    this.blobUrls.add(url);
    const file: FileInfo = { url, name: f.name, size: f.size, mimeType: f.type || 'application/octet-stream' };
    const item = this.makeOptimisticItem(cid, '', 'FILE', null, file);
    this.pendingFiles.set(cid, { file: f, kind: 'file' });
    this.dispatchPending(item);
    void this.uploadAndSendFile(cid, f, item);
  }

  /** Send a video as a VIDEO message: probe w/h/duration client-side (<video> loadedmetadata), render
   *  an optimistic media cell (blob url + first frame), then upload + send. The server validates only
   *  the container family; w/h/duration ride in the content JSON (server-untrusted). */
  private async sendVideo(f: File): Promise<void> {
    const cid = this.newClientMessageId();
    const meta = await readVideoMeta(f);
    const url = URL.createObjectURL(f);
    this.blobUrls.add(url);
    const images: AlbumImage[] = [{
      kind: 'video', src: url, w: meta.w, h: meta.h,
      size: f.size, duration: meta.duration, name: f.name,
    }];
    const item = this.makeOptimisticItem(cid, '', 'VIDEO', images, null);
    this.pendingFiles.set(cid, { file: f, kind: 'video' });
    this.dispatchPending(item);
    void this.uploadAndSendVideo(cid, f, item, meta);
  }

  /** Send an audio clip as an AUDIO message: probe duration client-side, optimistic gray cell, upload + send. */
  private async sendAudio(f: File): Promise<void> {
    const cid = this.newClientMessageId();
    const meta = await readAudioMeta(f);
    const url = URL.createObjectURL(f);
    this.blobUrls.add(url);
    const images: AlbumImage[] = [{
      kind: 'audio', src: url, w: 280, h: 120, // placeholder aspect (audio is a gray cell + ▶)
      size: f.size, duration: meta.duration, name: f.name,
    }];
    const item = this.makeOptimisticItem(cid, '', 'AUDIO', images, null);
    this.pendingFiles.set(cid, { file: f, kind: 'audio' });
    this.dispatchPending(item);
    void this.uploadAndSendAudio(cid, f, item, meta);
  }

  private dispatchHttpSendText(item: CbItem<ChatItemData>): void {
    const cid = item.clientMessageId!;
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    firstValueFrom(this.msgService.sendMessage({
      threadId: tid, content: item.data.text, contentType: 'PURE_TEXT', clientMessageId: cid,
    })).then((res) => {
      if (res.code !== 0) void this.failPending(item);
      else void this.markSent(item); // 200 → spinner→check now, decoupled from the later SSE reorder
    }).catch(() => void this.failPending(item));
  }

  /** Send-media-first flow: POST /send-media stages a PendingMedia (durable intent, keyed by cid),
   *  then the upload (carrying the same cid via the x-client-message-id header) writes the file and the
   *  server promotes the stage to a real Message. The NEW_MESSAGE SSE echo (matched by cid) reconciles
   *  the optimistic bubble — so on upload success there is nothing to do here. Any failure → failPending. */
  private async uploadAndSendImage(cid: string, f: File, item: CbItem<ChatItemData>, dims: { w: number; h: number }): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    try {
      const staged = await firstValueFrom(this.msgService.sendMedia({ threadId: tid, contentType: 'IMAGE', clientMessageId: cid }));
      if (staged.code !== 0) { await this.failPending(item); return; }
      const up = await firstValueFrom(this.msgService.uploadMedia(f, dims.w, dims.h, cid));
      if (up.code !== 0) await this.failPending(item);
      else await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
    } catch {
      await this.failPending(item);
    }
  }

  private async uploadAndSendFile(cid: string, f: File, item: CbItem<ChatItemData>): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    try {
      const staged = await firstValueFrom(this.msgService.sendMedia({ threadId: tid, contentType: 'FILE', clientMessageId: cid }));
      if (staged.code !== 0) { await this.failPending(item); return; }
      const ok = await this.uploadFileResult(f, cid);
      if (!ok) await this.failPending(item);
      else await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
    } catch {
      await this.failPending(item);
    }
  }

  private async uploadAndSendVideo(
    cid: string, f: File, item: CbItem<ChatItemData>, meta: { w: number; h: number; duration: number },
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    try {
      const staged = await firstValueFrom(this.msgService.sendMedia({
        threadId: tid, contentType: 'VIDEO', clientMessageId: cid, meta: { w: meta.w, h: meta.h, duration: meta.duration },
      }));
      if (staged.code !== 0) { await this.failPending(item); return; }
      const up = await firstValueFrom(this.msgService.uploadVideo(f, cid));
      if (up.code !== 0) await this.failPending(item);
      else await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
    } catch {
      await this.failPending(item);
    }
  }

  private async uploadAndSendAudio(
    cid: string, f: File, item: CbItem<ChatItemData>, meta: { duration: number },
  ): Promise<void> {
    const tid = this.threadId() ?? 0;
    if (!tid) return;
    try {
      const staged = await firstValueFrom(this.msgService.sendMedia({
        threadId: tid, contentType: 'AUDIO', clientMessageId: cid, meta: { duration: meta.duration },
      }));
      if (staged.code !== 0) { await this.failPending(item); return; }
      const up = await firstValueFrom(this.msgService.uploadAudio(f, cid));
      if (up.code !== 0) await this.failPending(item);
      else await this.markSent(item); // upload done → spinner→check now, decoupled from the later SSE reorder
    } catch {
      await this.failPending(item);
    }
  }

  /** Reduce uploadFile's event stream to its final response body (the uploaded file metadata). Null on
   *  error. `cid` promotes a staged send; on a successful response the server has already committed the
   *  Message and the SSE echo reconciles the bubble. */
  private async uploadFileResult(f: File, cid?: string): Promise<{ url: string; name: string; size: number; mimeType: string } | null> {
    try {
      return await firstValueFrom(this.msgService.uploadFile(f, cid).pipe(
        filter((e): e is HttpResponse<StandardResponse<{ url: string; name: string; size: number; mimeType: string }>> =>
          e.type === HttpEventType.Response),
        map((e) => e.body?.data ?? null),
      ));
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
    const pending = this.pendingFiles.get(clientMessageId);
    if (pending) {
      if (pending.kind === 'image') void this.uploadAndSendImage(clientMessageId, pending.file, item, await readImageDims(pending.file));
      else void this.uploadAndSendFile(clientMessageId, pending.file, item);
    } else {
      this.dispatchHttpSendText(item);
    }
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
    const stampedImages = images?.map(im => ({ ...im, msgId: placeholderId })) ?? null;
    const data: ChatMsgData = {
      type: 'msg',
      msgId: placeholderId,
      creator: profile?.id ?? 0,
      isSelf: true,
      name: profile?.name ?? 'Me',
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images: stampedImages, file, createdAtMs: now.getTime(),
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
    if (!source || this.pendingFiles.size === 0) return;
    const live = new Set(source.getPending().map((p) => p.clientMessageId));
    for (const cid of this.pendingFiles.keys()) {
      if (!live.has(cid)) this.pendingFiles.delete(cid);
    }
  }

  private teardown(): void {
    clearTimeout(this.skeletonTimer);
    this.probe.destroy();
    this.scroller?.destroy(); // destroy() also calls source.destroy() (unsubscribes SSE)
    this.scroller = undefined;
    this.source = undefined;
    this.kernelReady = false;
    // (In-chat search visibility lives on NavStateMachineService now — cleared by openChat/closeChat on
    // thread switch / going home — so no per-pane reset is needed here.)
    this.pendingOptimistic = [];
    this.pendingFiles.clear();
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
  onHistoryCleared(): void {
    this.reinit();
  }

  /** Unblock the P2P peer from the blocked banner (mirrors the header menu's unblock path). */
  unblockPeer(): void {
    const trd = this.userMsgTrd();
    const peerId = trd?.peerUser?.id;
    if (peerId === undefined) return;
    this.userService.setBlock({ userId: peerId, block: false }).subscribe((res) => {
      if (res.code === 0) this.convList.applyThreadMeta(trd!.threadId, { blocked: false });
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
    const w = bmp.width, h = bmp.height;
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
function readVideoMeta(f: File): Promise<{ w: number; h: number; duration: number }> {
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
    v.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0, duration: 0 }); };
    v.src = url;
  });
}

/** Probe an audio clip's duration via <audio> loadedmetadata (for the AUDIO message content + overlay). */
function readAudioMeta(f: File): Promise<{ duration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      const duration = Number.isFinite(a.duration) ? a.duration : 0;
      URL.revokeObjectURL(url);
      resolve({ duration });
    };
    a.onerror = () => { URL.revokeObjectURL(url); resolve({ duration: 0 }); };
    a.src = url;
  });
}
