import type { NotificationDescriptor } from '../app/services/notification-descriptor.model';

const CARD_PREFIX = 'soms-card-';

/** The OS supplies restart candidates once. During reconstruction, removal events
 * retire the in-memory instances; normal delivery still queries the current OS set.
 * Callers serialize projection work with the notification projection lock. */
export class BrowserNotificationCards {
  private lastAcceptedAlert: number | undefined;
  private readonly reconstructionCards = new Map<string, Notification>();

  reset(): void {
    this.reconstructionCards.clear();
    this.lastAcceptedAlert = undefined;
  }

  /** Event observation only; do not enumerate, retry or rebuild on a missed match. */
  dismissed(id: string): void {
    if (typeof id !== 'string' || !id.startsWith(CARD_PREFIX)) return;
    if (!this.reconstructionCards.delete(id))
      console.warn('[notification] removal observation has no matching reconstruction instance');
  }

  constructor(
    private readonly registration: Pick<
      ServiceWorkerRegistration,
      'getNotifications' | 'showNotification'
    >,
    private readonly alertPolicy: () => Promise<string | undefined> = async () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private async cards(threadId: number): Promise<Notification[]> {
    return (await this.registration.getNotifications()).filter(
      (card) =>
        card.tag.startsWith('soms-') && card.data?.threadId === threadId,
    );
  }

  async remove(threadId: number): Promise<void> {
    for (const card of await this.cards(threadId)) {
      this.reconstructionCards.delete(card.tag);
      card.close();
    }
  }

  async removeInstance(id: string): Promise<void> {
    this.reconstructionCards.delete(id);
    for (const card of await this.registration.getNotifications({ tag: id })) {
      if (card.tag === id) card.close();
    }
  }

  /** Capture only message instances, never probe/call cards. Page restoration
   * disables new offline delivery first; already in-flight work is not drained. */
  async reconstructionCandidates(): Promise<Map<string, number>> {
    const observed = (await this.registration.getNotifications()).filter((card) => {
      const threadId = card.data?.threadId;
      return card.tag.startsWith(CARD_PREFIX) && Number.isInteger(threadId) && threadId > 0;
    });
    // Match native restoration: select deterministically, without treating an
    // opaque instance ID as a timestamp or depending on OS enumeration order.
    observed.sort((a, b) => a.data.threadId - b.data.threadId ||
      (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    this.reconstructionCards.clear();
    const retained = new Map<string, number>();
    const threads = new Set<number>();
    for (const card of observed) {
      const threadId: number = card.data.threadId;
      if (threads.has(threadId)) {
        card.close();
      } else {
        threads.add(threadId);
        retained.set(card.tag, threadId);
        this.reconstructionCards.set(card.tag, card);
      }
    }
    return retained;
  }

  /** `merged` must cover the complete current projection, not a feed delta.
   * No new instances are allocated and a failed update can retry with the same candidates. */
  async reconstruct(
    candidates: ReadonlyMap<string, number>,
    merged: readonly NotificationDescriptor[],
    sessionId: number,
  ): Promise<void> {
    const projection = new Map(merged.map((descriptor) => [descriptor.data.threadId, descriptor]));
    for (const [id, threadId] of candidates) {
      const descriptor = projection.get(threadId);
      if (!descriptor || descriptor.count <= 0) {
        const card = this.reconstructionCards.get(id);
        this.reconstructionCards.delete(id);
        card?.close();
      } else {
        await this.show({ ...descriptor, silent: true }, sessionId, id);
      }
    }
    // Only a fully completed reconstruction releases the retained OS resources.
    this.reconstructionCards.clear();
  }

  show(descriptor: NotificationDescriptor, sessionId: number): Promise<string>;
  show(descriptor: NotificationDescriptor, sessionId: number, existingInstance: string): Promise<string | undefined>;
  async show(
    descriptor: NotificationDescriptor,
    sessionId: number,
    existingInstance?: string,
  ): Promise<string | undefined> {
    const threadId = descriptor.data.threadId;
    if (!Number.isInteger(threadId) || threadId! <= 0)
      throw new Error('Invalid notification thread');
    const policy = (await this.alertPolicy()) ?? 'cooldown_5s';
    const previous = existingInstance ? [] : await this.cards(threadId!);
    const current = existingInstance
      ? this.reconstructionCards.get(existingInstance)
      : previous.find((card) => card.tag.startsWith(CARD_PREFIX));
    // Reconstruction uses the event-maintained candidate set, not repeated OS queries.
    if (existingInstance && (!current || current.data?.threadId !== threadId)) return undefined;
    const id = current?.tag ?? CARD_PREFIX + crypto.randomUUID();
    if (!['cooldown_2s', 'cooldown_5s', 'once_per_thread'].includes(policy))
      throw new Error('Invalid notification alert policy');
    const eligible = policy === 'once_per_thread'
      ? current?.data?.hasAcceptedAlert !== true
      : this.lastAcceptedAlert === undefined ||
        this.now() - this.lastAcceptedAlert >= (policy === 'cooldown_2s' ? 2000 : 5000);
    const alert = !descriptor.silent && eligible;
    await this.registration.showNotification(descriptor.title, {
      body: descriptor.body,
      tag: id,
      data: {
        ...descriptor.data, sessionId, notificationId: id,
        hasAcceptedAlert: current?.data?.hasAcceptedAlert === true || alert,
      },
      icon: descriptor.icon ?? undefined,
      lang: descriptor.lang,
      silent: !alert,
      renotify: alert,
    } as NotificationOptions & { renotify: boolean });
    if (alert) this.lastAcceptedAlert = this.now();
    // Only retire legacy/duplicate cards after the replacement was accepted.
    if (!existingInstance) {
      for (const card of previous) if (card.tag !== id) card.close();
    }
    return id;
  }
}
