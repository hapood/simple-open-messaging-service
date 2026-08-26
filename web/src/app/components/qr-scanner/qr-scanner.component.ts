import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  output,
  signal,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { AppBackDispatcherService } from '../../services/app-back-dispatcher.service';

/** How long the green-check "captured" badge holds over the cutout before the overlay dismisses — long enough
 *  to register that the decode succeeded, short enough not to feel laggy. Mirrors the qr-login-page scanned
 *  badge so both sides of QR sign-in share one confirmation cue. */
const CAPTURED_BADGE_MS = 320;

/** Square transparent cutout the user aims at the QR. Viewport-relative so it fits any phone, capped so
 *  tablets don't get an oversized frame. Horizontal/viewport sizing is exempt from the integer-px rule —
 *  this overlay is not a virtual-scroll measured item, only its text/button heights use integer px. */
const CUTOUT = 'min(72vw, 72vh, 320px)';

type Plugin = typeof import('@tauri-apps/plugin-barcode-scanner');

/**
 * Extract a human-readable message from any rejection shape. Tauri `invoke` surfaces a Kotlin/Rust
 * rejection as a serialized plain object (e.g. `{ message: 'cancelled' }`), not an `Error` instance, so
 * `String(err)` alone yields "[object Object]". Read `.message` from either an Error or a plain object,
 * falling back to a JSON dump / String() so the cancel-detection regex always sees real text.
 */
function rejectionMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    return typeof m === 'string' ? m : JSON.stringify(err);
  }
  return String(err);
}

/**
 * Hybrid QR scan overlay (the phone side of "Link a device"): the native barcode-scanner plugin owns the
 * camera (CameraX + ML Kit) but is invoked with `windowed: true`, which brings the WebView on top of the
 * live feed and makes it transparent — so this Angular component draws the scan UI (title, scan frame, hint,
 * Cancel) directly over the camera. The camera shows through the transparent cutout; the surrounding scrim is
 * painted by the cutout's box-shadow (see the SCSS). Mounted by {@link QrScannerService} in a CDK overlay.
 *
 * Lifecycle is the `scan()` promise: resolve → flash a green-check badge → emit `scanned`; a "cancelled"
 * rejection (back / Cancel / Esc) → emit `close`; any other rejection → emit `failed` (caller toasts).
 * Camera permission is pre-flighted so a denial becomes a recoverable "Open settings" state instead of an
 * opaque "No permission" throw. Self-contained — only emits results; the service disposes the overlay.
 *
 * Android-only in practice: the service is reached solely from Settings → Devices → Link a device, which is
 * `isAndroidNative()`-gated, and the plugin is dynamically imported so browser/desktop bundles never load it.
 */
@Component({
  selector: 'app-qr-scanner',
  imports: [MatButtonModule, TranslocoPipe, IconComponent],
  templateUrl: './qr-scanner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './qr-scanner.component.scss',
})
export class QrScannerComponent implements OnInit, OnDestroy {
  readonly AppIconType = AppIconType;
  /** Cutout size, bound to the template as the `--cutout` CSS var on the stage. */
  readonly cutout = CUTOUT;

  /** 'denied' swaps the live-camera stage for an opaque, themed "permission denied" panel. */
  readonly state = signal<'scanning' | 'denied'>('scanning');
  /** Flashed for ~CAPTURED_BADGE_MS over the cutout once a QR is decoded, before the overlay dismisses. */
  readonly captured = signal(false);

  /** Emits the decoded QR content (the overlay then dismisses with this result). */
  readonly scanned = output<string>();
  /** Emits on user cancel (Cancel / hardware back / Esc) — the overlay dismisses with no result. */
  readonly close = output<void>();
  /** Emits on an unexpected scan failure (camera/ML Kit/lazy-load error) — the caller surfaces a toast. */
  readonly failed = output<unknown>();

  private readonly appBack = inject(AppBackDispatcherService);
  private unregisterBack?: () => void;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cached dynamic import of the plugin (module singleton) — avoids re-importing on cancel. */
  private pluginPromise: Promise<Plugin> | null = null;
  /** True while a native scan() is in flight, so ngOnDestroy can cancel it (tear down the camera). */
  private scanning = false;
  /** True once any result has been emitted — makes late plugin callbacks (after destroy) harmless no-ops. */
  private settled = false;

  ngOnInit(): void {
    // Register above ordinary app navigation while the native scan surface is alive.
    this.unregisterBack = this.appBack.register(() => {
      void this.cancelScan();
    });
    void this.start();
  }

  ngOnDestroy(): void {
    this.unregisterBack?.();
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    // If still mid-scan (e.g. the overlay was disposed by navigation), tear down the camera and reject the
    // plugin's savedInvoke so no native camera is orphaned. cancel() is a no-op if already torn down.
    if (this.scanning) void this.cancelNative();
  }

  /** Cancel button + Esc + hardware-back. Mid-scan, tears down the camera (scan() then rejects "cancelled"
   *  and start()'s catch emits `close`); when idle / denied there is no native scan to cancel, so dismiss
   *  directly. Either way the overlay closes — important so Cancel always works in the denied state, where
   *  `scanning` is false and there is no scan() promise to reject. */
  async cancelScan(): Promise<void> {
    if (this.scanning) {
      await this.cancelNative();
    } else {
      this.close.emit();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      void this.cancelScan();
    }
  }

  /** On returning to the foreground while on the denied panel — typically after the user tapped "Open
   *  settings" and granted the camera — re-check and resume automatically, so they don't have to Cancel and
   *  re-tap "Link a device". `visibilitychange` is the same signal SseLifecycleService relies on for Android
   *  background detection, so it reliably fires on activity resume. Guarded on `state() === 'denied'` so it
   *  never disturbs an active scan. */
  @HostListener('document:visibilitychange')
  onVisibility(): void {
    if (document.visibilityState === 'visible' && this.state() === 'denied')
      void this.start();
  }

  /** "Open settings" on the denied panel — bounce to the system permission screen so the user can grant. */
  async openSettings(): Promise<void> {
    const p = await this.plugin();
    await p.openAppSettings();
  }

  /** Pre-flight the camera permission, then run the native scan and translate its outcome into an output. */
  private async start(): Promise<void> {
    const p = await this.plugin();
    try {
      // A denial becomes a recoverable "Open settings" state rather than an opaque "No permission" throw
      // from scan() (which would otherwise reject before the windowed preview is even set up).
      let perm = await p.checkPermissions();
      if (perm !== 'granted') perm = await p.requestPermissions();
      if (perm !== 'granted') {
        this.state.set('denied');
        return;
      }

      // Permission confirmed (or just granted on resume) — show the cutout again before the native scan
      // kicks off (no-op on first enter, where state is already 'scanning'; flips denied→scanning on resume).
      this.state.set('scanning');
      this.scanning = true;
      const res = await p.scan({
        formats: [p.Format.QRCode],
        cameraDirection: 'back',
        windowed: true,
      });
      this.scanning = false;
      if (this.settled || !res.content) return;
      this.captured.set(true);
      // Tactile confirmation — the universal mobile-scanner convention. navigator.vibrate is a standard Web
      // API supported by the Android WebView (Chromium); best-effort, silently no-ops where unsupported.
      navigator.vibrate?.(50);
      // Hold the confirmation badge briefly so the user sees the decode register before the overlay closes.
      this.badgeTimer = setTimeout(
        () => this.emitScanned(res.content),
        CAPTURED_BADGE_MS,
      );
    } catch (err) {
      this.scanning = false;
      if (this.settled) return;
      // The plugin rejects on a user dismiss with a plain object `{ message: 'cancelled' }` — NOT an Error
      // instance (Tauri `invoke` surfaces the Kotlin rejection as a serialized object). So read `.message`
      // from either shape before matching, otherwise `String({message:'cancelled'})` is "[object Object]"
      // and the cancel is misrouted to `failed` (showing a spurious "scan failed" toast + error log).
      const msg = rejectionMessage(err);
      // "cancelled" is the one benign outcome (back / Cancel / tapping outside) — surfaced as a plain close.
      // Everything else is a real failure (permission, ML Kit model, capability, lazy-load) routed to the
      // caller's toast via `failed`.
      if (/cancel/i.test(msg)) this.close.emit();
      else this.failed.emit(err);
    }
  }

  private emitScanned(content: string): void {
    if (this.settled) return;
    this.settled = true;
    this.scanned.emit(content);
  }

  private plugin(): Promise<Plugin> {
    return (
      this.pluginPromise ??
      (this.pluginPromise = import('@tauri-apps/plugin-barcode-scanner'))
    );
  }

  private async cancelNative(): Promise<void> {
    try {
      const p = await this.plugin();
      await p.cancel();
    } catch {
      // Plugin unavailable or already torn down — nothing to cancel.
    }
  }
}
