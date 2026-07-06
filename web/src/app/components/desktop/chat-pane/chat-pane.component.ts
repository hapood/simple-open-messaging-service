import { Component, computed, effect, inject, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { SearchService } from '../../../services/search.service';
import { prefersReducedMotion } from '../../../lib/motion-utils';
import type { ConversationItem } from '../../../services/model';

/** Cross-fade duration (ms) — also the grace period before a backgrounded pane's kernel is idled, so its
 *  content stays visible through the dissolve. Kept in sync with `--pane-fade-ms` in the styles below. */
const ENTER_MS = 300;
/** Easing + start radius for the circular clip-path reveal on the incoming pane (matches the group-join
 *  hero's circle-expand, so a thread switch and a join feel like the same motion). */
const EASING = [0.32, 0.72, 0, 1];
const START_RADIUS = 40;
/** Force-promote fallback if a background init stalls (hung fetch). */
const PROMOTE_TIMEOUT_MS = 3000;

type SlotKey = 'A' | 'B';

/**
 * A/B double-buffered chat pane. Two `MessageThreadComponent` instances stay mounted as stacked absolute
 * layers; one is FOREGROUND (visible) and one is BACKGROUND (rendered but `opacity:0` + `visibility:hidden`,
 * so its kernel keeps measuring layout correctly — `display:none` would zero `offsetHeight`/`scrollHeight`
 * and break the kernel, which measures layout not paint).
 *
 * A switch never races a kernel init: the target thread is bound to the BACKGROUND instance, whose own
 * constructor effect runs `teardown() + initScroller()` (reset) while hidden; when its kernel emits `ready`,
 * the pane is promoted to foreground and the old foreground's kernel is idled (`teardownKernel`) after the
 * cross-fade — bounding memory + SSE to one warm pane.
 *
 * VISUALS ARE PURE CSS, not imperative WAAPI. The foreground slot is a signal (`fgSlot`) flipped
 * SYNCHRONOUSLY in `promote()`; each layer wears `.pane-fg` or defaults to background, and CSS `transition`
 * cross-fades opacity/visibility between them. This is the load-bearing design choice: CSS transitions are
 * idempotent (re-toggling a class just re-interpolates toward the current target) and have no `fill:
 * forwards` to outlive their purpose. The earlier imperative design used a fire-and-forget `oldLayer.animate(
 * opacity 1→0, fill:forwards)` that lingered on a layer and, when that layer later became the incoming pane,
 * reasserted `opacity:0` over `markFg`'s inline `opacity:1` after the reveal canceled itself (animations beat
 * inline styles) — blanking a content-bearing foreground on rapid switches. There is no animation lifecycle
 * to race or leak here, by construction.
 *
 * The target comes from `ConversationListService.openThreadId` (URL-driven; sole writer is the home shell).
 * This component is route-reused (`ChatReuseStrategy`) and never remounted.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, ChatEmptyComponent],
  template: `
    <div class="chat-pane">
      <div class="pane-layer" [class.pane-fg]="fgSlot() === 'A'" #layerA>
        @if (itemA(); as trd) {
          <app-message-thread #threadA [threadId]="trd.threadId" [userMsgTrd]="trd"
            [startMsgId]="startMsgId()" (ready)="onReady('A', $event)" />
        }
      </div>
      <div class="pane-layer" [class.pane-fg]="fgSlot() === 'B'" #layerB>
        @if (itemB(); as trd) {
          <app-message-thread #threadB [threadId]="trd.threadId" [userMsgTrd]="trd"
            [startMsgId]="startMsgId()" (ready)="onReady('B', $event)" />
        }
      </div>
      @if (!active()) {
        <div class="pane-empty"><app-chat-empty /></div>
      } @else if (!fgItem()) {
        <div class="pane-loading">
          <svg class="spinner" viewBox="0 0 80 80" aria-hidden="true">
            <circle class="spin-track" cx="40" cy="40" r="34" pathLength="100" />
            <circle class="spin-arc" cx="40" cy="40" r="34" pathLength="100" />
          </svg>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .chat-pane {
      --pane-fade-ms: 300ms;
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      /* Solid ground behind both panes — shown through the outgoing pane as it dissolves. */
      background: var(--app-surface);
    }
    @media (prefers-reduced-motion: reduce) {
      .chat-pane { --pane-fade-ms: 0ms; }
    }
    /* Two stacked panes, each absolute inset:0 so BOTH keep real layout (offsetHeight) even while the
       background one is hidden. Default = BACKGROUND resting state: invisible + behind (z1). */
    .pane-layer {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--app-surface);
      opacity: 0;
      visibility: hidden;
      z-index: 1;
      /* Demote (fg→bg) fades opacity out, THEN flips visibility to hidden after the fade (the visibility
         transition is delayed by --pane-fade-ms) so the dissolving pane stays paintable through the fade. */
      transition:
        opacity var(--pane-fade-ms) cubic-bezier(0.32, 0.72, 0, 1),
        visibility 0s linear var(--pane-fade-ms);
    }
    .pane-layer.pane-fg {
      opacity: 1;
      visibility: visible;
      z-index: 2;
      /* Reveal (bg→fg) makes visibility visible IMMEDIATELY (undelayed) so the incoming pane is interactive
         as soon as it starts fading in. */
      transition:
        opacity var(--pane-fade-ms) cubic-bezier(0.32, 0.72, 0, 1),
        visibility 0s;
    }
    .pane-layer > app-message-thread { display: block; flex: 1 1 auto; min-height: 0; }
    /* Overlays sit at the foreground's z-index (2) but later in DOM order, so they paint above an empty
       foreground (the only time they are shown). */
    .pane-empty, .pane-loading {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
    }
    .pane-empty > app-chat-empty { display: block; flex: 1 1 auto; min-height: 0; }
    .pane-loading { align-items: center; justify-content: center; }
    .spinner { width: 80px; height: 80px; animation: chat-pane-spin 0.9s linear infinite; }
    .spin-track { fill: none; stroke: var(--app-border); stroke-width: 5; opacity: 0.5; }
    .spin-arc { fill: none; stroke: var(--app-brand); stroke-width: 5; stroke-linecap: round; stroke-dasharray: 60 100; }
    @keyframes chat-pane-spin { to { transform: rotate(360deg); } }
  `],
})
export class ChatPaneComponent implements OnDestroy {
  private readonly convList = inject(ConversationListService);
  private readonly router = inject(Router);

  /** The thread the shell has marked open (URL-driven; sole writer is the home shell). */
  readonly openThreadId = this.convList.openThreadId;
  readonly active = computed(() => this.openThreadId() !== undefined);

  private readonly search = inject(SearchService);
  /** A search-hit message id to center the kernel on — but only when the open thread IS that hit's
   *  thread, so a stale value from a prior hit on another thread is masked out. Bound to both panes'
   *  <app-message-thread [startMsgId]>: init passes it to kernel openAround, a same-thread change to
   *  scrollToIndex. Cleared after the jump (onReady for a switch, a timer for same-thread) so
   *  re-opening the thread from the list doesn't re-jump to an old hit. */
  readonly startMsgId = computed(() => {
    const p = this.search.pendingJump();
    const tid = this.openThreadId();
    return p && tid === p.threadId ? p.msgId : undefined;
  });

  /** Each slot holds the threadId its pane is bound to (undefined → empty, no kernel). The LIVE
   *  ConversationItem is DERIVED from the conv list by that id, so per-user state (mute/pin/block/clear)
   *  updated via applyThreadMeta flows into the bound MessageThreadComponent without a re-switch — the
   *  header's toggle labels + the blocked banner reflect the current state, not a switch-time snapshot. */
  private readonly slotA = signal<number | undefined>(undefined);
  private readonly slotB = signal<number | undefined>(undefined);
  readonly itemA = computed(() => {
    const tid = this.slotA();
    return tid === undefined ? undefined : this.convList.items().find((t) => t.threadId === tid);
  });
  readonly itemB = computed(() => {
    const tid = this.slotB();
    return tid === undefined ? undefined : this.convList.items().find((t) => t.threadId === tid);
  });

  /** Which pane is foreground — the SOLE driver of the `.pane-fg` class (and thus visibility). Flipped
   *  synchronously in `promote()`; never lags an animation. */
  readonly fgSlot = signal<SlotKey>('A');
  /** Foreground pane's item — gates the first-load spinner overlay. */
  readonly fgItem = computed(() => (this.fgSlot() === 'A' ? this.itemA() : this.itemB()));

  private readonly threadA = viewChild('threadA', { read: MessageThreadComponent });
  private readonly threadB = viewChild('threadB', { read: MessageThreadComponent });
  private readonly layerA = viewChild('layerA', { read: ElementRef<HTMLElement> });
  private readonly layerB = viewChild('layerB', { read: ElementRef<HTMLElement> });

  /** The in-flight switch: which background pane is being awaited + the target thread it must report. */
  private pending?: { targetId: number; bgKey: SlotKey };
  private pendingTimer?: ReturnType<typeof setTimeout>;
  /** Idles a backgrounded slot's kernel once the cross-fade has finished (one-shot; re-armed per promote). */
  private teardownTimer?: ReturnType<typeof setTimeout>;
  /** Active circular-reveal animation per layer (incoming only; the outgoing pane fades purely in CSS, so it
   *  owns no WAAPI that could linger). Tracked so it can be canceled deterministically on the next promote —
   *  never `getAnimations()` guesswork. `fill:'none'` ⇒ reverts to the CSS resting clip-path (none) on
   *  finish, so nothing outlives its purpose to reassert over a live foreground. */
  private animA?: Animation;
  private animB?: Animation;
  /** At most one list reload per missing thread (deep-link / just-joined resolve). */
  private loadAttemptedFor?: number;
  private readonly reducedMotion = prefersReducedMotion();

  constructor() {
    // The switch coordinator: read the target + the current foreground's item, hand the target to the
    // background pane to reset (hidden), await ready, then promote.
    effect(() => {
      const target = this.openThreadId();
      const fgKey = this.fgSlot();
      const fgTid = fgKey === 'A' ? this.slotA() : this.slotB();

      if (target === undefined) {
        // CLOSE: cancel any in-flight swap and idle the foreground kernel. The pane-empty overlay (gated on
        // !active()) covers the torn-down pane.
        this.clearPending();
        this.clearTeardown();
        (fgKey === 'A' ? this.threadA() : this.threadB())?.teardownKernel();
        this.loadAttemptedFor = undefined;
        return;
      }
      if (fgTid === target) {
        // Already showing the target: a prior click's in-flight background swap is now stale. Cancel it so
        // its (possibly slow or hung) init cannot later promote a thread the user already moved away from
        // (and so its hung-fetch fallback timer can't fire on it).
        this.clearPending();
        return;
      }

      const item = this.convList.items().find((t) => t.threadId === target);
      if (!item) {
        // Deep-link / just-joined thread not yet in the list: one reload, then bail if still absent.
        if (this.convList.status() !== 'READY') return;
        if (this.loadAttemptedFor !== target) {
          this.loadAttemptedFor = target;
          this.convList.load();
        } else {
          void this.router.navigate(['/']);
        }
        return;
      }
      this.loadAttemptedFor = target;

      // Hand the target to the BACKGROUND pane — its MessageThreadComponent effect tears down + re-inits
      // (reset) while hidden; we await `ready` (onReady) before promoting it. The slot stores the threadId;
      // itemA/itemB derive the live ConversationItem from the conv list.
      const bgKey: SlotKey = fgKey === 'A' ? 'B' : 'A';
      this.armPending(target, bgKey);
      (bgKey === 'A' ? this.slotA : this.slotB).set(target);
    });

    // Same-thread search jump (no pane switch): MessageThread's startMsgId effect runs scrollToIndex,
    // which — unlike a switch — does not route through onReady. Clear the pending jump on a timer so it
    // can't linger and re-fire when the user later re-opens this thread from the list. Cross-thread
    // jumps are cleared in onReady (the switch path); this timer only covers the already-on-thread case
    // (and is harmless when onReady already cleared it — consumeJump is idempotent).
    effect(() => {
      const p = this.search.pendingJump();
      if (!p) return;
      const fgTid = this.fgSlot() === 'A' ? this.slotA() : this.slotB();
      if (fgTid === p.threadId) {
        setTimeout(() => this.search.consumeJump(), 800);
      }
    });
  }

  /** `ready` from a pane's kernel — promote it if it matches the in-flight switch, else ignore (stale). */
  onReady(key: SlotKey, tid: number): void {
    const p = this.pending;
    if (!p || p.bgKey !== key || p.targetId !== tid) return;
    this.promote(key);
    // A cross-thread search jump lands here: the bg pane's init already read startMsgId and ran
    // openAround, so it's safe to clear the pending hit. Microtask deferral keeps the value visible
    // through the current change-detection pass before it's cleared.
    if (this.search.pendingJump()?.threadId === tid) {
      queueMicrotask(() => this.search.consumeJump());
    }
  }

  ngOnDestroy(): void {
    this.clearPending();
    this.clearTeardown();
    this.cancelSlotAnim('A');
    this.cancelSlotAnim('B');
  }

  private armPending(targetId: number, bgKey: SlotKey): void {
    this.clearPending();
    this.pending = { targetId, bgKey };
    this.pendingTimer = setTimeout(() => {
      // Hung-fetch fallback: force-promote rather than strand the UI on the old pane forever.
      if (this.pending?.targetId === targetId && this.pending.bgKey === bgKey) this.promote(bgKey);
    }, PROMOTE_TIMEOUT_MS);
  }

  private clearPending(): void {
    this.pending = undefined;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }

  private clearTeardown(): void {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = undefined;
    }
  }

  /** Commit a switch: flip `fgSlot` synchronously (the `.pane-fg` class swap drives a pure-CSS opacity
   *  cross-fade — idempotent, nothing to leak), AND run a tracked circular clip-path reveal on the INCOMING
   *  pane so new content opens with the same circle-expand motion as the group-join hero. The reveal is the
   *  ONLY WAAPI here — the outgoing pane dissolves purely in CSS, so there is no fire-and-forget fade-out
   *  that could linger and reassert `opacity:0` over a later foreground (the original blank bug). The reveal
   *  uses `fill:'none'` (reverts to the CSS resting clip-path on finish) and is held as a tracked reference,
   *  canceled on the next promote. Then schedule the outgoing kernel's teardown past the fade. */
  private promote(key: SlotKey): void {
    this.clearPending();
    const oldFg = this.fgSlot();
    if (key === oldFg) return; // already foreground — CSS already shows it, nothing to cross-fade
    this.fgSlot.set(key); // CSS: outgoing fades out (opacity + delayed visibility), incoming fades in
    const incoming = (key === 'A' ? this.layerA() : this.layerB())?.nativeElement;
    if (incoming && !this.reducedMotion) {
      // Cancel any in-flight reveal on either layer first (deterministic, tracked — not getAnimations()).
      this.cancelSlotAnim('A');
      this.cancelSlotAnim('B');
      const rect = incoming.getBoundingClientRect();
      const fullR = Math.hypot(rect.width, rect.height) / 2;
      const reveal = incoming.animate(
        [
          { clipPath: `circle(${START_RADIUS}px at 50% 50%)` },
          { clipPath: `circle(${fullR}px at 50% 50%)` },
        ],
        { duration: ENTER_MS, easing: `cubic-bezier(${EASING.join(',')})`, fill: 'none' },
      );
      if (key === 'A') this.animA = reveal; else this.animB = reveal;
    }
    this.scheduleKernelTeardown(oldFg);
  }

  private cancelSlotAnim(slot: SlotKey): void {
    const a = slot === 'A' ? this.animA : this.animB;
    if (a) {
      a.cancel();
      if (slot === 'A') this.animA = undefined; else this.animB = undefined;
    }
  }

  /** Idle a backgrounded slot's kernel after the cross-fade. Idempotent: re-armed per promote, and the
   *  callback only tears down the slot if it is STILL background by the time it fires (a later promote may
   *  have re-foregrounded it). Binds memory + SSE to one warm pane without ever idling the live foreground. */
  private scheduleKernelTeardown(slot: SlotKey): void {
    this.clearTeardown();
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = undefined;
      if (this.fgSlot() !== slot) {
        (slot === 'A' ? this.threadA() : this.threadB())?.teardownKernel();
      }
    }, ENTER_MS + 60);
  }
}
