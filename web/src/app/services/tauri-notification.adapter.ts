import { inject } from '@angular/core';
import { SessionLifecycleService } from './session-lifecycle.service';
import { tauriInvoke } from './runtime';

/** Page-side dismissal only. Native message presentation is owned by Rust. */
export class TauriNotificationAdapter {
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly lifecycle: Pick<SessionLifecycleService, 'capture' | 'isCurrent'> = inject(SessionLifecycleService),
  ) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch((error) => {
      console.warn('[notification] desktop operation failed', error);
    });
    return this.queue;
  }

  presentationChanged(): Promise<void> {
    const scope = this.lifecycle.capture();
    return this.enqueue(async () => {
      if (this.disposed || !scope.sessionId || !this.lifecycle.isCurrent(scope)) return;
      await tauriInvoke<void>('desktop_notification_presentation_changed');
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  clear(): Promise<void> {
    return this.enqueue(() => tauriInvoke<void>('desktop_notifications_clear', { resetNavigation: false }));
  }
}
