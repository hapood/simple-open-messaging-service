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
 * Zoneless note: CDK Overlay (v20) is imperative/DOM-level for the features used here (global position, scroll-block,
 * dispose), none of which ride on NgZone.onStable, so it is safe under provideZonelessChangeDetection. The initial render
 * is driven explicitly via changeDetectorRef.detectChanges() after inputs are set.
 */
@Injectable({ providedIn: 'root' })
export class GalleryViewerService implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private ref: ReturnType<Overlay['create']> | null = null;
  private closeSub?: { unsubscribe(): void };

  /** Open the viewer at `startIndex` within `images`. Replaces any viewer already open. */
  open(images: AlbumImage[], startIndex = 0): void {
    if (images.length === 0) return;
    this.close();
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      disposeOnNavigation: true,
    });
    const cmp = ref.attach(new ComponentPortal(GalleryViewerComponent));
    cmp.setInput('images', images);
    cmp.setInput('startIndex', startIndex);
    this.closeSub = cmp.instance.close.subscribe(() => this.close());
    cmp.changeDetectorRef.detectChanges(); // zoneless: drive the first render so the image shows
    this.ref = ref;
  }

  /** Close the current viewer (if any). */
  close(): void {
    this.closeSub?.unsubscribe();
    this.closeSub = undefined;
    this.ref?.dispose();
    this.ref = null;
  }

  ngOnDestroy(): void { this.close(); }
}
