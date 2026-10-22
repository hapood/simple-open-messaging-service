import { inject, Injectable } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { QrScannerComponent } from '../components/qr-scanner/qr-scanner.component';

/**
 * Opens the hybrid QR scanner as a fullscreen CDK overlay and resolves with the decoded content.
 *
 * "Hybrid" = the native barcode-scanner plugin owns the camera (CameraX + ML Kit) but renders it BEHIND a
 * transparent WebView (`windowed: true`), so a normal Angular component ({@link QrScannerComponent}) draws
 * the scan UI on top of the live feed — native camera performance + a themed, i18n Angular chrome. This
 * service owns only the overlay lifecycle and the promise that `linkDevice()` awaits; the component owns the
 * scan() promise, the permission flow, the hardware-back hook, and the UI.
 *
 * While open, a global `html.qr-scanning` class (web/src/styles.scss) hides the app behind and makes `<body>`
 * transparent so the camera is visible through the overlay's cutout. Mirrors the CDK mechanics of
 * {@link TransientOverlayService} (global position, scroll-block, dispose-on-navigation) but is promise-driven,
 * not nav-pane-stack-driven — the scan returns a value and is not part of chat navigation.
 *
 * Android-only in practice: reached solely from Settings → Devices → Link a device, which is gated by
 * `isAndroidNative()`, and the scanner component (which imports the plugin) is lazy-loaded here so browser /
 * desktop bundles never load it.
 */
@Injectable({ providedIn: 'root' })
export class QrScannerService {
  private readonly overlay = inject(Overlay);
  private ref: OverlayRef | null = null;
  /** Subscriptions to the component's outputs — torn down on dispose so a late plugin callback can't reach a
   *  settled promise. Duck-typed (Angular `output().subscribe()` returns OutputRefSubscription, not an rxjs
   *  Subscription — cf. transient-overlay.service.ts's closeSub). */
  private subs: { unsubscribe(): void }[] = [];
  /** The in-flight promise, also the re-entrancy guard (a second open() while open returns the same one). */
  private inflight: Promise<string | null> | null = null;
  private resolveFn: ((v: string | null) => void) | null = null;
  private rejectFn: ((e: unknown) => void) | null = null;

  /**
   * Open the scanner; resolve with the decoded QR content, or `null` if the user cancelled (Cancel / hardware
   * back / Esc). Rejects on an unexpected scan failure (camera/ML Kit/lazy-load error) so the caller can
   * surface a toast. Re-entering while already open returns the in-flight promise (no second overlay).
   */
  async open(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doOpen();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doOpen(): Promise<string | null> {
    // Lazy-load the component so the plugin (and this UI) stay out of the browser/desktop bundle — the same
    // discipline linkDevice() used when it imported the plugin directly.
    const { QrScannerComponent } = await import('../components/qr-scanner/qr-scanner.component');
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      disposeOnNavigation: true,
      panelClass: 'qr-scan-pane',
    });
    this.ref = ref;
    document.documentElement.classList.add('qr-scanning');

    const cmp = ref.attach(new ComponentPortal(QrScannerComponent));
    const inst = cmp.instance;
    const done = new Promise<string | null>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
      this.subs = [
        inst.scanned.subscribe((content) => this.finish(content)),
        inst.close.subscribe(() => this.finish(null)),
        inst.failed.subscribe((err) => this.finish(null, err)),
      ];
    });
    cmp.changeDetectorRef.detectChanges(); // zoneless: drive the first render
    ref.detachments().subscribe(() => this.onDetach()); // navigation while scanning → settle as cancel
    return done;
  }

  /** Settle the promise (content on success, null on cancel) or reject (failure); idempotent. */
  private finish(result: string | null, err?: unknown): void {
    const resolve = this.resolveFn;
    const reject = this.rejectFn;
    if (!resolve || !reject) return; // already settled (a late callback after dispose)
    this.resolveFn = null;
    this.rejectFn = null;
    this.dispose();
    if (err !== undefined) reject(err);
    else resolve(result);
  }

  /** The CDK overlay detached on its own (disposeOnNavigation fired while scanning) — settle as a cancel. */
  private onDetach(): void {
    this.ref = null;
    document.documentElement.classList.remove('qr-scanning');
    this.finish(null);
  }

  private dispose(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    this.ref?.dispose();
    this.ref = null;
    document.documentElement.classList.remove('qr-scanning');
  }
}
