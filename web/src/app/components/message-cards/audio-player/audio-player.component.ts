import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { formatDuration } from '../file-meta.util';
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
 */
@Component({
  selector: 'app-audio-player',
  imports: [],
  templateUrl: './audio-player.component.html',
  styleUrl: './audio-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AudioPlayerComponent {
  /** Audio source URL — a /uploads/shards/… CAS URL, or a blob: URL for an optimistic in-flight clip. */
  readonly src = input.required<string>();
  /** Clip duration in seconds (client-probed / recorded). Display + the progress denominator. */
  readonly duration = input(0);

  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
  /** Pause the clip — a STABLE callback (created once) so the coordinator can identify "this player" by
   *  reference and pause any other clip playing elsewhere in the app when this one starts. */
  private readonly coordinator = inject(AudioPlaybackCoordinator);
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
  readonly durLabel = computed(() => formatDuration(this.duration()));

  toggle(): void {
    const el = this.audioRef()?.nativeElement;
    if (!el || this.failed()) return;
    if (this.playing()) {
      el.pause();
      return;
    }
    // Pause any other voice clip currently playing elsewhere in the app (single-active, WhatsApp-style).
    this.coordinator.begin(this.pauseFn);
    // el.play() resolves on success (the 'play' event then sets `playing`); it rejects when the browser
    // blocks it (rare for a user-gesture-initiated play) or the source is unplayable → mark failed.
    void el.play().catch(() => this.failed.set(true));
  }

  onTimeUpdate(): void {
    const el = this.audioRef()?.nativeElement;
    if (!el) return;
    // Prefer the element's real duration once known; fall back to the recorded duration input.
    const d = el.duration && Number.isFinite(el.duration) ? el.duration : this.duration();
    this.progress.set(d > 0 ? Math.min(1, el.currentTime / d) : 0);
  }

  onPlay(): void { this.playing.set(true); }
  onPause(): void { this.playing.set(false); }
  onEnded(): void {
    this.playing.set(false);
    this.progress.set(0);
    const el = this.audioRef()?.nativeElement;
    if (el) el.currentTime = 0;
  }
  onError(): void {
    this.failed.set(true);
    this.playing.set(false);
  }
}
