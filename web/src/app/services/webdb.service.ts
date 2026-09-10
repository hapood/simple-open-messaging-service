import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbStorage, type StateFeedWorkerFactory } from './webdb-storage';

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

/** Angular injection boundary; schema, transactions and cache lifetime stay in shared storage. */
@Injectable({ providedIn: 'root' })
export class WebdbService extends WebdbStorage {
  constructor(
    @Inject(STATE_FEED_WORKER_FACTORY)
    factory: StateFeedWorkerFactory = createBrowserStateFeedWorker,
    @Optional() lifecycle?: SessionLifecycleService,
  ) {
    super(factory, lifecycle);
  }

  ngOnDestroy(): void {
    this.dispose();
  }
}
