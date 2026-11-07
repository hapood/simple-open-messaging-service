import { describe, it, expect, vi } from 'vitest';
import { BrowserNotificationCards } from '../../push/notification-cards';
import type { NotificationDescriptor } from './notification-descriptor.model';

const descriptor: NotificationDescriptor = {
  kind: 'thread-message',
  title: 'Peer',
  body: 'First',
  count: 1,
  lang: 'en',
  icon: null,
  renotify: true,
  data: { threadId: 7 },
};

function system() {
  const active = new Map<string, Notification>();
  const showNotification = vi.fn(
    async (_title: string, options?: NotificationOptions) => {
      const tag = options!.tag!;
      const card = {
        tag,
        data: options!.data,
        body: options!.body,
        close: () => {
          if (active.get(tag) === card) active.delete(tag);
        },
      } as Notification;
      active.set(tag, card);
    },
  );
  const registration = {
    getNotifications: vi.fn(async (filter?: GetNotificationOptions) =>
      [...active.values()].filter(
        (card) => !filter?.tag || card.tag === filter.tag,
      ),
    ),
    showNotification,
  };
  return { active, registration, showNotification };
}

describe('Browser notification instances', () => {
  it('recovers an existing instance after worker restart and replaces it', async () => {
    const os = system();
    const first = await new BrowserNotificationCards(os.registration).show(
      descriptor,
      11,
    );
    const second = await new BrowserNotificationCards(os.registration).show(
      { ...descriptor, body: 'Updated' },
      11,
    );
    expect(second).toBe(first);
    expect(os.active.size).toBe(1);
    expect(os.active.get(first)?.body).toBe('Updated');
  });

  it('dismissal and business removal recreate a fresh instance; old removal is harmless', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const first = await cards.show(descriptor, 11);
    os.active.get(first)!.close();
    const second = await cards.show(descriptor, 11);
    expect(second).not.toBe(first);
    await cards.removeInstance(first);
    expect(os.active.has(second)).toBe(true);
    await cards.remove(7);
    expect(os.active.size).toBe(0);
    expect(await cards.show(descriptor, 11)).not.toBe(second);
  });

  it('rejected submission preserves existing content and does not create a phantom card', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    os.showNotification.mockRejectedValueOnce(new Error('denied'));
    await expect(cards.show(descriptor, 11)).rejects.toThrow('denied');
    expect(os.active.size).toBe(0);
    const id = await cards.show(descriptor, 11);
    os.showNotification.mockRejectedValueOnce(new Error('failed update'));
    await expect(
      cards.show({ ...descriptor, body: 'Updated' }, 11),
    ).rejects.toThrow('failed update');
    expect(os.active.get(id)?.body).toBe('First');
  });
});
