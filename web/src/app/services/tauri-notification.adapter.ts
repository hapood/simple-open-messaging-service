import { NotificationAdapter } from './notification-adapter';
import { tauriInvoke } from './runtime';
import type { NotificationDescriptor } from './notification-descriptor.model';

/** Rust retains notification handles where supported. Android has its own native presentation. */
export class TauriNotificationAdapter extends NotificationAdapter {
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch((error) => {
      console.warn('[notification] desktop operation failed', error);
    });
    return this.queue;
  }

  showDescriptor(d: NotificationDescriptor): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      await tauriInvoke<void>('desktop_notification_update', {
        notification: {
          threadId: d.data.threadId,
          title: d.title,
          body: d.body,
          count: d.count,
          silent: !!d.silent,
        },
      });
    });
  }

  clearThread(threadId: number): Promise<void> {
    return this.enqueue(() =>
      tauriInvoke<void>('desktop_notification_update', {
        notification: { threadId, title: '', body: '', count: 0, silent: true },
      }),
    );
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
