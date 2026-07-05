import {
  Component,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { HttpEventType, HttpResponse } from '@angular/common/http';
import { firstValueFrom, filter, map } from 'rxjs';
import {
  ChatBoxScroller,
  type ScrollerApi,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import { HttpItemSource } from './http-item-source';
import { createMsgCbElement, createGhostCbElement, computeRowFlags } from '../message-cards/create-item';
import { mergeAlbumItems, absorbAlbumTail } from '../message-cards/merge-items';
import type { AlbumImage, ChatItemData, ChatMsgData, FileInfo } from '../message-cards/chat-item';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { ChatInputComponent, type ChatSendIntent } from '../../lib/chat-input/chat-input.component';
import { KbdOffsetDirective } from '../../directives/kbd-offset.directive';
import { StickyDateOverlayComponent } from '../message-cards/sticky-date-overlay/sticky-date-overlay.component';
import { uuid } from '../../lib/uuid';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import { LayoutService } from '../../services/layout.service';
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
  imports: [MessageHeaderComponent, ChatInputComponent, KbdOffsetDirective, StickyDateOverlayComponent],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  readonly threadId = input<number>();
  readonly startMsgId = input<string>();
  readonly userMsgTrd = input<ConversationItem>();

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  /** Soft-keyboard occlusion height (from the KbdOffsetDirective on `.msg-container`). Bound as the
   *  input bar's margin-bottom so the flex column turns it into a bottom inset and the viewport
   *  (flex:1) shrinks to match — the kernel re-pins to a correct bottom. Public so the template can
   *  read `kbdOffset()?.offset()` (private members are not template-accessible under strict templates). */
  readonly kbdOffset = viewChild(KbdOffsetDirective);
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly userService = inject(UserService);
  private readonly wsService = inject(WebsocketService);
  private readonly layout = inject(LayoutService);
  private readonly galleryViewer = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);

  private scroller?: ScrollerApi<ChatItemData>;
  private source?: HttpItemSource;
  private currentTrdId: number | null = null;
  /** The id this thread was initialized/jumped to (dedup: prevents the init anchor from being re-jumped). */
  private lastJumpId: string | number | null = null;

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

  /** Optimistic sends queued while the newer end was trimmed (scrolled into history); drained in onScroll once
   *  the kernel reports noNewer (the mounted tail is the global newest → safe to anchor on). */
  private pendingOptimistic: CbItem<ChatItemData>[] = [];
  /** Original File for each in-flight image/file send (keyed by clientMessageId), so a failed-send retry can
   *  replay the upload + send. Cleaned by sweepPendingFiles as confirms drop the pending entries. */
  private readonly pendingFiles = new Map<string, { file: File; kind: 'image' | 'file' }>();
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
    // A startMsgId change within an open thread (e.g. clicking a search result) → jump to it (re-seed if unmounted).
    effect(() => {
      const startId = this.startMsgId();
      const trd = this.userMsgTrd();
      if (!trd || startId === undefined || this.currentTrdId !== trd.id) return;
      if (startId === this.lastJumpId) return; // already the init anchor / already jumped
      this.lastJumpId = startId;
      this.scroller?.scrollToIndex(startId, 'center', true);
    });
    // Immunity frame drain: when a route-transition freeze ends, apply any viewport resize the kernel
    // deferred so the message list re-pins to the post-animation viewport exactly once.
    effect(() => {
      if (this.layout.reflowFrozen()) return; // act only on the unfrozen edge
      this.scroller?.flushViewportResize();
    });
  }

  private initScroller(viewport: HTMLDivElement, content: HTMLDivElement, trd: ConversationItem): void {
    const startId = this.startMsgId() ?? null; // open at this message if provided (re-anchor)
    this.lastJumpId = startId;
    this.source = new HttpItemSource(
      trd, this.userService.sessionProfile()?.id ?? 0, this.msgService, this.userService, this.wsService,
      // SSE live path is SIGNAL-ONLY: onSseEvent filters by threadId and fires onSignal — the body is not
      // shaped/cached here (the conversation-list preview reads it in its own subscriber; the chatbox treats
      // the frame as "newer data exists, go pull it"). onMessageSignal pulls from the DB via getNewer /
      // init(-1), which is also where rawToItems runs once (so ids register once — no double-registration to
      // dedup away a self-send echo / reply on an empty thread). onMessageSignal is the optimistic-confirm
      // reconcile path (appendLive direct-mounts and would double-mount a self-send real beside its bubble).
      { onSignal: () => {
        // onMessageSignal is async — without a .catch a kernel throw here would be an unhandled rejection
        // and the just-signaled live item would never mount (silent drop in the open chatbox).
        void this.scroller?.onMessageSignal().catch((e) => console.error('[chat] onMessageSignal rejected', e));
      } },
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
    clearTimeout(this.skeletonTimer);
    // Delay-gate: reveal the skeleton only if the first batch is still in flight past SKELETON_DELAY. A fast
    // fetch resolves first → skeletonVisible stays false → no flash, content just appears.
    this.skeletonTimer = setTimeout(() => {
      if (this.initialLoading()) this.skeletonVisible.set(true);
    }, MessageThreadComponent.SKELETON_DELAY);
    void this.scroller.init(startId !== null ? { startMsgId: startId, anchor: 'center', highlight: true } : undefined)
      .finally(() => {
        clearTimeout(this.skeletonTimer);
        this.initialLoading.set(false);
        this.skeletonVisible.set(false);
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
    return createMsgCbElement(
      item, isShowHead, isGroupStart, showDate, this.envInjector,
      (msgId) => this.retrySend(msgId),
      (images, index) => this.galleryViewer.open(images, index),
      (data) => this.fileDetail.open(data),
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
  }

  /** Telegram-style sticky date overlay: the text of the last date-separator row at/above the viewport top. */
  private updateStickyDate(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) { this.stickyDate.set(null); return; }
    const vTop = vp.getBoundingClientRect().top;
    let current: string | null = null;
    for (const d of Array.from(ct.querySelectorAll<HTMLElement>('.pg-date'))) {
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
      const images: AlbumImage[] = [{ src: dataURL, w: dims.w, h: dims.h, msgId: cid }];
      const item = this.makeOptimisticItem(cid, '', 'IMAGE', images, null);
      this.pendingFiles.set(cid, { file: f, kind: 'image' });
      this.dispatchPending(item);
      void this.uploadAndSendImage(cid, f, item, dims);
    }
  }

  private async sendFiles(files: FileList): Promise<void> {
    if (!this.threadId()) return;
    for (const f of Array.from(files)) {
      const cid = this.newClientMessageId();
      const url = URL.createObjectURL(f);
      this.blobUrls.add(url);
      const file: FileInfo = { url, name: f.name, size: f.size, mimeType: f.type || 'application/octet-stream' };
      const item = this.makeOptimisticItem(cid, '', 'FILE', null, file);
      this.pendingFiles.set(cid, { file: f, kind: 'file' });
      this.dispatchPending(item);
      void this.uploadAndSendFile(cid, f, item);
    }
  }

  private dispatchHttpSendText(item: CbItem<ChatItemData>): void {
    const cid = item.clientMessageId!;
    const tid = this.threadId();
    if (!tid) return;
    firstValueFrom(this.msgService.sendMessage({
      threadId: tid, content: item.data.text, contentType: 'PURE_TEXT', clientMessageId: cid,
    })).then((res) => {
      if (res.code !== 0) void this.failPending(item);
      // success: the SSE echo reconciles the optimistic bubble (no-op here).
    }).catch(() => void this.failPending(item));
  }

  private async uploadAndSendImage(cid: string, f: File, item: CbItem<ChatItemData>, dims: { w: number; h: number }): Promise<void> {
    const tid = this.threadId();
    if (!tid) return;
    try {
      const up = await firstValueFrom(this.msgService.uploadMedia(f, dims.w, dims.h));
      if (up.code !== 0 || !up.data) { await this.failPending(item); return; }
      const res = await firstValueFrom(this.msgService.sendMessage({
        threadId: tid, content: JSON.stringify({ url: up.data.url, w: dims.w, h: dims.h }),
        contentType: 'IMAGE', clientMessageId: cid,
      }));
      if (res.code !== 0) await this.failPending(item);
    } catch {
      await this.failPending(item);
    }
  }

  private async uploadAndSendFile(cid: string, f: File, item: CbItem<ChatItemData>): Promise<void> {
    const tid = this.threadId();
    if (!tid) return;
    try {
      const data = await this.uploadFileResult(f);
      if (!data) { await this.failPending(item); return; }
      const res = await firstValueFrom(this.msgService.sendMessage({
        threadId: tid, content: JSON.stringify(data), contentType: 'FILE', clientMessageId: cid,
      }));
      if (res.code !== 0) await this.failPending(item);
    } catch {
      await this.failPending(item);
    }
  }

  /** Reduce uploadFile's event stream to its final response body (the uploaded file metadata). Null on error. */
  private async uploadFileResult(f: File): Promise<{ url: string; name: string; size: number; mimeType: string } | null> {
    try {
      return await firstValueFrom(this.msgService.uploadFile(f).pipe(
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
   *  NB: do NOT bail on an empty `afterId`. The FIRST send into an EMPTY thread has tailAnchorId()==='' (nothing is
   *  mounted → newestId is null); the kernel's insertAfter treats an empty window as "insert as the sole entry", so
   *  bailing here would silently swallow the first message of a fresh conversation — no pending bubble ever appears.
   *  (Mirrors the playground insertMsg, whose comment calls out this exact case.) */
  private insertMsg(afterId: string, item: CbItem<ChatItemData>): boolean {
    const scroller = this.scroller;
    const source = this.source;
    if (!scroller || !source) return false;
    source.addPending(item);
    const ok = scroller.insertAfter(afterId, item, { optimistic: true });
    if (ok) scroller.scrollToBottom(); // insertAfter is viewport-stable; a send always means "show my message"
    return ok;
  }

  /** The id to anchor a newest-end insert after: the current tail (a prior pending, or the real newest). '' if empty. */
  private tailAnchorId(): string {
    const id = this.scroller?.getInfo().newestId ?? null;
    return id != null ? String(id) : '';
  }

  /** Build a fully-shaped optimistic self message. id = clientMessageId (no server id yet); the client tracks the
   *  bubble by clientMessageId until the server echo arrives and reconciles it. status:'sending', kind:'pending'. */
  private makeOptimisticItem(
    clientMessageId: string,
    text: string,
    contentType: ChatMsgData['contentType'],
    images: AlbumImage[] | null,
    file: FileInfo | null,
  ): CbItem<ChatItemData> {
    const profile = this.userService.sessionProfile();
    const now = new Date();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: clientMessageId,
      creator: profile?.id ?? 0,
      isSelf: true,
      name: profile?.uniqName ?? 'Me',
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images, file, createdAtMs: now.getTime(),
      status: 'sending',
      kind: 'pending',
    };
    return { id: clientMessageId, data, clientMessageId };
  }

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
    this.scroller?.destroy(); // destroy() also calls source.destroy() (unsubscribes SSE)
    this.scroller = undefined;
    this.source = undefined;
    this.pendingOptimistic = [];
    this.pendingFiles.clear();
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.clear();
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
