import { computed, DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Wraps {@link SwUpdate} to surface "new version ready" as a reactive signal and to own the
 * activate-and-reload lifecycle.
 *
 * - `available()` latches `true` on `VERSION_READY` (a new bundle is downloaded and ready). The shell
 *   shows a non-intrusive banner with Reload / Dismiss; we never auto-activate — a chat mid-send is
 *   the wrong moment to swap the bundle, so the user picks the moment.
 * - `UNRECOVERABLE_STATE` (cached assets missing / hash mismatch) is unrecoverable by definition →
 *   a full reload is the only recovery, so we trigger one immediately.
 * - Update checks are scheduled by ServiceWorkerLifecycleService independently of session recovery.
 *
 * Instantiated during bootstrap before session restoration so early update events are retained
 * even while the root shell is still waiting to mount.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly swUpdate = inject(SwUpdate);

  /** True once a new app version is downloaded and ready to activate. Latched until reload/dismiss. */
  readonly available = signal(false);
  /** Convenience: whether the banner should render. Reserved for future gating (e.g. never in dev). */
  readonly bannerVisible = computed(() => this.available());

  constructor() {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(takeUntilDestroyed(this.destroyRef), filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.available.set(true));

    this.swUpdate.versionUpdates.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.type === 'VERSION_INSTALLATION_FAILED') {
        console.warn('[update] version failed', event);
      }
    });

    this.swUpdate.unrecoverable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      console.error('[update] unrecoverable state', event);
      // The SW cannot recover (a precached asset is missing/corrupt); only a full reload helps.
      location.reload();
    });

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

}
