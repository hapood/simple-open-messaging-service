import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  MEDIA_STATUS,
  type ChatMsgData,
  type MediaStatus,
} from '../message-cards/chat-item';
import { assetUrl } from '../../services/runtime';
import {
  categorize,
  fileExt,
  formatBytes,
  type FileCategory,
} from '../message-cards/file-meta.util';
import {
  MediaAvailabilityRegistration,
  MediaAvailabilityService,
} from '../../services/media-availability.service';

/**
 * Fullscreen inspector for a single FILE message. Mounted by {@link FileDetailService} inside a CDK Overlay (global
 * position, scroll-block, dispose-on-navigation), decoupled from any host template. The shared transient-overlay
 * `modal` policy owns the dimmed backdrop and dismissal; this component renders the centered card showing the
 * type-tinted icon, full filename, metadata, and Download button.
 *
 * Close gestures are × plus the service-owned Escape/backdrop handling.
 *
 * Under Tauri the download href is rewritten to the media:// proxy by {@link assetUrl} (a bare <a href> can't carry
 * the cross-origin Authorization header; the browser path keeps the same-origin relative URL authenticated by the
 * media_token cookie).
 */
@Component({
  selector: 'app-file-detail-viewer',
  standalone: true,
  imports: [
    TranslocoPipe,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './file-detail-viewer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './file-detail-viewer.component.scss',
})
export class FileDetailViewerComponent implements OnDestroy {
  readonly data = input.required<ChatMsgData>();
  /** The owning thread — scopes the backend relocalize retry. */
  readonly threadId = input<number>(0);
  readonly close = output<void>();

  readonly MEDIA_STATUS = MEDIA_STATUS;
  readonly registeredStatus = signal<MediaStatus | null>(null);
  readonly currentStatus = computed<MediaStatus>(
    () =>
      this.registeredStatus() ?? this.data().mediaStatus ?? MEDIA_STATUS.READY,
  );

  private readonly mediaAvailability = inject(MediaAvailabilityService);
  private registration?: MediaAvailabilityRegistration;
  private removeStatusListener?: () => void;
  private removeWithdrawnListener?: () => void;

  constructor() {
    effect(() => {
      this.releaseRegistration();
      this.registeredStatus.set(null);
      const threadId = this.threadId();
      const data = this.data();
      if (threadId === 0 || data.msgId < 1) return;
      const registration = this.mediaAvailability.register(
        threadId,
        data.msgId,
        data.mediaStatus ?? MEDIA_STATUS.READY,
      );
      this.registration = registration;
      this.registeredStatus.set(registration.status());
      this.removeStatusListener = registration.subscribe((status) =>
        this.registeredStatus.set(status),
      );
      this.removeWithdrawnListener = registration.onWithdrawn(() =>
        this.close.emit(),
      );
    });
  }

  ngOnDestroy(): void {
    this.releaseRegistration();
  }

  readonly file = computed(() => this.data().file);
  readonly category = computed<FileCategory>(() =>
    categorize(this.file()?.mimeType ?? ''),
  );
  readonly ext = computed(() => fileExt(this.file()?.name ?? ''));
  readonly sizeText = computed(() => formatBytes(this.file()?.size ?? 0));
  /** A URL exists for confirmed files; an optimistic send before its upload resolves may have none yet. */
  readonly hasUrl = computed(() => !!this.file()?.url);
  readonly downloadHref = computed(() => assetUrl(this.file()?.url ?? ''));

  /** Backend relocalize retry — the federated file never finished localizing (status 'failed'). Optimistic
   *  'downloading', call the endpoint, then flip to the returned status (mirrored to the repo so the chat
   *  card updates too). On 'ready' the Download button re-enables; on 'failed' the retry stays available. */
  async relocalize(): Promise<void> {
    const tid = this.threadId();
    const seq = this.data().msgId;
    if (tid === 0) return;
    try {
      await this.mediaAvailability.retry(tid, seq);
    } catch {
      // The retained failed status remains visible; transport errors are not CAS outcomes.
    }
  }

  private releaseRegistration(): void {
    this.removeStatusListener?.();
    this.removeStatusListener = undefined;
    this.removeWithdrawnListener?.();
    this.removeWithdrawnListener = undefined;
    this.registration?.unregister();
    this.registration = undefined;
  }
}
