import { Component, computed, HostListener, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../message-cards/chat-item';
import { assetUrl } from '../../services/runtime';
import { categorize, fileExt, formatBytes, type FileCategory } from '../message-cards/file-meta.util';

/**
 * Fullscreen inspector for a single FILE message. Mounted by {@link FileDetailService} inside a CDK Overlay (global
 * position, scroll-block, dispose-on-navigation), decoupled from any host template. Self-contained: a dimmed backdrop
 * (tap to close) + a centered card showing the type-tinted icon, the FULL filename (wraps, never truncates — the row
 * ellipses; this view exists to show the whole name), size / type / sender / time rows, and a Download button. Emits
 * `close` (the service disposes the overlay).
 *
 * Close gestures: × button, Escape, or a tap on the dimmed backdrop. A tap ON the card does not close (so the
 * Download button and text selection work).
 *
 * Under Tauri the download href is rewritten to the media:// proxy by {@link assetUrl} (a bare <a href> can't carry
 * the cross-origin Authorization header; the browser path keeps the same-origin relative URL authenticated by the
 * media_token cookie).
 */
@Component({
  selector: 'app-file-detail-viewer',
  standalone: true,
  imports: [TranslocoPipe],
  templateUrl: './file-detail-viewer.component.html',
  styleUrl: './file-detail-viewer.component.scss',
})
export class FileDetailViewerComponent {
  readonly data = input.required<ChatMsgData>();
  readonly close = output<void>();

  readonly file = computed(() => this.data().file);
  readonly category = computed<FileCategory>(() => categorize(this.file()?.mimeType ?? ''));
  readonly ext = computed(() => fileExt(this.file()?.name ?? ''));
  readonly sizeText = computed(() => formatBytes(this.file()?.size ?? 0));
  /** A URL exists for confirmed files; an optimistic send before its upload resolves may have none yet. */
  readonly hasUrl = computed(() => !!this.file()?.url);
  readonly downloadHref = computed(() => assetUrl(this.file()?.url ?? ''));

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.close.emit();
  }

  /** Close when the dimmed backdrop itself (not the card) is the click target. */
  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.close.emit();
  }
}
