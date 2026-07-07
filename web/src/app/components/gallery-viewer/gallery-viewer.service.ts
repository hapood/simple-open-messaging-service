import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { GalleryViewerComponent } from './gallery-viewer.component';
import type { AlbumImage } from '../message-cards/chat-item';

/**
 * Opens the fullscreen image gallery as a transient overlay (CDK Overlay, decoupled from any host template to
 * escape ancestor stacking contexts). Open/close is an entry on the nav pane stack (kind `'gallery'`); the
 * shared {@link TransientOverlayService} base mounts/disposes the CDK overlay from that entry, so back /
 * openChat / going home dismiss it. The base wires the hosted component's `close` output (Esc / margin tap /
 * swipe-down) to its own close.
 *
 * The viewer is a transient overlay (NOT a deep-linkable route): its image payload isn't URL-serializable and
 * isn't shareable, so it lives on the pane stack rather than a route.
 */
@Injectable({ providedIn: 'root' })
export class GalleryViewerService extends TransientOverlayService<{ images: AlbumImage[]; startIndex: number }> {
  protected readonly kind = 'gallery';
  protected readonly component = GalleryViewerComponent;

  /** Open the gallery at `startIndex` within `images`. No-op on an empty album. Replaces any viewer already open. */
  open(images: AlbumImage[], startIndex = 0): void {
    if (images.length === 0) return;
    this.pushEntry({ images, startIndex });
  }
}
