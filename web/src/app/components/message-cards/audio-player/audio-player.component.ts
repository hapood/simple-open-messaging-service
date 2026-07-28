import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { MEDIA_STATUS, type MediaStatus } from '../chat-item';
import { formatDuration } from '../file-meta.util';
import { MediaTransferService } from '../../../services/media-transfer.service';
import { AudioPlaybackCoordinator } from './audio-playback-coordinator.service';

/**
 * Flat progress-bar voice player, rendered inside an AUDIO cell of {@link MediaRowComponent}.
 *
 * Self-contained: owns one `<audio>` element + play/pause state + a progress fill driven by `timeupdate`.
 * Takes `src` (a CAS shard URL or an optimistic blob URL) and `duration` (seconds). The component FILLS its
 * cell (100% width/height); the cell's height is locked to an integer px by layoutAlbum's audio branch, and
 * playback only animates a width fill — never a height change — so the virtual-scroll kernel's height-model
 * invariant (totalH === Σ offsetHeight) holds during playback.
 *
 * The `<audio>` has no `controls` attribute (the play button + progress bar ARE the controls). A decode/load
 * failure (unsupported codec, federated localize 4xx) flips to a muted, non-functional button via `failed`.
 * While the federated asset is not ready (status 'downloading' | 'failed') the button is inert — play is
 * suppressed so a not-yet-local or 4xx shard can't trip onError into a spurious failed.
 */
@Component({
  selector: 'app-audio-player',
  imports: [],
  templateUrl: './audio-player.component.html',
  styleUrl: './audio-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AudioPlayerComponent {
  /** Exposed for transfer-state comparisons in the template. */
  readonly MEDIA_STATUS = MEDIA_STATUS;
  /** Audio source URL — a /uploads/shards/… CAS URL, or a blob: URL for an optimistic in-flight clip. */
  readonly src = input.required<string>();
  /** Clip duration in seconds (client-probed / recorded). Display + the progress denominator. */
  readonly duration = input(0);
  readonly time = input('');
  readonly pending = input(false);
  readonly transferId = input('');
  readonly showUnplayed = input(true);
  /** Federated media localize status (message-level — every cell of the message shares it). Anything but
   *  'ready' ('downloading' = still localizing, 'failed' = localize failed) means the local shard URL is
   *  not playable, so {@link inert} suppresses play (the media-row overlay already surfaces a spinner /
   *  cloud_off + the matching aria). Without that guard el.play() would fire against a not-yet-local or
   *  4xx shard, the <audio> would error, and onError() would record a SPURIOUS failed — a frontend-only
   *  state that never reflects the real localize status. The terminal arrives live from the server via
   *  SSE and flips this input ready/failed. */
  readonly status = input<MediaStatus>(MEDIA_STATUS.READY);

  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
  /** Pause the clip — a STABLE callback (created once) so the coordinator can identify "this player" by
   *  reference and pause any other clip playing elsewhere in the app when this one starts. */
  private readonly coordinator = inject(AudioPlaybackCoordinator);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly transfers = inject(MediaTransferService);
  private readonly pauseFn = (): void => {
    this.audioRef()?.nativeElement?.pause();
  };

  readonly playing = signal(false);
  /** 0..1 playback progress (driven by timeupdate). */
  readonly progress = signal(0);
  /** Integer 0..100 (the fill width % + the progressbar aria-valuenow). */
  readonly progressPct = computed(() => Math.round(this.progress() * 100));
  /** True when the clip failed to load/decode → the button is muted and non-functional. */
  readonly failed = signal(false);
  /** The button is non-functional while the clip is not playable: a prior decode/load error (failed), OR
   *  the federated asset is not ready — still localizing ('downloading') or localize failed ('failed').
   *  Centralized so the template's [disabled] and toggle()'s guard share one source and never drift. */
  readonly inert = computed(
    () => this.failed() || this.status() !== MEDIA_STATUS.READY,
  );
  readonly durLabel = computed(() => formatDuration(this.duration()));
  readonly played = signal(false);
  readonly rate = signal(1);
  readonly transferProgress = computed<number | null>(() => {
    const id = this.transferId();
    if (!id) return null;
    const task = this.transfers.tasks().find((candidate) => candidate.clientMessageId === id);
    if (!task || task.status !== 'uploading' || task.size <= 0) return null;
    return Math.max(0, Math.min(100, (task.loaded / task.size) * 100));
  });
  readonly showTransfer = computed(
    () => this.pending() || this.status() === MEDIA_STATUS.DOWNLOADING,
  );
  readonly transferIndeterminate = computed(
    () => this.status() === MEDIA_STATUS.DOWNLOADING || this.transferProgress() === null,
  );

  constructor() {
    // Voice rows live in detached, imperatively-created views. Track app-scoped upload progress here
    // and explicitly repaint the player without attaching the whole virtual list to global CD.
    effect(() => {
      this.transferProgress();
      queueMicrotask(() => this.render());
    });
  }

  toggle(): void {
    const el = this.audioRef()?.nativeElement;
    if (!el || this.inert()) return;
    if (this.playing()) {
      el.pause();
      return;
    }
    // Pause any other voice clip currently playing elsewhere in the app (single-active, WhatsApp-style).
    this.coordinator.begin(this.pauseFn);
    // el.play() resolves on success (the 'play' event then sets `playing`); it rejects when the browser
    // blocks it (rare for a user-gesture-initiated play) or the source is unplayable → mark failed.
    void el.play().catch(() => {
      this.failed.set(true);
      this.render();
    });
  }

  onTimeUpdate(): void {
    const el = this.audioRef()?.nativeElement;
    if (!el) return;
    // Prefer the element's real duration once known; fall back to the recorded duration input.
    const d = el.duration && Number.isFinite(el.duration) ? el.duration : this.duration();
    this.progress.set(d > 0 ? Math.min(1, el.currentTime / d) : 0);
    this.render();
  }

  seek(event: MouseEvent): void {
    const el = this.audioRef()?.nativeElement;
    const target = event.currentTarget as HTMLElement | null;
    if (!el || !target || this.inert()) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const duration =
      el.duration && Number.isFinite(el.duration) ? el.duration : this.duration();
    if (duration > 0) el.currentTime = ratio * duration;
    this.progress.set(ratio);
    this.render();
  }

  cycleRate(): void {
    const next = this.rate() === 1 ? 1.5 : this.rate() === 1.5 ? 2 : 1;
    this.rate.set(next);
    const el = this.audioRef()?.nativeElement;
    if (el) el.playbackRate = next;
    this.render();
  }

  onPlay(): void {
    this.played.set(true);
    this.playing.set(true);
    this.render();
  }
  onPause(): void {
    this.playing.set(false);
    this.render();
  }
  onEnded(): void {
    this.playing.set(false);
    this.progress.set(0);
    const el = this.audioRef()?.nativeElement;
    if (el) el.currentTime = 0;
    this.render();
  }
  onError(): void {
    this.failed.set(true);
    this.playing.set(false);
    this.render();
  }

  private render(): void {
    this.cdr.detectChanges();
  }
}
