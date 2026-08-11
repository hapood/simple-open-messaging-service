import { describe, expect, it, vi } from 'vitest';
import { ContentType } from '../database/enums.js';
import { MessageService } from './message.service.js';
import { SystemMessageType } from './system-message.js';

describe('MessageService local system messages', () => {
  it('persists a local SYSTEM row', async () => {
    const stored = {
      id: 10n,
      threadId: 7,
      creator: 2,
      seq: 4,
      contentType: ContentType.SYSTEM,
      content: JSON.stringify({
        type: SystemMessageType.GROUP_JOINED,
        subject: { account: 'alice', domain: 'local.test' },
      }),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let threadUpdate = 0;
    const update = vi.fn((table: unknown) => {
      const query = {
        set: vi.fn(() => query),
        where: vi.fn(() => query),
        returning: vi.fn(() => {
          threadUpdate += 1;
          return Promise.resolve([{ curSeq: 4 }]);
        }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      };
      void table;
      return query;
    });
    const insertValues = vi.fn();
    const insert = vi.fn(() => {
      const query = {
        values: vi.fn((value: unknown) => {
          insertValues(value);
          return query;
        }),
        returning: vi.fn().mockResolvedValue([stored]),
      };
      return query;
    });
    const service = new MessageService({} as never, {} as never);
    const tx = {
      query: {
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ account: 'alice', domain: 'local.test' }),
        },
      },
      update,
      insert,
    };

    const result = await service.writeSystemMessageInTx(
      tx as never,
      2,
      7,
      SystemMessageType.GROUP_JOINED,
      2,
    );

    expect(result.message.contentType).toBe(ContentType.SYSTEM);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: ContentType.SYSTEM }),
    );
    expect(threadUpdate).toBe(1);
  });

  it('logs and returns null when best-effort generation fails', async () => {
    const service = new MessageService({} as never, {} as never);
    vi.spyOn(service, 'writeSystemMessage').mockRejectedValue(
      new Error('storage unavailable'),
    );
    const logger = { error: vi.fn() };
    Object.assign(service, { logger });

    await expect(
      service.tryWriteSystemMessage(2, 7, SystemMessageType.GROUP_JOINED, 2),
    ).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('storage unavailable'),
      expect.anything(),
    );
  });
});
