import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { FileDetailViewerComponent } from './file-detail-viewer.component';
import type { ChatMsgData } from '../message-cards/chat-item';

/**
 * Opens the fullscreen file-detail overlay as a transient overlay (CDK Overlay). Open/close is an entry on the
 * nav pane stack (kind `'file-detail'`); the shared {@link TransientOverlayService} base mounts/disposes the
 * CDK overlay from that entry. The overlay shows the full filename (no truncation), size/type/sender/time, and
 * a Download button — the things a long-name file can't surface in the compact 280px bubble.
 */
@Injectable({ providedIn: 'root' })
export class FileDetailService extends TransientOverlayService<{ data: ChatMsgData; threadId: number }> {
  protected readonly kind = 'file-detail';
  protected readonly component = FileDetailViewerComponent;
  protected readonly presentation = 'modal';

  /** Open the detail overlay for a FILE message (scoped to `threadId` so the backend retry can be called).
   *  No-op if the message has no file attachment. */
  open(data: ChatMsgData, threadId: number): void {
    if (!data.file) return;
    this.pushEntry({ data, threadId });
  }
}
