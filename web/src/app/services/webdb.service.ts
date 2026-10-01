import { InjectionToken, Optional, inject } from '@angular/core';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbStorage, type StateFeedWorkerFactory } from './webdb-storage';
import { TauriWebdbStorage } from './tauri-webdb-storage';
import { isTauri } from './runtime';

export * from './webdb-storage';

const createBrowserStateFeedWorker: StateFeedWorkerFactory = () => {
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    return null;
  return new Worker(new URL('./state-feed-db.worker', import.meta.url), {
    type: 'module',
  });
};

export const STATE_FEED_WORKER_FACTORY =
  new InjectionToken<StateFeedWorkerFactory>('STATE_FEED_WORKER_FACTORY', {
    providedIn: 'root',
    factory: () => createBrowserStateFeedWorker,
  });

/**
 * Angular injection boundary for the platform database/storage layer.
 *
 * Browser: `WebdbStorage` owns IndexedDB + the `state-feed-db.worker` execution
 * layer. Tauri (desktop + Android): `TauriWebdbStorage` routes feed/DB work to
 * the Rust executor (`native_db_*`) and forwards Rust's local completion events
 * into the same `*Committed$` Subjects — no web Worker is ever created.
 *
 * Both specializations extend `WebdbStorage`; consumers inject `WebdbService`
 * (the token) and receive the platform-appropriate instance.
 */
export abstract class WebdbService extends WebdbStorage {}

/**
 * Factory that selects the platform specialization. Registered via
 * `provideWebdbService()` in the app providers (see `app.config.ts`).
 */
export function webdbServiceFactory(
  factory: StateFeedWorkerFactory,
  lifecycle: SessionLifecycleService | null,
): WebdbService {
  if (isTauri()) return new TauriWebdbStorage(lifecycle ?? undefined);
  return new WebdbStorage(factory, lifecycle ?? undefined) as WebdbService;
}

/** Provider that binds `WebdbService` to the browser or Tauri specialization. */
export function provideWebdbService() {
  return {
    provide: WebdbService,
    useFactory: webdbServiceFactory,
    deps: [
      STATE_FEED_WORKER_FACTORY,
      [new Optional(), SessionLifecycleService],
    ],
  };
}
