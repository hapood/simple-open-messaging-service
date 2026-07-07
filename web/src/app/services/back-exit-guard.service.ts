import { inject, Injectable, OnDestroy } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { MatSnackBar, type MatSnackBarRef, type TextOnlySnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { filter } from 'rxjs';
import { isAndroid, isTauri, tauriInvoke } from './runtime';

/**
 * Back-exit guard + boot deep-link normalization for the browser + desktop shell. Together they give the
 * app a single predictable "controlled history" so the back button never silently leaves:
 *
 *   chat → back → home        (a normal router pop — home is always history layer 1, because drilling
 *                              into a chat PUSHES via HomeShell.openChat AND any boot deep-link is
 *                              normalized to [home, route] — see {@link sync}); then
 *   home → back → toast       (swallowed + "press back again to exit"); then
 *   home → back again (≤2 s) → exit.
 *
 * Android is excluded — hardware back is handled natively there (back-at-home exits, the platform norm)
 * and deep-links arrive via `__SOMS_PENDING_THREAD_ID__` + PushService — so the service self-disables
 * under `isTauri() && isAndroid()`.
 *
 * BOOT DEEP-LINK: a browser/desktop tab can be launched or refreshed directly on a non-home route
 * (`/chat/2`, even `/chat/2(aside:group-info)`). main.ts captures that route and rewrites the URL to `/`
 * BEFORE Angular boots, so the app boots on the list (layer 1); the first {@link sync} then PUSHES the
 * captured route on top (layer 2). The stack ends up `[home, anchor, route]` exactly like a list→chat
 * drill-in, so back→home works uniformly and the chat kernel mounts only once.
 *
 * ANCHOR: whenever we sit on bare home, push a hidden `pushState` anchor (tagged `soms-home-exit`, same
 * URL → invisible) so the first back is swallowed: toast + re-push. The second back within
 * {@link EXIT_WINDOW_MS} exits — desktop invokes the Rust `exit_app` command (clean quit,
 * src-tauri/src/lib.rs); browser jumps to the earliest session entry (the page that preceded the SPA — a
 * no-op if the app is itself the first entry, e.g. an installed PWA launched directly).
 *
 * The tag keeps us out of the way of the dialog / search / overlay sentinels (`soms-dlg` / `soms-search`
 * / per-overlay), which push their own tagged entries above ours: a popstate landing on one of those, or
 * back on our own anchor (overlay closed above it, or chat→home), is NOT a home back and is ignored.
 * Mirrors the history-sentinel convention used across the app (RouteService / TransientOverlayService /
 * SearchService).
 */
@Injectable({ providedIn: 'root' })
export class BackExitGuardService implements OnDestroy {
  private static readonly TAG = 'soms-home-exit';
  private static readonly EXIT_WINDOW_MS = 2000;

  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);

  /** Boot deep-link captured by main.ts (URL rewritten to `/`); pushed once home is anchored, then nulled. */
  private pendingBootRoute: string | null = null;
  /** First NavigationEnd consumed (the one chance to read `window.__SOMS_BOOT_ROUTE__`). */
  private bootHandled = false;
  /** True iff our anchor currently sits atop bare home (home is armed). */
  private anchored = false;
  /** epoch ms of the toast-priming back; null when not primed. The window check expires it — no timer. */
  private lastPrime: number | null = null;
  private toast: MatSnackBarRef<TextOnlySnackBar> | null = null;

  private readonly onPopState = () => this.handlePopState();

  constructor() {
    // Android handles hardware back natively; the guard is browser + desktop only.
    if (isTauri() && isAndroid()) return;
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.sync());
    window.addEventListener('popstate', this.onPopState);
    // The router's initial navigation completes BEFORE the root component is constructed, so this guard
    // (injected in AppComponent) subscribes to router.events too late to receive that first NavigationEnd
    // — sync() would never run at boot, no anchor would be pushed, and browser-back at `/` (a single
    // history entry) would silently leave the SPA with no popstate to intercept. Sync once now against the
    // already-current URL. Idempotent with the subscription above (which covers subsequent navigations).
    this.sync();
  }

  ngOnDestroy(): void {
    window.removeEventListener('popstate', this.onPopState);
  }

  /** Bare home = path `/` with no `aside` outlet (`/(aside:settings)` is NOT bare home). Reads the live
   *  `location.path()` so the result is correct mid-popstate (router.url can be stale there). */
  private isHome(): boolean {
    const url = this.location.path();
    const path = url.split('?')[0];
    return (path === '/' || path === '') && !url.includes('(aside:');
  }

  private sync(): void {
    // On the first navigation: pick up a boot deep-link main.ts stashed (URL rewritten to `/`).
    if (!this.bootHandled) {
      this.bootHandled = true;
      const boot = window.__SOMS_BOOT_ROUTE__;
      if (boot) {
        window.__SOMS_BOOT_ROUTE__ = undefined;
        this.pendingBootRoute = boot;
      }
    }

    if (this.isHome()) {
      if (!this.anchored) {
        history.pushState({ tag: BackExitGuardService.TAG }, '');
        this.anchored = true;
      }
    } else if (this.anchored) {
      // Left bare home (opened a chat / aside / auth) — the anchor entry is gone (traversed/replaced).
      this.anchored = false;
      this.lastPrime = null;
    }

    // Push the boot deep-link ONCE, after home (layer 1) + its anchor are in place, so the stack is
    // [home, anchor, deepLink] — identical to a list→chat drill-in. back then walks deepLink→home.
    if (this.pendingBootRoute && this.anchored) {
      const route = this.pendingBootRoute;
      this.pendingBootRoute = null;
      void this.router.navigateByUrl(route);
    }
  }

  private handlePopState(): void {
    const state = history.state as { tag?: string } | null;
    // Landed on another handler's sentinel (dialog / search / overlay) — not ours; ignore.
    if (state?.tag && state.tag !== BackExitGuardService.TAG) return;
    // Landed back on our own anchor (overlay closed above it / chat→home): still armed, ignore.
    if (state?.tag === BackExitGuardService.TAG) return;
    // Not bare home — the router / aside outlet owns this back (e.g. mid-chat).
    if (!this.isHome()) return;

    // Bare home + no sentinel tag → "back at home": press-again-to-exit.
    const now = Date.now();
    if (this.lastPrime !== null && now - this.lastPrime < BackExitGuardService.EXIT_WINDOW_MS) {
      // Second press within the window → exit. Do not re-anchor.
      this.lastPrime = null;
      this.dismissToast();
      this.exit();
    } else {
      // First press → toast + re-push the anchor so this back is swallowed (stay on home).
      this.lastPrime = now;
      this.showToast();
      history.pushState({ tag: BackExitGuardService.TAG }, '');
      this.anchored = true;
    }
  }

  private exit(): void {
    if (isTauri()) {
      // Desktop: clean quit via the Rust exit_app command.
      void tauriInvoke('exit_app');
    } else {
      // Browser: jump to the earliest session entry (index 0) — the page that preceded the SPA in this
      // tab, if any → leaves the app. If the SPA IS the first entry (cold start / installed PWA), index 0
      // is the app itself and this is a no-op (nowhere to go). history.go overshoot clamps safely to 0.
      history.go(-history.length);
    }
  }

  private showToast(): void {
    this.dismissToast();
    this.toast = this.snackBar.open(this.transloco.translate('home.pressAgainToExit'), undefined, {
      duration: BackExitGuardService.EXIT_WINDOW_MS,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  private dismissToast(): void {
    if (this.toast) {
      this.toast.dismiss();
      this.toast = null;
    }
  }
}
