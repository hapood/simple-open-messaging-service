import { syncTombstoneThread } from './tombstone-sync';

describe('tombstone synchronization progress validation', () => {
  it.each([undefined, null, -1, 0.5, NaN])(
    'rejects invalid persisted progress %s before requesting even an empty target',
    async (hwm) => {
      const storage = {
        getDeletedHwm: vi.fn().mockResolvedValue(hwm),
        applyDeletedMessages: vi.fn(),
      };
      const request = vi.fn();
      await expect(
        syncTombstoneThread(storage, request, 42, 0),
      ).rejects.toThrow('missing or invalid deleted-message HWM');
      expect(request).not.toHaveBeenCalled();
      expect(storage.applyDeletedMessages).not.toHaveBeenCalled();
    },
  );

  it('never resets persisted progress after a server cursor-unavailable response', async () => {
    const storage = {
      getDeletedHwm: vi.fn().mockResolvedValue(7),
      applyDeletedMessages: vi.fn(),
    };
    const request = vi.fn().mockResolvedValue({ code: 30006 });
    await expect(syncTombstoneThread(storage, request, 42, 10)).rejects.toThrow(
      'tombstone recovery window is unavailable',
    );
    expect(request).toHaveBeenCalledExactlyOnceWith({
      threadId: 42,
      after: 7,
      through: 10,
      take: 100,
    });
    expect(storage.applyDeletedMessages).not.toHaveBeenCalled();
  });

  it.each([6, 11])(
    'rejects scanned boundary %s outside the requested interval',
    async (scannedThrough) => {
      const storage = {
        getDeletedHwm: vi.fn().mockResolvedValue(7),
        applyDeletedMessages: vi.fn(),
      };
      const request = vi.fn().mockResolvedValue({
        code: 0,
        data: { tombstones: [], scannedThrough, hasMore: false },
      });
      await expect(
        syncTombstoneThread(storage, request, 42, 10),
      ).rejects.toThrow('tombstone query returned an invalid boundary');
      expect(storage.applyDeletedMessages).not.toHaveBeenCalled();
    },
  );
});
