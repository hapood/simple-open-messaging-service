import type { NotificationDescriptor } from '../app/services/notification-descriptor.model';

const CARD_PREFIX = 'soms-card-';

/** The OS notification set is the durable ledger across service worker restarts.
 * Callers serialize operations with the notification projection lock. Never cache a
 * second list that can survive a user dismissal or a rejected showNotification. */
export class BrowserNotificationCards {
  constructor(
    private readonly registration: Pick<
      ServiceWorkerRegistration,
      'getNotifications' | 'showNotification'
    >,
  ) {}

  private async cards(threadId: number): Promise<Notification[]> {
    return (await this.registration.getNotifications()).filter(
      (card) =>
        card.tag.startsWith('soms-') && card.data?.threadId === threadId,
    );
  }

  async remove(threadId: number): Promise<void> {
    for (const card of await this.cards(threadId)) card.close();
  }

  async removeInstance(id: string): Promise<void> {
    for (const card of await this.registration.getNotifications({ tag: id })) {
      if (card.tag === id) card.close();
    }
  }

  async show(
    descriptor: NotificationDescriptor,
    sessionId: number,
  ): Promise<string> {
    const threadId = descriptor.data.threadId;
    if (!Number.isInteger(threadId) || threadId! <= 0)
      throw new Error('Invalid notification thread');
    const previous = await this.cards(threadId!);
    const current = previous.find((card) => card.tag.startsWith(CARD_PREFIX));
    const id = current?.tag ?? CARD_PREFIX + crypto.randomUUID();
    await this.registration.showNotification(descriptor.title, {
      body: descriptor.body,
      tag: id,
      data: { ...descriptor.data, sessionId, notificationId: id },
      icon: descriptor.icon ?? undefined,
      lang: descriptor.lang,
      silent: descriptor.silent,
      renotify: descriptor.renotify,
    } as NotificationOptions & { renotify: boolean });
    // Only retire legacy/duplicate cards after the replacement was accepted.
    for (const card of previous) if (card.tag !== id) card.close();
    return id;
  }
}
