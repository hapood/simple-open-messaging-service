import { AfterViewInit, Component, computed, effect, HostListener, input, OnDestroy, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { AlbumImage } from '../message-cards/chat-item';

const DRAG_THRESHOLD = 8;   // px: a pointer sequence under this length is a tap, not a drag
const SWIPE_X = 50;         // px: horizontal drag at 1x → prev/next
const SWIPE_DOWN = 90;      // px: downward drag at 1x → close
const ZOOM_TOGGLE = 2.5;    // scale toggled by double-tap/click
const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function vw(): number { return typeof window !== 'undefined' ? window.innerWidth : 0; }
function vh(): number { return typeof window !== 'undefined' ? window.innerHeight : 0; }

/**
 * Fullscreen gallery / lightbox viewer for an album (or a single image). Mounted by {@link GalleryViewerService} inside a
 * CDK Overlay (global position, scroll-block, dispose-on-navigation), so it is decoupled from any host template and
 * escapes ancestor stacking contexts. The component itself is self-contained: a dark fullscreen stage with the image,
 * prev/next controls, a counter, and zoom/pan — it only emits `close` (the service disposes the overlay).
 *
 * Navigation: prev/next arrow buttons, keyboard ←/→, and horizontal swipe — scoped to the album passed in. Counter shows
 * "i / N". Zoom/pan: double-tap/click toggles 1x ↔ zoomed; the mouse wheel adjusts the zoom level; a drag PANS when zoomed
 * in (clamped to the image bounds). v1 zooms around the image center (cursor-precise zoom is a follow-up); pinch
 * (two-finger) is also a follow-up — double-tap + drag-pan covers desktop and mobile. The transform resets on each nav.
 *
 * Close gestures: the × button, Escape, swipe-down, or a tap on the dark margin around the image (a tap ON the image is
 * a no-op so double-tap can zoom; double-clicking the image toggles zoom).
 */
@Component({
  selector: 'app-gallery-viewer',
  standalone: true,
  imports: [TranslocoPipe],
  templateUrl: './gallery-viewer.component.html',
  styleUrl: './gallery-viewer.component.scss',
})
export class GalleryViewerComponent implements AfterViewInit, OnDestroy {
  readonly images = input.required<AlbumImage[]>();
  readonly startIndex = input<number>(0);
  readonly close = output<void>();

  readonly count = computed(() => this.images().length);
  readonly canNav = computed(() => this.count() > 1);
  readonly index = signal(0);
  readonly scale = signal(1);
  readonly tx = signal(0);
  readonly ty = signal(0);
  /** Opacity dim while swipe-to-close drags down at 1x (feedback that releasing will close). 1 = opaque. */
  readonly dim = signal(1);
  readonly current = computed<AlbumImage | null>(() => this.images()[this.index()] ?? null);
  /** The CSS transform applied to the image (translate then scale, origin center). */
  readonly transform = computed(() => `translate(${this.tx()}px, ${this.ty()}px) scale(${this.scale()})`);

  /** Per-image load state: 'loading' while fetching, 'loaded' once the <img> fires load, 'error' on failure. The error
   *  state shows a tap-to-retry card so the user can recover from a transient network/auth/blobs failure. */
  readonly loadState = signal<'loading' | 'loaded' | 'error'>('loading');
  /** Bumped on each manual retry; appended to the src for http(s) URLs to bypass a cached error and force a re-fetch. */
  readonly retryKey = signal(0);
  /** The <img> src — cache-busted on retry for http(s) URLs (blob:/data: are re-assigned unchanged; retry can't help a
   *  revoked blob or a data URL, so cache-busting would only break them). */
  readonly imgSrc = computed(() => {
    const img = this.current();
    if (!img) return '';
    const k = this.retryKey();
    if (k === 0 || /^(blob:|data:)/.test(img.src)) return img.src;
    const sep = img.src.includes('?') ? '&' : '?';
    return `${img.src}${sep}_r=${k}`;
  });
  /** The <img> opacity: hidden while errored (so no broken-image icon bleeds through the retry card), else the swipe dim. */
  readonly imgOpacity = computed(() => (this.loadState() === 'error' ? 0 : this.dim()));

  private drag: { x: number; y: number; tx0: number; ty0: number; moved: boolean } | null = null;

  constructor() {
    // Reset zoom/pan + load state whenever the shown image changes (nav or startIndex change) — every image enters at
    // 1x, centered, and re-fetches on its own.
    effect(() => { this.index(); this.scale.set(1); this.tx.set(0); this.ty.set(0); this.dim.set(1); this.loadState.set('loading'); this.retryKey.set(0); });
  }

  ngAfterViewInit(): void {
    this.index.set(clamp(this.startIndex(), 0, Math.max(0, this.count() - 1)));
  }

  ngOnDestroy(): void { this.drag = null; }

  // ---------------- navigation ----------------
  prev(): void { if (this.canNav()) this.index.set((this.index() - 1 + this.count()) % this.count()); }
  next(): void { if (this.canNav()) this.index.set((this.index() + 1) % this.count()); }

  // ---------------- keyboard (window-level) ----------------
  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); this.prev(); break;
      case 'ArrowRight': e.preventDefault(); this.next(); break;
      case 'Escape': this.close.emit(); break;
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(1 / 1.25); break;
      case '0': this.resetZoom(); break;
    }
  }

  // ---------------- pointer (pan / swipe / tap) ----------------
  onPointerDown(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY, tx0: this.tx(), ty0: this.ty(), moved: false };
  }

  onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
    if (!d.moved) return;
    if (this.scale() > 1) {
      // zoomed in: pan, clamped to the image bounds.
      const c = this.clampPan(d.tx0 + dx, d.ty0 + dy);
      this.tx.set(c.tx); this.ty.set(c.ty);
    } else {
      // 1x: follow the finger for swipe feedback (nav/close decided on pointerup).
      this.tx.set(dx); this.ty.set(dy);
      this.dim.set(clamp(1 - Math.abs(dy) / 320, 0.35, 1));
    }
  }

  onPointerUp(e: PointerEvent): void {
    const d = this.drag; this.drag = null;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      // a tap. On the dark margin (outside the image) at 1x → close; on the image → no-op (double-click zooms).
      if (this.scale() === 1 && this.isOutsideImage(e.clientX, e.clientY)) this.close.emit();
      return;
    }
    if (this.scale() > 1) return; // panned; clamp already applied — keep
    // 1x: decide the swipe.
    if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > SWIPE_X) {
      if (dx < 0) this.next(); else this.prev();
    } else if (dy > SWIPE_DOWN) {
      this.close.emit();
      return;
    }
    this.tx.set(0); this.ty.set(0); this.dim.set(1); // snap back (no qualifying swipe)
  }

  /** Double-click/tap on the image toggles 1x ↔ zoomed (centered). */
  onDoubleClick(e: MouseEvent): void {
    e.preventDefault();
    if (this.scale() === 1) this.scale.set(ZOOM_TOGGLE); else this.resetZoom();
  }

  /** <img> finished loading (possibly from cache) — hide any pending state. */
  onImgLoad(): void { this.loadState.set('loaded'); }
  /** <img> failed to load (network / auth / revoked blob) — show the tap-to-retry card. */
  onImgError(): void { this.loadState.set('error'); }
  /** User tapped retry: force a fresh fetch (cache-busted for http(s) via retryKey) and go back to 'loading'. */
  retryLoad(): void { this.retryKey.update(k => k + 1); this.loadState.set('loading'); }

  /** Mouse wheel adjusts the zoom level (desktop). */
  onWheel(e: WheelEvent): void {
    if (e.deltaY === 0) return;
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  // ---------------- zoom helpers ----------------
  private zoomBy(factor: number): void {
    const next = clamp(this.scale() * factor, MIN_SCALE, MAX_SCALE);
    this.scale.set(next);
    if (next === 1) { this.tx.set(0); this.ty.set(0); } // back to 1x → recenter
    else { const c = this.clampPan(this.tx(), this.ty()); this.tx.set(c.tx); this.ty.set(c.ty); } // keep pan in bounds
  }

  private resetZoom(): void { this.scale.set(1); this.tx.set(0); this.ty.set(0); }

  /** The image's contain-fit display size within the viewport (for pan clamping + tap-outside detection). */
  private displayedSize(): { w: number; h: number } {
    const img = this.current();
    const W = vw(), H = vh();
    if (!img || !img.w || !img.h || !W || !H) return { w: 0, h: 0 };
    const s = Math.min(W / img.w, H / img.h);
    return { w: img.w * s, h: img.h * s };
  }

  private clampPan(txv: number, tyv: number): { tx: number; ty: number } {
    const { w: dw, h: dh } = this.displayedSize();
    const W = vw(), H = vh();
    const s = this.scale();
    const maxX = Math.max(0, (dw * s - W) / 2);
    const maxY = Math.max(0, (dh * s - H) / 2);
    return { tx: clamp(txv, -maxX, maxX), ty: clamp(tyv, -maxY, maxY) };
  }

  private isOutsideImage(clientX: number, clientY: number): boolean {
    const { w: dw, h: dh } = this.displayedSize();
    const W = vw(), H = vh();
    return Math.abs(clientX - W / 2) > dw / 2 || Math.abs(clientY - H / 2) > dh / 2;
  }
}
