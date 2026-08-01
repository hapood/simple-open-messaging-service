import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { DebugToolsService } from '../../services/debug-tools.service';
import { DebugLogOverlayComponent } from './debug-log-overlay.component';

/**
 * The floating trigger for the debug log panel. Rendered only while {@link DebugToolsService.enabled} is
 * true (dev builds, or production after the hidden entry flipped it). Mounts the overlay on demand via
 * `@if`, so the (heavier) overlay + its refresh interval only exist while open.
 *
 * Fixed at the viewport center initially, at z-index 1200 — above every production overlay (lightbox 1100)
 * so it stays reachable
 * while debugging a modal/lightbox state. The button is a small fixed element (not a full-screen layer), so
 * it never intercepts content clicks; the overlay (its sibling) is a separate fixed layer that does.
 *
 * **Drag-to-move:** the FAB is also draggable so it can be parked out of the way. This reuses the
 * compositor-only translate pattern from {@link DebugLogOverlayComponent} — `transform` only, never
 * `left`/`top`/`position`, geometry read once at pointerdown, moves coalesced through one rAF. A 5 px
 * activation threshold disambiguates a drag from a tap for positioning. The position persists in-memory
 * for the session (the FAB stays mounted in the app shell).
 */
@Component({
  selector: 'app-debug-log-fab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DebugLogOverlayComponent],
  template: `
    @if (debug.enabled()) {
      <button
        #fab
        type="button"
        class="dbg-fab"
        (pointerdown)="onDown($event)"
        (click)="onClick($event)"
        [attr.aria-pressed]="open()"
        aria-label="Debug logs"
        title="Debug logs (drag to move)"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3M13 15h4" />
        </svg>
      </button>
      <!-- Keep the heavier viewer in a lazy chunk. Once loaded, Angular retains the defer block so later
           open/close cycles do not fetch it again. -->
      @defer (when open()) {
        @if (open()) {
          <app-debug-log-overlay (close)="open.set(false)" />
        }
      }
    }
  `,
  styles: [
    `
      .dbg-fab {
        position: fixed;
        left: calc(50% - 22px);
        top: calc(50% - 22px);
        z-index: 1200;
        width: 44px;
        height: 44px;
        border: none;
        border-radius: 50%;
        background: #1e1e1e;
        color: #e6e6e6;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab; /* the FAB is draggable as well as clickable — grab signals that */
        touch-action: none; /* the FAB owns the gesture: a drag never scrolls the page beneath it */
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        opacity: 0.55;
        transition: opacity 120ms;
      }
      .dbg-fab:hover,
      .dbg-fab:focus-visible {
        opacity: 1;
      }
      .dbg-fab.dragging {
        cursor: grabbing;
        opacity: 1;
        transition: none; /* follow the pointer exactly, no opacity easing mid-drag */
        will-change: transform; /* promote to a compositor layer so translate moves never trigger layout */
        user-select: none;
      }
    `,
  ],
})
export class DebugLogFabComponent implements OnDestroy {
  readonly debug = inject(DebugToolsService);
  readonly open = signal(false);

  private readonly fabEl = viewChild<ElementRef<HTMLButtonElement>>('fab');

  toggle(): void {
    this.open.update((v) => !v);
  }

  // ---------- Drag-to-move (compositor-only — zero reflow) ----------
  // Mirrors DebugLogOverlayComponent's grip drag: transform-only repositioning, one layout read at
  // pointerdown, rAF-coalesced moves. The movement threshold prevents tap jitter from moving the FAB.
  private dragging = false;
  private moved = false;
  private startX = 0;
  private startY = 0;
  /** Layout origin + size, captured once per drag (visual rect minus the current translate). */
  private baseLeft = 0;
  private baseTop = 0;
  private baseW = 0;
  private baseH = 0;
  /** Translate at grab time (the FAB may already be offset from a prior drag this session). */
  private grabTx = 0;
  private grabTy = 0;
  /** Current total translate applied (persists across drags for the session, until the FAB unmounts). */
  private tx = 0;
  private ty = 0;
  /** Latest desired offset + the pending frame that will commit it (rAF coalescing). */
  private pendingTx = 0;
  private pendingTy = 0;
  private rafId = 0;
  /** The pointerId captured on the FAB; -1 between gestures. */
  private pointerId = -1;
  /** A mouse/pointer drag can still synthesize a click after pointerup. Keep this flag only until the
   *  browser has had a chance to dispatch that compatibility click, mirroring vConsole's one-shot
   *  document click suppressor. */
  private suppressNextClick = false;
  private suppressClickTimer = 0;
  onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left-button only for mouse
    const fab = this.fabEl()?.nativeElement;
    if (!fab) return;
    // Capture the pointer on the FAB for the whole gesture. A window-only listener loses the touch stream
    // in a WebView the moment implicit capture is dropped or a stray pan issues pointercancel — the same
    // trap the overlay's grip avoids. A captured event still targets the FAB and bubbles, so the window
    // listeners below keep firing.
    fab.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    e.preventDefault();
    // The single layout read of the drag: visual rect = centered layout + the current (tx, ty) translate.
    const rect = fab.getBoundingClientRect();
    this.baseLeft = rect.left - this.tx;
    this.baseTop = rect.top - this.ty;
    this.baseW = rect.width;
    this.baseH = rect.height;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.grabTx = this.tx;
    this.grabTy = this.ty;
    this.moved = false;
    this.dragging = true;
    fab.classList.add('dragging');
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.moved && Math.hypot(dx, dy) < 5) return; // activation threshold — keeps an inert tap inert
    this.moved = true;
    // Desired offset = grab offset + pointer delta, clamped so the visual position (baseLeft + offset) stays
    // inside the viewport with an 8 px margin. No layout reads: base* are cached and innerWidth/Height are
    // viewport metrics.
    this.pendingTx = Math.max(
      8 - this.baseLeft,
      Math.min(window.innerWidth - this.baseW - 8 - this.baseLeft, this.grabTx + dx),
    );
    this.pendingTy = Math.max(
      8 - this.baseTop,
      Math.min(window.innerHeight - this.baseH - 8 - this.baseTop, this.grabTy + dy),
    );
    if (!this.rafId) this.rafId = requestAnimationFrame(this.applyTransform);
  };

  private applyTransform = (): void => {
    this.rafId = 0;
    const fab = this.fabEl()?.nativeElement;
    if (!fab) return;
    this.tx = this.pendingTx;
    this.ty = this.pendingTy;
    fab.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0)`;
  };

  private onUp = (): void => {
    if (this.moved) this.armClickSuppression();
    this.endDrag();
    this.moved = false;
  };

  /** pointercancel (a system interrupt — OS notification, gesture theft) ends the gesture cleanly so the
   *  FAB is never left mid-drag. */
  private onCancel = (): void => {
    this.endDrag();
    this.moved = false;
  };

  /** Tear down the gesture: unhook listeners, commit any trailing rAF offset, release capture, drop the
   *  compositor-promoting class. Shared by real pointerup and pointercancel. */
  private endDrag(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    // Commit the final offset synchronously: a trailing move may have a frame scheduled that won't fire now.
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.applyTransform();
    }
    const fab = this.fabEl()?.nativeElement;
    fab?.classList.remove('dragging');
    if (fab) {
      try {
        fab.releasePointerCapture?.(this.pointerId);
      } catch {
        // Already released (e.g. the pointer vanished) — nothing to do.
      }
    }
    this.dragging = false;
  }

  /** Click toggle. A compatibility click immediately following a drag is swallowed once; keyboard
   *  activation (Enter/Space) and stationary presses still route through normally. */
  onClick(e: MouseEvent): void {
    if (this.suppressNextClick) {
      this.clearClickSuppression();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.toggle();
  }

  private armClickSuppression(): void {
    this.suppressNextClick = true;
    if (this.suppressClickTimer) window.clearTimeout(this.suppressClickTimer);
    // Native click follows pointerup in the same event sequence. Expire at the next task so a later genuine
    // click is never consumed when a platform already cancelled the compatibility click (notably touch).
    this.suppressClickTimer = window.setTimeout(() => this.clearClickSuppression(), 0);
  }

  private clearClickSuppression(): void {
    this.suppressNextClick = false;
    if (this.suppressClickTimer) {
      window.clearTimeout(this.suppressClickTimer);
      this.suppressClickTimer = 0;
    }
  }

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.clearClickSuppression();
    if (this.dragging) {
      window.removeEventListener('pointermove', this.onMove);
      window.removeEventListener('pointerup', this.onUp);
      window.removeEventListener('pointercancel', this.onCancel);
    }
  }
}
