import { syncTombstoneThread } from './tombstone-sync';

describe('tombstone synchronization progress validation', () => {
  const fact = (deletionSeq: number, messageSeq: number) => ({
    threadId: 42,
    deletionSeq,
    messageSeq,
    type: 'USER_RETRACTION' as const,
    createdAt: 1,
    updatedAt: 1,
  });

  it('uses last applied facts, rereads actual cutoff every page, and stops an exhausted cutoff', async () => {
    // The persisted HWM advances to the last applied fact, as the real store does.
    let persistedHwm = 0;
    const storage = {
      getDeletedHwm: vi.fn(async () => persistedHwm),
      getTombstoneCutoff: vi
        .fn()
        .mockResolvedValueOnce(5)
        .mockResolvedValue(20),
      applyDeletedMessages: vi.fn(
        async (_threadId: number, _items: unknown[], hwm: number) => {
          persistedHwm = hwm;
        },
      ),
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { tombstones: [fact(2, 4)], scannedThrough: 8, hasMore: true },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { tombstones: [], scannedThrough: 10, hasMore: true },
      });
    expect(await syncTombstoneThread(storage, request, 42, 10)).toEqual([
      fact(2, 4),
    ]);
    expect(
      request.mock.calls.map(([r]) => [r.after, r.maxMessageSeq, r.take]),
    ).toEqual([
      [0, 5, 50],
      [2, 20, 50],
    ]);
    expect(storage.applyDeletedMessages).toHaveBeenCalledExactlyOnceWith(
      42,
      [fact(2, 4)],
      2,
    );
  });

  it('retries the same target and applied cursor when actual storage grows, ignoring recovery coordinates', async () => {
    const storage = {
      getDeletedHwm: vi.fn().mockResolvedValue(2),
      getTombstoneCutoff: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(5)
        .mockResolvedValue(20),
      applyDeletedMessages: vi.fn(),
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { tombstones: [], scannedThrough: 10, hasMore: false },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { tombstones: [fact(8, 20)], scannedThrough: 10, hasMore: false },
      });
    const recovery = { through: 3, maxMessageSeq: 1 };
    await syncTombstoneThread(storage, request, 42, 10, recovery);
    expect(request).not.toHaveBeenCalled();
    await syncTombstoneThread(storage, request, 42, 10, recovery);
    expect(storage.applyDeletedMessages).not.toHaveBeenCalled();
    await syncTombstoneThread(storage, request, 42, 10, recovery);
    expect(
      request.mock.calls.map(([r]) => [r.after, r.through, r.maxMessageSeq]),
    ).toEqual([
      [2, 10, 5],
      [2, 10, 20],
    ]);
    expect(storage.applyDeletedMessages).toHaveBeenCalledExactlyOnceWith(
      42,
      [fact(8, 20)],
      8,
    );
  });

  it('notifies a committed page even when the next request fails', async () => {
    const storage = {
      getDeletedHwm: vi.fn().mockResolvedValue(0),
      getTombstoneCutoff: vi.fn().mockResolvedValue(20),
      applyDeletedMessages: vi.fn(),
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { tombstones: [fact(2, 4)], scannedThrough: 8, hasMore: true },
      })
      .mockRejectedValueOnce(new Error('network'));
    const notify = vi.fn();
    await expect(
      syncTombstoneThread(storage, request, 42, 10, undefined, notify),
    ).rejects.toThrow('network');
    expect(notify).toHaveBeenCalledExactlyOnceWith([fact(2, 4)]);
  });
  it.each([undefined, null, -1, 0.5, NaN])(
    'rejects invalid persisted progress %s before requesting even an empty target',
    async (hwm) => {
      const storage = {
        getDeletedHwm: vi.fn().mockResolvedValue(hwm),
        applyDeletedMessages: vi.fn(),
        getTombstoneCutoff: vi.fn().mockResolvedValue(12),
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
      getTombstoneCutoff: vi.fn().mockResolvedValue(12),
    };
    const request = vi.fn().mockResolvedValue({ code: 30006 });
    await expect(syncTombstoneThread(storage, request, 42, 10)).rejects.toThrow(
      'tombstone recovery window is unavailable',
    );
    expect(request).toHaveBeenCalledExactlyOnceWith({
      threadId: 42,
      after: 7,
      through: 10,
      take: 50,
      maxMessageSeq: 12,
    });
    expect(storage.applyDeletedMessages).not.toHaveBeenCalled();
  });

  it.each([6, 11])(
    'rejects scanned boundary %s outside the requested interval',
    async (scannedThrough) => {
      const storage = {
        getDeletedHwm: vi.fn().mockResolvedValue(7),
        applyDeletedMessages: vi.fn(),
        getTombstoneCutoff: vi.fn().mockResolvedValue(12),
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
