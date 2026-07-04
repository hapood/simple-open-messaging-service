import { Injectable, inject, OnDestroy } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { GalleryViewerComponent } from './gallery-viewer.component';
import type { AlbumImage } from '../message-cards/chat-item';

/**
 * Opens the {@link GalleryViewerComponent} in a CDK Overlay — decoupled from any host template (no per-host signal or
 * <app-gallery-viewer> markup), openable from anywhere via `open(images, index)`. The overlay is fullscreen (global
 * position at the viewport top-left), blocks background scroll while open, and auto-disposes on navigation.
 *
 * One viewer at a time: `open` closes any existing viewer first. The component emits `close` (× / Esc / swipe-down /
 * tap-on-margin) → the service disposes the overlay and re-enables scrolling.
 *
 * ---------------- Back-button / history ----------------
 * The viewer is a transient fullscreen overlay, NOT a deep-linkable route — its image payload isn't URL-serializable and
 * isn't shareable — so it follows the same history-entry pattern the dialog stack in `RouteService` uses, rather than the
 * modal-as-route pattern used by chat/profile/group-info:
 *   - `open` pushes one sentinel `history.pushState({ tag: 'soms-gallery' })`. A replacement (`open` while one is already
 *     open) reuses that same entry so only one is ever outstanding.
 *   - A genuine system-back fires `popstate` → the viewer is disposed and the entry the browser just left is already gone,
 *     so the chat underneath stays put. Without this, back would navigate the router and close the whole chat.
 *   - An explicit close (× / Esc / swipe / `close()`) consumes its own entry via a suppressed `history.back()` so the
 *     popstate it fires isn't mistaken for a system-back (1:1 `selfBackPending` counter, as in `RouteService`).
 *   - If a router navigation disposes the overlay (`disposeOnNavigation`), the now-orphaned entry is marked inactive —
 *     never `history.back`, which would yank the user backward to the previous chat; a later popstate landing on it is a
 *     no-op.
 *
 * Zoneless note: CDK Overlay (v20) is imperative/DOM-level for the features used here (global position, scroll-block,
 * dispose), none of which ride on NgZone.onStable, so it is safe under provideZonelessChangeDetection. The initial render
 * is driven explicitly via changeDetectorRef.detectChanges() after inputs are set.
 */
@Injectable({ providedIn: 'root' })
export class GalleryViewerService implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private ref: ReturnType<Overlay['create']> | null = null;
  private closeSub?: { unsubscribe(): void };
  private detachSub?: { unsubscribe(): void };

  /** True while we own an outstanding sentinel history entry for the currently-open viewer. */
  private entryActive = false;
  /**
   * Count of history traversals we initiated ourselves (the suppressed `history.back()` from an explicit close) whose
   * resulting `popstate` must be ignored so it isn't mistaken for a system-back. 1:1 per initiated traversal.
   */
  private selfBackPending = 0;

  constructor() {
    // One listener for the service's lifetime (root singleton). Arrow-bound so `this` is preserved; mirrors RouteService.
    window.addEventListener('popstate', this.onPopState);
  }

  /** Open the viewer at `startIndex` within `images`. Replaces any viewer already open. */
  open(images: AlbumImage[], startIndex = 0): void {
    if (images.length === 0) return;
    this.disposeOverlay();
    // Claim a history entry only when we don't already own one — replacing a viewer reuses the same entry (no accumulation).
    if (!this.entryActive) {
      history.pushState({ tag: 'soms-gallery' }, '');
      this.entryActive = true;
    }
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      disposeOnNavigation: true,
    });
    const cmp = ref.attach(new ComponentPortal(GalleryViewerComponent));
    cmp.setInput('images', images);
    cmp.setInput('startIndex', startIndex);
    this.closeSub = cmp.instance.close.subscribe(() => this.explicitClose());
    // External dispose (router navigation via disposeOnNavigation): reconcile the orphaned entry without yanking the user back.
    this.detachSub = ref.detachments().subscribe(() => this.onDetached());
    cmp.changeDetectorRef.detectChanges(); // zoneless: drive the first render so the image shows
    this.ref = ref;
  }

  /** Close the current viewer (if any) as if the user dismissed it: dispose + consume the outstanding history entry. */
  close(): void { this.explicitClose(); }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPopState);
    this.disposeOverlay();
  }

  // ---------------- history ----------------

  private readonly onPopState = (): void => {
    // A popstate from our own suppressed history.back — state already updated, ignore.
    if (this.selfBackPending > 0) { this.selfBackPending--; return; }
    // Genuine system-back while the viewer is open: the browser has already left our sentinel entry, so just drop the
    // overlay (no second history.back) and leave the chat underneath where it was.
    if (this.entryActive) {
      this.entryActive = false;
      this.disposeOverlay();
    }
  };

  /** User-initiated close (× / Esc / swipe / explicit `close()`): clear the entry, dispose, then consume it with a suppressed back. */
  private explicitClose(): void {
    const hadEntry = this.entryActive;
    this.entryActive = false; // clear BEFORE dispose so onDetached (if it fires) sees no active entry
    this.disposeOverlay();
    if (hadEntry) {
      this.selfBackPending++;
      history.back(); // consume our sentinel; the popstate it fires is swallowed by onPopState via selfBackPending
    }
  }

  /**
   * Overlay was detached externally — only the `disposeOnNavigation` path reaches this with work to do (explicit /
   * system-back clear `entryActive` and unsubscribe `detachSub` inside `disposeOverlay` first). The router has already
   * pushed a new URL on top of our sentinel, so NEVER `history.back` here — that would pull the user back to the previous
   * chat. Just drop our claim so a future popstate landing on the orphaned entry is a no-op.
   */
  private onDetached(): void {
    this.entryActive = false;
    this.closeSub?.unsubscribe(); this.closeSub = undefined;
    this.detachSub?.unsubscribe(); this.detachSub = undefined;
    this.ref = null;
  }

  // ---------------- overlay ----------------

  /** Tear down the overlay + its subscriptions without touching the history entry. */
  private disposeOverlay(): void {
    this.closeSub?.unsubscribe(); this.closeSub = undefined;
    this.detachSub?.unsubscribe(); this.detachSub = undefined;
    this.ref?.dispose();
    this.ref = null;
  }
}
