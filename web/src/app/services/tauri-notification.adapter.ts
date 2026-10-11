import { inject } from '@angular/core';
import { UserService } from './user.service';
import { NotificationAdapter } from './notification-adapter';
import { apiOrigin, tauriInvoke } from './runtime';
import type { NotificationDescriptor } from './notification-descriptor.model';

/** Rust retains notification handles where supported. Android has its own native presentation. */
export class TauriNotificationAdapter extends NotificationAdapter {
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly sessionId: () => number | null = inject(UserService)
      .sessionId,
  ) {
    super();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch((error) => {
      console.warn('[notification] desktop operation failed', error);
    });
    return this.queue;
  }

  showDescriptor(d: NotificationDescriptor): Promise<void> {
    const generation = this.generation;
    const sessionId = this.sessionId();
    const origin = apiOrigin();
    return this.enqueue(async () => {
      if (
        generation !== this.generation ||
        !origin ||
        sessionId === null ||
        !Number.isSafeInteger(sessionId) ||
        sessionId <= 0 ||
        sessionId !== this.sessionId() ||
        origin !== apiOrigin()
      )
        return;
      await tauriInvoke<void>('desktop_notification_update', {
        notification: {
          threadId: d.data.threadId,
          sessionId,
          origin,
          title: d.title,
          body: d.body,
          count: d.count,
          silent: !!d.silent,
        },
      });
    });
  }

  clearThread(threadId: number): Promise<void> {
    const sessionId = this.sessionId();
    const origin = apiOrigin();
    if (sessionId === null) return Promise.resolve();
    return this.enqueue(async () => {
      if (sessionId !== this.sessionId() || origin !== apiOrigin()) return;
      await tauriInvoke<void>('desktop_notification_update', {
        notification: {
          threadId,
          sessionId,
          origin,
          title: '',
          body: '',
          count: 0,
          silent: true,
        },
      });
    });
  }

  /** Detach renderer work without dismissing persistent system cards. */
  dispose(): void {
    ++this.generation;
  }

  clear(): Promise<void> {
    ++this.generation;
    return this.enqueue(() =>
      tauriInvoke<void>('desktop_notifications_clear', {
        resetNavigation: false,
      }),
    );
  }
}
