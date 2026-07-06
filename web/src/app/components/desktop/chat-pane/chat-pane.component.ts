import { Component, computed, effect, ElementRef, inject, OnDestroy, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { LayoutService } from '../../../services/layout.service';
import { prefersReducedMotion } from '../../../lib/motion-utils';
import type { ConversationItem } from '../../../services/model';

/** Enter timing + reveal shape — match the app's overlaySlide / dialogAnim rhythm. */
const ENTER_MS = 300;
const EASING = [0.32, 0.72, 0, 1];
/** Starting radius (px) of the circular reveal window centered on the pane. */
const START_RADIUS = 40;
/** Force-promote fallback if a background init stalls (hung fetch). */
const PROMOTE_TIMEOUT_MS = 3000;

type SlotKey = 'A' | 'B';

/**
 * A/B double-buffered chat pane. Two `MessageThreadComponent` instances stay mounted inside `.chat-slot`
 * as stacked absolute layers; at any moment one is FOREGROUND (visible) and one is BACKGROUND (rendered
 * but `visibility:hidden` + `opacity:0`, so its kernel keeps measuring layout correctly — `display:none`
 * would zero `offsetHeight`/`scrollHeight` and break the kernel, which measures layout not paint).
 *
 * A switch never races a kernel init: the target thread is bound to the BACKGROUND instance, whose own
 * constructor effect runs `teardown() + initScroller()` (reset) while hidden; when its kernel emits
 * `ready`, the pane is promoted to foreground with a circular clip-path reveal, and the old foreground
 * is demoted + its kernel idled (`teardownKernel`) — bounding memory + SSE to one warm pane.
 *
 * Layer visual state (visibility/opacity/z-index/clip-path) is driven by INLINE styles from
 * promote/demote, NOT CSS classes, so the WAAPI reveal owns the DOM state synchronously without waiting
 * for zoneless change detection (which would otherwise gap between `anim.cancel()` and the class swap).
 *
 * The target comes from `ConversationListService.openThreadId` (URL-driven; sole writer is the home
 * shell). This component is route-reused (`ChatReuseStrategy`) and never remounted.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, ChatEmptyComponent],
  template: `
    <div class="chat-pane">
      <div class="pane-layer" #layerA>
        @if (itemA(); as trd) {
          <app-message-thread #threadA [threadId]="trd.threadId" [userMsgTrd]="trd" (ready)="onReady('A', $event)" />
        }
      </div>
      <div class="pane-layer" #layerB>
        @if (itemB(); as trd) {
          <app-message-thread #threadB [threadId]="trd.threadId" [userMsgTrd]="trd" (ready)="onReady('B', $event)" />
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
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      /* Solid ground shown through the clip-path's transparent outside during a circle reveal: the old
         foreground pane is hidden mid-reveal so its wallpaper doesn't show through — the circle then opens
         the incoming pane's wallpaper + content together instead of over an always-on wallpaper. */
      background: var(--app-surface);
    }
    /* Two stacked panes, each absolute inset:0 so BOTH keep real layout (offsetHeight) even while the
       background one is hidden. fg/bg visibility is set via inline styles (see markFg/markBg). The
       background is on the layer (not .chat-pane) so the reveal clip shapes it too. */
    .pane-layer {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--app-surface);
    }
    .pane-layer > app-message-thread { display: block; flex: 1 1 auto; min-height: 0; }
    /* Overlays sit at z-index 2 (same as a foreground pane) but later in DOM order, so they paint above
       an empty foreground; a revealing pane is raised to z-index 3 (inline) to cover them. */
    .pane-empty, .pane-loading {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
    }
    .pane-empty > app-chat-empty { display: block; flex: 1 1 auto; min-height: 0; }
    .pane-loading { align-items: center; justify-content: center; }
    /* 80px = START_RADIUS*2 — matches the reveal's starting circle (clip-path circle(40px)), so the
       transparent disc lands on the spinner and content expands out from it as the pane reveals. */
    .spinner { width: 80px; height: 80px; animation: chat-pane-spin 0.9s linear infinite; }
    .spin-track { fill: none; stroke: var(--app-border); stroke-width: 5; opacity: 0.5; }
    .spin-arc { fill: none; stroke: var(--app-brand); stroke-width: 5; stroke-linecap: round; stroke-dasharray: 60 100; }
    @keyframes chat-pane-spin { to { transform: rotate(360deg); } }
  `],
})
export class ChatPaneComponent implements OnDestroy {
  private readonly convList = inject(ConversationListService);
  private readonly router = inject(Router);
  private readonly layout = inject(LayoutService);

  /** The thread the shell has marked open (URL-driven; sole writer is the home shell). */
  readonly openThreadId = this.convList.openThreadId;
  readonly active = computed(() => this.openThreadId() !== undefined);

  /** Each slot holds the ConversationItem its pane is bound to. undefined → pane empty (no kernel). */
  private readonly slotA = signal<{ item: ConversationItem | undefined }>({ item: undefined });
  private readonly slotB = signal<{ item: ConversationItem | undefined }>({ item: undefined });
  readonly itemA = computed(() => this.slotA().item);
  readonly itemB = computed(() => this.slotB().item);

  /** Which pane is foreground. Drives the switch effect's logic; visual state is inline-styled. */
  readonly fgSlot = signal<SlotKey>('A');
  /** Foreground pane's item — gates the first-load spinner overlay. */
  readonly fgItem = computed(() => (this.fgSlot() === 'A' ? this.slotA() : this.slotB()).item);

  private readonly threadA = viewChild('threadA', { read: MessageThreadComponent });
  private readonly threadB = viewChild('threadB', { read: MessageThreadComponent });
  private readonly layerA = viewChild('layerA', { read: ElementRef<HTMLElement> });
  private readonly layerB = viewChild('layerB', { read: ElementRef<HTMLElement> });

  /** The in-flight switch: which background pane is being awaited + the target thread it must report. */
  private pending?: { targetId: number; bgKey: SlotKey };
  private pendingTimer?: ReturnType<typeof setTimeout>;
  /** One-shot guard: initialize the two layers' visual state once viewChildren resolve. */
  private layersInit = false;
  /** At most one list reload per missing thread (deep-link / just-joined resolve). */
  private loadAttemptedFor?: number;
  private readonly reducedMotion = prefersReducedMotion();

  constructor() {
    // Seed layer A=foreground / B=background once both render (runs once, guarded on layersInit).
    effect(() => {
      const a = this.layerA();
      const b = this.layerB();
      if (!a || !b || this.layersInit) return;
      this.layersInit = true;
      this.markFg(a.nativeElement);
      this.markBg(b.nativeElement);
    });

    // The switch coordinator: read the target + the current foreground's item, hand the target to the
    // background pane to reset (hidden), await ready, then promote.
    effect(() => {
      const target = this.openThreadId();
      const fgKey = this.fgSlot();
      const fgItem = (fgKey === 'A' ? this.slotA() : this.slotB()).item;

      if (target === undefined) {
        // CLOSE: cancel any in-flight swap and idle the foreground kernel (keep one warm pane bound).
        this.clearPending();
        (fgKey === 'A' ? this.threadA() : this.threadB())?.teardownKernel();
        this.loadAttemptedFor = undefined;
        return;
      }
      if (fgItem?.threadId === target) return; // already showing it

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
      // (reset) while hidden; we await `ready` (onReady) before promoting it.
      const bgKey: SlotKey = fgKey === 'A' ? 'B' : 'A';
      this.armPending(target, bgKey);
      (bgKey === 'A' ? this.slotA : this.slotB).set({ item });
    });
  }

  /** `ready` from a pane's kernel — promote it if it matches the in-flight switch, else ignore (stale). */
  onReady(key: SlotKey, tid: number): void {
    const p = this.pending;
    if (!p || p.bgKey !== key || p.targetId !== tid) return;
    this.promote(key);
  }

  ngOnDestroy(): void {
    this.clearPending();
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

  /** Cross-fade the background pane in (circular clip-path reveal), then demote the old foreground. */
  private promote(key: SlotKey): void {
    this.clearPending();
    const oldFg = this.fgSlot();
    const incoming = (key === 'A' ? this.layerA() : this.layerB())?.nativeElement;
    const oldLayer = (oldFg === 'A' ? this.layerA() : this.layerB())?.nativeElement;
    if (!incoming || this.reducedMotion) {
      // No element yet (first paint) or reduced motion → snap.
      if (incoming) this.markFg(incoming);
      this.fgSlot.set(key);
      this.demote(oldFg);
      return;
    }
    this.layout.freezeReflow();
    // Cross-fade the old foreground out over the same beat: its wallpaper + content dissolve together, so
    // the clip-path's transparent outside lands on .chat-pane's solid ground (not a still-opaque old
    // wallpaper) and the circle opens the incoming wallpaper + content cleanly. demote() snaps the old
    // pane to its resting bg state + tears its kernel down on finish.
    if (oldLayer) {
      oldLayer.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: ENTER_MS, easing: `cubic-bezier(${EASING.join(',')})`, fill: 'forwards' },
      );
    }
    const rect = incoming.getBoundingClientRect();
    const fullR = Math.hypot(rect.width, rect.height) / 2;
    // Seed: visible, raised above the old fg (z3 > fg z2), clipped to a small centered disc, transparent.
    incoming.style.visibility = 'visible';
    incoming.style.zIndex = '3';
    incoming.style.clipPath = `circle(${START_RADIUS}px at 50% 50%)`;
    incoming.style.opacity = '0';
    const anim = incoming.animate(
      [
        { opacity: 0, clipPath: `circle(${START_RADIUS}px at 50% 50%)` },
        { opacity: 1, clipPath: `circle(${fullR}px at 50% 50%)` },
      ],
      { duration: ENTER_MS, easing: `cubic-bezier(${EASING.join(',')})`, fill: 'forwards' },
    );
    anim.onfinish = () => {
      anim.cancel(); // drop fill:forwards so the inline styles below own the resting state with no override
      this.markFg(incoming); // visibility visible, opacity 1, z-index 2, clipPath ''
      this.fgSlot.set(key);
      this.demote(oldFg);
      this.layout.thawReflow();
    };
  }

  /** Send a pane to the background and idle its kernel (bounds memory + SSE to one warm pane). */
  private demote(key: SlotKey): void {
    const layer = (key === 'A' ? this.layerA() : this.layerB())?.nativeElement;
    if (layer) this.markBg(layer);
    (key === 'A' ? this.threadA() : this.threadB())?.teardownKernel();
  }

  private markFg(el: HTMLElement): void {
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.style.zIndex = '2';
    el.style.clipPath = '';
  }
  private markBg(el: HTMLElement): void {
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    el.style.zIndex = '1';
    el.style.clipPath = '';
  }
}
