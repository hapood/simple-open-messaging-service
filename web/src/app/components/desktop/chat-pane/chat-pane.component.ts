import {
  Component,
  computed,
  effect,
  inject,
  ElementRef,
  isDevMode,
  OnDestroy,
  signal,
  untracked,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { NavStateMachineService } from '../../../services/nav-state.service';
import { LayoutService } from '../../../services/layout.service';
import { NativeComposerService } from '../../../services/native-composer.service';
import { prefersReducedMotion } from '../../../lib/motion-utils';
import type { ConversationItem } from '../../../services/model';

/** Celebratory group-join reveal duration (ms). Ordinary thread changes use the shorter CSS dissolve. */
const GROUP_JOIN_REVEAL_MS = 300;
/** Cross-fade duration (ms) — also the grace period before a backgrounded pane's kernel is idled, so its
 *  content stays visible through the dissolve. Kept in sync with `--pane-fade-ms` in the styles below. */
const ENTER_MS = 150;
/** Easing + start radius for the circular clip-path reveal reserved for a successful group join. */
const EASING = [0.32, 0.72, 0, 1];
const START_RADIUS = 40;
type SlotKey = 'A' | 'B';

/**
 * A/B double-buffered chat pane. Two `MessageThreadComponent` instances stay mounted as stacked absolute
 * layers; one is FOREGROUND (visible) and one is BACKGROUND (rendered but `opacity:0` + `visibility:hidden`,
 * so its kernel keeps measuring layout correctly — `display:none` would zero `offsetHeight`/`scrollHeight`
 * and break the kernel, which measures layout not paint).
 *
 * A switch never races a kernel init: the target thread is bound to the BACKGROUND instance, whose own
 * constructor effect runs `teardown() + initScroller()` (reset) while hidden; when its kernel emits `ready`,
 * the pane is promoted to foreground and the old foreground's kernel is IDLED (`teardownKernel`: teardown +
 * reset `currentTrdId`; the COMPONENT STAYS MOUNTED — panes are never destroyed on a switch, only reset)
 * after the cross-fade — bounding memory + SSE to one warm pane. Re-selecting a thread already bound to a
 * (possibly idled) pane cannot rely on that input-keyed init effect (its `userMsgTrd` is unchanged, so it
 * won't re-fire), so the coordinator drives the pane's `reset()` explicitly: warm → `ready` now (instant
 * fast-flip-back); cold → reinit → `ready`.
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
 * The target comes from `ConversationListService.openThreadId` (driven by NavStateMachineService via the
 * home shell). This component is always-mounted as a direct child of HomeShell (NO router, NO route-reuse
 * strategy) — the kernel never remounts on open/close.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, ChatEmptyComponent, TranslocoPipe],
  template: `
    <div class="chat-pane" [class.compact]="isCompact()">
      <div class="pane-layer" [class.pane-fg]="fgSlot() === 'A'" #layerA>
        @if (itemA(); as trd) {
          <app-message-thread
            #threadA
            [threadId]="trd.threadId"
            [userMsgTrd]="trd"
            [nativeComposerActive]="active() && fgSlot() === 'A'"
            (ready)="onReady('A', $event)"
          />
        }
      </div>
      <div class="pane-layer" [class.pane-fg]="fgSlot() === 'B'" #layerB>
        @if (itemB(); as trd) {
          <app-message-thread
            #threadB
            [threadId]="trd.threadId"
            [userMsgTrd]="trd"
            [nativeComposerActive]="active() && fgSlot() === 'B'"
            (ready)="onReady('B', $event)"
          />
        }
      </div>
      @if (!active()) {
        <div class="pane-empty"><app-chat-empty /></div>
      } @else if (showLoading()) {
        <div
          class="pane-loading"
          role="status"
          aria-live="polite"
          [attr.aria-label]="'chat.loading' | transloco"
        >
          <svg class="spinner" viewBox="0 0 80 80" aria-hidden="true">
            <circle
              class="spin-track"
              cx="40"
              cy="40"
              r="34"
              pathLength="100"
            />
            <circle class="spin-arc" cx="40" cy="40" r="34" pathLength="100" />
          </svg>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .chat-pane {
        --pane-fade-ms: 150ms;
        /* Demote (fg→bg) duration. Equals the fade on desktop/tablet (a graceful dissolve is part of the
         chatpane<->chatpane cross-fade there); 0s on compact — see the .compact override below. */
        --pane-demote-ms: var(--pane-fade-ms);
        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        /* Solid ground behind both panes — shown through the outgoing pane as it dissolves. */
        background: var(--app-chat-pane-bg);
      }
      @media (prefers-reduced-motion: reduce) {
        .chat-pane {
          --pane-fade-ms: 0ms;
        }
      }
      /* Mobile loading is spinner↔chatpane, NOT chatpane↔chatpane: the OUTGOING pane was hidden behind the
       spinner a moment ago, so dissolving it into the incoming one only re-reveals stale content (the two-pane
       blend). Snap it away instantly — only the demote direction; the incoming pane still fades in via
       .pane-fg, so the handoff reads as spinner → new chatpane, never two chatpanes on screen at once. */
      .chat-pane.compact {
        --pane-demote-ms: 0s;
      }
      /* Two stacked panes, each absolute inset:0 so BOTH keep real layout (offsetHeight) even while the
       background one is hidden. Default = BACKGROUND resting state: invisible + behind (z1). */
      .pane-layer {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--app-chat-pane-bg);
        opacity: 0;
        visibility: hidden;
        z-index: 1;
        /* Demote (fg→bg) fades opacity out over --pane-demote-ms, THEN flips visibility to hidden after that
         same delay so the dissolving pane stays paintable through the fade (on compact the delay is 0s → the
         outgoing pane is gone at once, since the spinner already covered the handoff). */
        transition:
          opacity var(--pane-demote-ms) cubic-bezier(0.32, 0.72, 0, 1),
          visibility 0s linear var(--pane-demote-ms);
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
      .pane-layer > app-message-thread {
        display: block;
        flex: 1 1 auto;
        min-height: 0;
      }
      /* Overlays sit at the foreground's z-index (2) but later in DOM order, so they paint above the
       foreground pane — whether that pane is empty (cold start) or still holds stale outgoing content (a
       compact switch in flight, covered until the incoming pane promotes). */
      .pane-empty,
      .pane-loading {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        flex-direction: column;
      }
      .pane-empty > app-chat-empty {
        display: block;
        flex: 1 1 auto;
        min-height: 0;
      }
      /* Opaque so the loading surface occludes a stale outgoing pane on compact. The indicator itself waits
       200ms: normal warm opens finish before that threshold and therefore never flash a loading glyph. A
       genuinely cold open gets a small, quiet indicator slightly above optical center instead of dragging
       the old 80px full-page spinner through the route transition. */
      .pane-loading {
        box-sizing: border-box;
        background: var(--app-chat-pane-bg);
        align-items: center;
        justify-content: center;
        padding-bottom: 12vh;
      }
      .spinner {
        width: 28px;
        height: 28px;
        animation:
          chat-pane-spin 0.9s linear infinite,
          chat-pane-spinner-in 100ms ease 200ms both;
      }
      .spin-track {
        fill: none;
        stroke: var(--app-border);
        stroke-width: 6;
        opacity: 0.45;
      }
      .spin-arc {
        fill: none;
        stroke: var(--app-brand);
        stroke-width: 6;
        stroke-linecap: round;
        stroke-dasharray: 60 100;
      }
      @keyframes chat-pane-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes chat-pane-spinner-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: chat-pane-spinner-in 0ms linear 200ms both;
        }
      }
    `,
  ],
})
export class ChatPaneComponent implements OnDestroy {
  private readonly convList = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);
  private readonly nativeComposer = inject(NativeComposerService);

  /** The thread the shell has marked open (URL-driven; sole writer is the home shell). */
  readonly openThreadId = this.convList.openThreadId;
  readonly active = computed(() => this.openThreadId() !== undefined);

  /** Compact layout flag — drives the `.compact` host class and the compact branch of {@link showLoading}.
   *  Template-facing alias of the (private) LayoutService so the template never reaches past the component
   *  boundary — mirrors the `convList`→`openThreadId` alias pattern below. */
  readonly isCompact = computed(() => this.layout.mode() === 'compact');

  /** Each slot holds the threadId its pane is bound to (undefined → empty, no kernel). The LIVE
   *  ConversationItem is DERIVED from the conv list by that id, so per-user state (mute/pin/block)
   *  updated via applyThreadMeta flows into the bound MessageThreadComponent without a re-switch — the
   *  header's toggle labels + the blocked banner reflect the current state, not a switch-time snapshot. */
  private readonly slotA = signal<number | undefined>(undefined);
  private readonly slotB = signal<number | undefined>(undefined);
  readonly itemA = computed(() => {
    const tid = this.slotA();
    return tid === undefined
      ? undefined
      : this.convList.items().find((t) => t.threadId === tid);
  });
  readonly itemB = computed(() => {
    const tid = this.slotB();
    return tid === undefined
      ? undefined
      : this.convList.items().find((t) => t.threadId === tid);
  });

  /** Which pane is foreground — the SOLE driver of the `.pane-fg` class (and thus visibility). Flipped
   *  synchronously in `promote()`; never lags an animation. */
  readonly fgSlot = signal<SlotKey>('A');
  /** Foreground pane's item — gates the first-load spinner overlay (medium/expanded). */
  readonly fgItem = computed(() =>
    this.fgSlot() === 'A' ? this.itemA() : this.itemB(),
  );

  /** Whether the pane-level loading spinner shows. Mode-split, matching `overlaySlide` (compact-only):
   *  the mobile slide-in physically drags whatever pane is foreground into view, so on compact the spinner
   *  must cover the OUTGOING thread whenever a switch is in flight (foreground slot ≠ open thread) — otherwise
   *  re-opening a chat after a close slides the stale previous thread (old header + body) in, then cross-fades
   *  to the new one. Medium/expanded have no slide: the outgoing pane sits still and cross-fades (the
   *  double-buffer's designed dissolve), so they keep the cold-start-only gate and never flash a spinner on a
   *  warm switch. */
  readonly showLoading = computed(() => {
    if (!this.active()) return false;
    if (this.isCompact()) {
      const fgId = this.fgSlot() === 'A' ? this.slotA() : this.slotB();
      return fgId !== this.openThreadId();
    }
    return !this.fgItem();
  });

  // No `{ read: MessageThreadComponent }` — for a component element the default read already yields the
  // component instance (the explicit `read` is redundant), and omitting it lets tests stub `app-message-thread`
  // with a lighter stand-in (the strict `read` would return undefined for a non-matching type).
  private readonly threadA = viewChild<MessageThreadComponent>('threadA');
  private readonly threadB = viewChild<MessageThreadComponent>('threadB');
  private readonly layerA = viewChild('layerA', {
    read: ElementRef<HTMLElement>,
  });
  private readonly layerB = viewChild('layerB', {
    read: ElementRef<HTMLElement>,
  });

  /** The in-flight switch: which background pane is being awaited + the target thread it must report. */
  private pending?: { targetId: number; bgKey: SlotKey; startedAt: number };
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
        this.nativeComposer.hideActive();
        // CLOSE: cancel any in-flight swap and IDLE the foreground kernel (teardown + reset currentTrdId),
        // keeping the component mounted. The pane-empty overlay (gated on !active()) covers it. On mobile
        // this runs AFTER the leave-slide (onSlideDone → convList.close), so the pane keeps its content
        // through the slide; on desktop there is no slide.
        this.clearPending();
        this.clearTeardown();
        untracked(() =>
          (fgKey === 'A' ? this.threadA() : this.threadB())?.teardownKernel(),
        );
        this.loadAttemptedFor = undefined;
        return;
      }
      if (fgTid === target) {
        // Foreground already bound to target. Two cases, told apart by the pane's warmth: (a) the common
        // one — the pane just became foreground via promote, or the user re-clicked the open thread — it is
        // WARM, so there is nothing to do; (b) the pane is COLD (a close idled its kernel, then the same
        // thread was re-opened) — drive `reset()` to re-initialize in place. Without the warmth guard, every
        // promote (which flips fgSlot and re-triggers this effect) would spuriously reset an already-warm
        // foreground pane on every switch. The pane stays foreground in both cases.
        const fg = untracked(
          fgKey === 'A' ? () => this.threadA() : () => this.threadB(),
        );
        this.clearPending();
        if (fg && !untracked(() => fg.isWarm())) {
          this.armPending(target, fgKey);
          untracked(() => fg.reset());
        }
        return;
      }

      // Navigation has already selected another conversation. Remove the outgoing composer now instead of
      // keeping it alive until the background pane finishes loading and is promoted.
      this.nativeComposer.hideActive();

      const bgKey: SlotKey = fgKey === 'A' ? 'B' : 'A';
      // Is the target already bound to the BACKGROUND pane? Read UNTRACKED: the fresh-bind `slot.set` below
      // writes the bg slot, and if this read tracked it, the effect would re-run, hit this branch on the
      // next pass, and double-drive `reset()` on a pane whose init effect is already firing.
      const bgTid = untracked(
        bgKey === 'A' ? () => this.slotA() : () => this.slotB(),
      );
      if (bgTid === target) {
        // Background resident (warm mid-dissolve, or cold after the post-promote idle): the slot already
        // holds target, so a `slot.set` would be a signal no-op and the pane's input-keyed init effect
        // would NOT re-fire — `ready` would never emit and the switch would strand. Drive `reset()`
        // explicitly (warm → ready now, preserving the instant fast-flip-back; cold → reinit → ready); the
        // emitted `ready` (onReady) promotes it with the cross-fade.
        this.armPending(target, bgKey);
        untracked(() =>
          (bgKey === 'A' ? this.threadA() : this.threadB())?.reset(),
        );
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
          this.nav.closeChat();
        }
        return;
      }
      this.loadAttemptedFor = target;

      // Fresh bind: assign target to the background slot. The slot value (and thus the bound
      // ConversationItem) changes, so the always-mounted pane's input-keyed init effect re-fires — it tears
      // down + re-inits (reset) while hidden, then emits `ready` (onReady) → promote. The slot stores the
      // threadId; itemA/itemB derive the live ConversationItem from the conv list, so per-user meta
      // (mute/pin/block/clear) flows in without a re-switch.
      this.armPending(target, bgKey);
      (bgKey === 'A' ? this.slotA : this.slotB).set(target);
    });
  }

  /** `ready` from a pane's kernel — promote it if it matches the in-flight switch, else ignore (stale). */
  onReady(key: SlotKey, tid: number): void {
    const p = this.pending;
    if (!p || p.bgKey !== key || p.targetId !== tid) return;
    this.perfLog('pane:ready', {
      threadId: tid,
      slot: key,
      elapsedMs: Math.round(performance.now() - p.startedAt),
    });
    this.promote(key);
  }

  ngOnDestroy(): void {
    this.clearPending();
    this.clearTeardown();
    this.cancelSlotAnim('A');
    this.cancelSlotAnim('B');
  }

  private armPending(targetId: number, bgKey: SlotKey): void {
    this.clearPending();
    this.pending = { targetId, bgKey, startedAt: performance.now() };
    this.perfLog('pane:init', { threadId: targetId, slot: bgKey });
  }

  private clearPending(): void {
    this.pending = undefined;
  }

  private clearTeardown(): void {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = undefined;
    }
  }

  /** Commit a switch: flip `fgSlot` synchronously (the `.pane-fg` class swap drives a short pure-CSS
   *  cross-fade — idempotent, nothing to leak). Only a successful group join runs the tracked circular
   *  clip-path reveal on the incoming pane. The reveal is the ONLY WAAPI here — the outgoing pane dissolves
   *  purely in CSS, so there is no fire-and-forget fade-out
   *  that could linger and reassert `opacity:0` over a later foreground (the original blank bug). The reveal
   *  uses `fill:'none'` (reverts to the CSS resting clip-path on finish) and is held as a tracked reference,
   *  canceled on the next promote. Then schedule the outgoing kernel's teardown past the fade. */
  private promote(key: SlotKey): void {
    const pending = this.pending;
    this.clearPending();
    const oldFg = this.fgSlot();
    if (key === oldFg) return; // already foreground — CSS already shows it, nothing to cross-fade
    this.perfLog('animation:start', {
      threadId: pending?.targetId,
      fromSlot: oldFg,
      toSlot: key,
      elapsedMs:
        pending === undefined
          ? undefined
          : Math.round(performance.now() - pending.startedAt),
    });
    this.fgSlot.set(key); // CSS: outgoing fades out (opacity + delayed visibility), incoming fades in
    const incoming = (key === 'A' ? this.layerA() : this.layerB())
      ?.nativeElement;
    const transition = pending
      ? this.nav.consumeChatTransition(pending.targetId)
      : 'standard';
    if (transition === 'group-joined' && incoming && !this.reducedMotion) {
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
        {
          duration: GROUP_JOIN_REVEAL_MS,
          easing: `cubic-bezier(${EASING.join(',')})`,
          fill: 'none',
        },
      );
      if (key === 'A') this.animA = reveal;
      else this.animB = reveal;
    }
    this.scheduleKernelTeardown(oldFg);
  }

  private perfLog(event: string, detail: Record<string, unknown>): void {
    if (isDevMode()) console.log(`[chat-perf] ${event}`, detail);
  }

  private cancelSlotAnim(slot: SlotKey): void {
    const a = slot === 'A' ? this.animA : this.animB;
    if (a) {
      a.cancel();
      if (slot === 'A') this.animA = undefined;
      else this.animB = undefined;
    }
  }

  /** Idle a backgrounded slot's kernel after the cross-fade. Once the outgoing pane has fully dissolved,
   *  call `teardownKernel()` on it (teardown + reset `currentTrdId`): the COMPONENT STAYS MOUNTED, only its
   *  kernel + SSE are released, bounding memory + SSE to the one warm foreground pane. The slot keeps its
   *  threadId (so the pane re-binds instantly on a later re-selection via `reset()`); only `currentTrdId`
   *  is cleared, which is what marks the kernel cold. Idempotent: re-armed per promote, and the callback
   *  only idles the slot if it is STILL background by the time it fires (a later promote — including the
   *  warm-resident fast-flip-back — may have re-foregrounded it). */
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
