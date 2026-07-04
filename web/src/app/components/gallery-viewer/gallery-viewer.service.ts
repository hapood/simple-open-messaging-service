import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { GalleryViewerComponent } from './gallery-viewer.component';
import type { AlbumImage } from '../message-cards/chat-item';

/**
 * Opens the fullscreen image gallery as a transient overlay (CDK Overlay + a sentinel history entry so system-back
 * closes it; router navigation disposes it). The back-button / overlay mechanics live in the shared
 * {@link TransientOverlayService} base — this subclass contributes only the history tag, the hosted component, and
 * the `open()` API.
 *
 * The viewer is a transient overlay (NOT a deep-linkable route): its image payload isn't URL-serializable and isn't
 * shareable, so it owns a sentinel history entry for back-button support rather than using the modal-as-router-outlet
 * pattern used by chat/profile/group-info.
 */
@Injectable({ providedIn: 'root' })
export class GalleryViewerService extends TransientOverlayService<{ images: AlbumImage[]; startIndex: number }> {
  protected readonly historyTag = 'soms-gallery';
  protected readonly component = GalleryViewerComponent;

  /** Open the gallery at `startIndex` within `images`. No-op on an empty album. Replaces any viewer already open. */
  open(images: AlbumImage[], startIndex = 0): void {
    if (images.length === 0) return;
    this.present({ images, startIndex });
  }
}
