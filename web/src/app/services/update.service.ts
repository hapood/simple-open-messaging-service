import { computed, Injectable, inject, OnDestroy, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Polling interval for `checkForUpdate()`. The SW checks for an update automatically on registration
 * and on navigation, but a long-lived chat tab can sit on one route for hours — a mid-session deploy
 * would otherwise go unnoticed until reload. This poll closes that window.
 */
const UPDATE_POLL_MS = 60 * 60 * 1000;

/**
 * Wraps {@link SwUpdate} to surface "new version ready" as a reactive signal and to own the
 * activate-and-reload lifecycle.
 *
 * - `available()` latches `true` on `VERSION_READY` (a new bundle is downloaded and ready). The shell
 *   shows a non-intrusive banner with Reload / Dismiss; we never auto-activate — a chat mid-send is
 *   the wrong moment to swap the bundle, so the user picks the moment.
 * - `UNRECOVERABLE_STATE` (cached assets missing / hash mismatch) is unrecoverable by definition →
 *   a full reload is the only recovery, so we trigger one immediately.
 * - On construction we also start a 60-minute `checkForUpdate` poll so a deploy during a long open
 *   tab is detected without relying on navigation.
 *
 * Eagerly instantiated by `AppComponent` (injected alongside ThemeService/LanguageService) so the
 * subscriptions are live for the whole session — `versionUpdates` is a hot stream and a late
 * subscriber would miss the initial `VERSION_READY`.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService implements OnDestroy {
  private readonly swUpdate = inject(SwUpdate);
  private readonly pollHandle?: ReturnType<typeof setInterval>;

  /** True once a new app version is downloaded and ready to activate. Latched until reload/dismiss. */
  readonly available = signal(false);
  /** Convenience: whether the banner should render. Reserved for future gating (e.g. never in dev). */
  readonly bannerVisible = computed(() => this.available());

  constructor() {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.available.set(true));

    this.swUpdate.unrecoverable.subscribe(() => {
      // The SW cannot recover (a precached asset is missing/corrupt); only a full reload helps.
      location.reload();
    });

    this.pollHandle = setInterval(() => {
      // checkForUpdate resolves `true` if a new version was found and is being downloaded; a
      // subsequent VERSION_READY will latch `available`. Errors (e.g. transient network) are
      // non-fatal — the next poll retries.
      this.swUpdate.checkForUpdate().catch(() => void 0);
    }, UPDATE_POLL_MS);
  }

  /** Activate the downloaded version and reload into it. */
  async applyUpdate(): Promise<void> {
    if (!this.swUpdate.isEnabled) return;
    try {
      await this.swUpdate.activateUpdate();
    } finally {
      // Reload whether or not activation succeeded — at worst we re-evaluate against the cached copy.
      location.reload();
    }
  }

  /** Dismiss for this session; a subsequent VERSION_READY re-latches the banner. */
  dismiss(): void {
    this.available.set(false);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }
}
