import { Injectable, OnDestroy, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { getPushWorkerRegistration } from './push-worker-registration';
import { isTauri } from './runtime';
import { UpdateService } from './update.service';

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** Page-owned lifecycle for the two independent service-worker registrations.
 * Angular owns app-shell registration; push enrollment owns permission and creation.
 * Checks never gate authentication and never activate an app version on the user's behalf.
 */
@Injectable({ providedIn: 'root' })
export class ServiceWorkerLifecycleService implements OnDestroy {
  private readonly swUpdate = inject(SwUpdate);
  // Subscribe before starting checks, including while session restoration is pending.
  private readonly updates = inject(UpdateService);
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private destroyed = false;
  private appCheck?: Promise<void>;
  private pushCheck?: Promise<void>;

  start(): void {
    if (this.started || this.destroyed || isTauri()) return;
    this.started = true;
    this.checkForUpdates();
    this.timer = setInterval(() => this.checkForUpdates(), UPDATE_INTERVAL_MS);
  }

  checkForUpdates(): void {
    if (this.destroyed || isTauri()) return;
    // Separate single-flight lanes: an unavailable app-shell controller must not
    // prevent an existing notification worker from updating, or vice versa.
    if (this.swUpdate.isEnabled && !this.appCheck) {
      this.appCheck = Promise.resolve()
        .then(() => {
          if (!this.destroyed) return this.swUpdate.checkForUpdate();
          return undefined;
        })
        .then(() => undefined)
        .catch((error) => console.warn('[worker] app update check failed', error))
        .finally(() => { this.appCheck = undefined; });
    }
    if (!this.pushCheck) {
      this.pushCheck = getPushWorkerRegistration()
        .then(async (registration) => {
          if (!this.destroyed && registration) await registration.update();
        })
        .catch((error) => console.warn('[worker] push update check failed', error))
        .finally(() => { this.pushCheck = undefined; });
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    // Browser update operations cannot be cancelled. No late completion publishes
    // session state or starts another operation after this owner is destroyed.
  }
}
