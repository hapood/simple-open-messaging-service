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
  data: { target: { kind: 'thread', threadId: 7 } },
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
  it('separates request and message instances and never recreates a read-only update', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const request = {
      ...descriptor,
      data: {
        target: { kind: 'group-join-requests', threadId: 7 },
      },
    };
    const messageId = (await cards.show(descriptor, 11))!;
    const requestId = (await cards.show(request, 11))!;
    expect(requestId).not.toBe(messageId);
    await cards.remove(7);
    expect([...os.active.keys()]).toEqual([requestId]);
    os.active.get(requestId)!.close();
    await cards.show(
      { ...request, updateExistingOnly: true, silent: true },
      11,
    );
    expect(os.active.size).toBe(0);
    await cards.show(request, 11);
    expect(os.active.size).toBe(1);
  });
  it('reconstructs only the live intersection without allocating or alerting', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const first = await cards.show(descriptor, 11);
    const expired = await cards.show(
      { ...descriptor, data: { target: { kind: 'thread', threadId: 8 } } },
      11,
    );
    const candidates = await cards.reconstructionCandidates();
    os.registration.getNotifications.mockClear();
    os.showNotification.mockClear();
    await cards.reconstruct(
      candidates,
      [
        { ...descriptor, body: 'Merged' },
        { ...descriptor, data: { target: { kind: 'thread', threadId: 9 } } },
      ],
      11,
    );
    expect([...os.active.keys()]).toEqual([first]);
    expect(os.active.has(expired!)).toBe(false);
    expect(os.active.get(first!)?.body).toBe('Merged');
    expect(os.showNotification).toHaveBeenCalledTimes(1);
    expect(os.showNotification.mock.lastCall?.[1]).toMatchObject({
      tag: first,
      silent: true,
      renotify: false,
    });
    expect(os.registration.getNotifications).not.toHaveBeenCalled();
  });

  it('keeps one stable candidate per thread and closes only duplicate message cards', async () => {
    for (const order of [
      ['b', 'a'],
      ['a', 'b'],
    ]) {
      const os = system();
      for (const suffix of order) {
        await os.registration.showNotification('Peer', {
          tag: `soms-card-${suffix}`,
          data: { target: { kind: 'thread', threadId: 7 } },
        });
      }
      await os.registration.showNotification('Other', {
        tag: 'soms-card-c',
        data: { target: { kind: 'thread', threadId: 8 } },
      });
      await os.registration.showNotification('Probe', {
        tag: 'soms-push-probe',
      });
      const cards = new BrowserNotificationCards(os.registration);
      const candidates = await cards.reconstructionCandidates();
      expect([...candidates]).toEqual([
        ['soms-card-a', 'thread:7'],
        ['soms-card-c', 'thread:8'],
      ]);
      expect(os.active.has('soms-card-b')).toBe(false);
      expect(os.active.has('soms-push-probe')).toBe(true);
      os.active.get('soms-card-a')!.close();
      cards.dismissed('soms-card-a');
      os.showNotification.mockClear();
      await cards.reconstruct(candidates, [descriptor], 11);
      expect(os.showNotification).not.toHaveBeenCalled();
      expect([...os.active.keys()]).toEqual(['soms-push-probe']);
    }
  });

  it('intersection updates do not delete an instance outside the captured candidate set', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const first = await cards.show(descriptor, 11);
    const candidates = await cards.reconstructionCandidates();
    await os.registration.showNotification('Other', {
      tag: 'soms-card-other',
      data: { target: { kind: 'thread', threadId: 7 }, sessionId: 11 },
    });
    await cards.reconstruct(candidates, [descriptor], 11);
    expect(os.active.has(first!)).toBe(true);
    expect(os.active.has('soms-card-other')).toBe(true);
  });

  it('does not recreate a candidate clicked during fetch or touch a newer instance', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const first = await cards.show(descriptor, 11);
    const candidates = await cards.reconstructionCandidates();
    os.active.get(first!)!.close();
    cards.dismissed(first!);
    await cards.reconstruct(candidates, [descriptor], 11);
    expect(os.active.size).toBe(0);
    const next = await cards.show(descriptor, 11);
    os.showNotification.mockClear();
    await cards.reconstruct(candidates, [descriptor], 11);
    expect([...os.active.keys()]).toEqual([next]);
    expect(os.showNotification).not.toHaveBeenCalled();
  });

  it('applies a dismissal event during preparation and retries failed updates without enumeration', async () => {
    const os = system();
    const policy = vi.fn(async () => 'cooldown_5s');
    const cards = new BrowserNotificationCards(os.registration, policy);
    const id = await cards.show(descriptor, 11);
    const candidates = await cards.reconstructionCandidates();
    os.showNotification.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      cards.reconstruct(candidates, [descriptor], 11),
    ).rejects.toThrow('unavailable');
    expect(os.active.has(id!)).toBe(true);
    policy.mockImplementationOnce(async () => {
      os.active.get(id!)!.close();
      cards.dismissed(id!);
      return 'cooldown_5s';
    });
    os.showNotification.mockClear();
    await cards.reconstruct(candidates, [descriptor], 11);
    expect(os.showNotification).not.toHaveBeenCalled();
    expect(os.active.size).toBe(0);
  });

  it('warns on unmatched removal without querying or modifying another candidate', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    await cards.show(descriptor, 11);
    const candidates = await cards.reconstructionCandidates();
    os.registration.getNotifications.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      cards.dismissed('soms-card-unmatched');
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[notification] removal observation has no matching reconstruction instance',
      );
      expect(os.registration.getNotifications).not.toHaveBeenCalled();
      await cards.reconstruct(candidates, [descriptor], 11);
      expect(os.active.size).toBe(1);
      expect(os.registration.getNotifications).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('starts cooldown at acceptance and does not extend it on silent updates or failures', async () => {
    const os = system();
    let now = 10000;
    const cards = new BrowserNotificationCards(
      os.registration,
      async () => 'cooldown_5s',
      () => now,
    );
    await cards.show(descriptor, 11);
    expect(os.showNotification.mock.lastCall?.[1]?.silent).toBe(false);
    now += 4999;
    await cards.show(descriptor, 11);
    expect(os.showNotification.mock.lastCall?.[1]?.silent).toBe(true);
    now += 1;
    os.showNotification.mockRejectedValueOnce(new Error('denied'));
    await expect(cards.show(descriptor, 11)).rejects.toThrow('denied');
    await cards.show(descriptor, 11);
    expect(os.showNotification.mock.lastCall?.[1]?.silent).toBe(false);
  });

  it('once-per-thread survives updates but dismissal creates fresh eligibility', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(
      os.registration,
      async () => 'once_per_thread',
    );
    const id = await cards.show(descriptor, 11);
    await cards.show(descriptor, 11);
    expect(os.showNotification.mock.lastCall?.[1]?.silent).toBe(true);
    os.active.get(id!)!.close();
    await cards.show(descriptor, 11);
    expect(os.showNotification.mock.lastCall?.[1]?.silent).toBe(false);
  });

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
    expect(os.active.get(first!)?.body).toBe('Updated');
  });

  it('dismissal and business removal recreate a fresh instance; old removal is harmless', async () => {
    const os = system();
    const cards = new BrowserNotificationCards(os.registration);
    const first = await cards.show(descriptor, 11);
    os.active.get(first!)!.close();
    const second = await cards.show(descriptor, 11);
    expect(second).not.toBe(first);
    await cards.removeInstance(first);
    expect(os.active.has(second!)).toBe(true);
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
    expect(os.active.get(id!)?.body).toBe('First');
  });
});
