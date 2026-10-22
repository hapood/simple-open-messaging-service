import { effect, inject, Injectable } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { CallEventService } from './call-event.service';
import { CallScreenComponent } from '../components/call-screen/call-screen.component';
import { CallPresentationService } from './call-presentation.service';

/**
 * Mounts the {@link CallScreenComponent} as a fullscreen BODY-LEVEL CDK overlay (a sibling of `<app-root>`,
 * NOT a descendant) for the duration of an active call, and toggles the `html.in-video-call` transparency
 * treatment on VIDEO calls so the native remote SurfaceViewRenderer — a sibling view rendered BEHIND the
 * WebView by `CallController` — is visible through the transparent call chrome.
 *
 * Why a CDK overlay and not a component nested in `app.component.html`: the proven transparency trick (see
 * `html.qr-scanning` in `styles.scss`, cloned here as `html.in-video-call`) is `app-root { opacity: 0 }` +
 * `body { background-color: transparent }`, which lets the native video show through wherever the Angular
 * markup is transparent. `opacity: 0` on an ancestor also composites every descendant to 0 AND makes that
 * ancestor the containing block for its fixed-position children (CSS spec), so the call UI MUST be a
 * body-level sibling of `<app-root>` — exactly the `.qr-scan-pane` architecture — or it disappears along
 * with the app behind it. (This was the Phase 4 video bug: the call-screen was nested in `app-root`, so its
 * `.call-screen.video { background: transparent }` was correct but ineffective — the opaque `body`/`app-root`
 * behind it blocked the native video.)
 *
 * Open/close is driven purely by {@link CallEventService.callState} (phase !== 'idle' ⇒ open), so a WebView
 * recreate mid-call re-mounts the chrome and re-binds instantly: the native call survives the renderer reset
 * (it owns the PC + surfaces), Angular re-derives via `getSnapshot()`, and this service re-opens the overlay
 * on the next `callState` read. Mirrors {@link QrScannerService}'s CDK mechanics (global top-left position,
 * scroll-block) but is signal-driven, not promise-driven — a call has no return value; it ends and the
 * overlay disposes.
 */
@Injectable({ providedIn: 'root' })
export class CallOverlayService {
  private readonly overlay = inject(Overlay);
  private readonly events = inject(CallEventService);
  private readonly presentation = inject(CallPresentationService);
  /** The active call overlay, or null when no call is active. Single-slot re-entrancy guard. */
  private ref: OverlayRef | null = null;

  constructor() {
    // Re-evaluated on every callState change. effect() needs an injection context; the service ctor provides
    // one (providedIn: 'root' → constructed lazily on first inject, here eagerly from AppComponent).
    effect(() => {
      const state = this.events.callState();
      const active = state.phase !== 'idle';
      const minimized = this.presentation.minimized();
      const video = active && !minimized && state.callType === 'VIDEO';
      // The transparency treatment is VIDEO-only — an AUDIO call keeps the opaque dark .call-screen bg.
      document.documentElement.classList.toggle('in-video-call', video);
      const fullscreen = active && !minimized;
      if (fullscreen && !this.ref) this.open();
      else if (!fullscreen && this.ref) this.close();
      if (!active) this.presentation.restore();
    });
  }

  private open(): void {
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0'),
      // The fullscreen call surface blocks interaction itself. A noop strategy lets the chat remain scrollable
      // while the same overlay renders the compact in-app call window.
      scrollStrategy: this.overlay.scrollStrategies.noop(),
      panelClass: 'call-pane',
      // NOT disposeOnNavigation: a call persists across in-app navigation (the user may browse threads
      // mid-call); the callState signal — not navigation — owns this overlay's lifecycle.
    });
    this.ref = ref;
    const cmp = ref.attach(new ComponentPortal(CallScreenComponent));
    cmp.changeDetectorRef.detectChanges(); // zoneless: drive the first render so afterNextRender (rect reporting) fires
  }

  private close(): void {
    this.ref?.dispose();
    this.ref = null;
  }
}
