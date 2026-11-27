import { PlaygroundWebdbStorage } from './playground-webdb-storage';
import { SessionLifecycleService } from '../app/services/session-lifecycle.service';

describe('PlaygroundWebdbStorage message heads', () => {
  it('keeps monotonic per-thread heads without an authenticated database', async () => {
    const storage = new PlaygroundWebdbStorage(
      () => null,
      new SessionLifecycleService(),
    );
    expect(await storage.getMessageHead(1)).toBeUndefined();
    await storage.putMessageHead(1, 100);
    await storage.putMessageHead(1, 101);
    await storage.putMessageHead(1, 90);
    await storage.putMessageHead(2, 0);
    expect(await storage.getMessageHead(1)).toBe(101);
    expect(await storage.getMessageHead(2)).toBe(0);
    await expect(storage.putMessageHead(1, 1.5)).rejects.toThrow(
      'known newest message sequence is invalid',
    );
    expect(await storage.getMessageHead(1)).toBe(101);
  });
});
