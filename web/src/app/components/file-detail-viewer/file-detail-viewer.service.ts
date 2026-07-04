import { Injectable } from '@angular/core';
import { TransientOverlayService } from '../../services/transient-overlay.service';
import { FileDetailViewerComponent } from './file-detail-viewer.component';
import type { ChatMsgData } from '../message-cards/chat-item';

/**
 * Opens the fullscreen file-detail overlay as a transient overlay (CDK Overlay + a sentinel history entry so
 * system-back closes it; router navigation disposes it). Same back-button / overlay mechanics as the gallery, shared
 * via {@link TransientOverlayService}. The overlay shows the full filename (no truncation), size/type/sender/time,
 * and a Download button — the things a long-name file can't surface in the compact 280px bubble.
 */
@Injectable({ providedIn: 'root' })
export class FileDetailService extends TransientOverlayService<{ data: ChatMsgData }> {
  protected readonly historyTag = 'soms-file-detail';
  protected readonly component = FileDetailViewerComponent;

  /** Open the detail overlay for a FILE message. No-op if the message has no file attachment. */
  open(data: ChatMsgData): void {
    if (!data.file) return;
    this.present({ data });
  }
}
