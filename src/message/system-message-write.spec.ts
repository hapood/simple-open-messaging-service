import { enqueueDepartureFanoutsInTx } from './account-thread-fanout-task.js';
process.env.SOMS_DOMAIN ??= 'chat.example';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../common/locks/thread-content-lock.js', () => ({
  lockThreadContentInTx: vi.fn().mockResolvedValue(true),
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
}));
import { ContentType } from '../database/enums.js';
import { MessageService } from './message.service.js';
import { SystemMessageType } from './system-message.js';
import { enqueueThreadFanoutInTx } from './thread-fanout-task.js';
vi.mock('./thread-fanout-task.js', () => ({
  enqueueThreadFanoutInTx: vi.fn().mockResolvedValue(1n),
}));

vi.mock('./account-thread-fanout-task.js', () => ({
  enqueueDepartureFanoutsInTx: vi.fn().mockResolvedValue(undefined),
}));

describe('MessageService local system messages', () => {
  it('persists a local SYSTEM row', async () => {
    const stored = {
      id: 10n,
      threadId: 7,
      creatorAccount: '$system',
      profileNamespaceId: 0,
      publisherNamespaceId: 0,
      seq: 4,
      contentType: ContentType.SYSTEM,
      content: JSON.stringify({
        type: SystemMessageType.GROUP_JOINED,
        member: {
          account: 'alice',
          profileNamespaceId: 0,
          profileRev: 2,
        },
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
          return Promise.resolve([{ curSeq: 4, tombstoneEndSeq: 0 }]);
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
    const service = new MessageService({} as never, {} as never, {} as never);
    const tx = {
      query: {
        account: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ account: 'alice' }),
        },
      },
      update,
      insert,
    };

    const result = await service.writeSystemMessageInTx(tx as never, 7, {
      type: SystemMessageType.GROUP_JOINED,
      member: {
        account: 'alice',
        profileNamespaceId: 0,
        profileRev: 2,
      },
    });

    expect(result.message.contentType).toBe(ContentType.SYSTEM);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: ContentType.SYSTEM,
      }),
    );
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      creatorAccount: '$system',
      profileNamespaceId: 0,
      publisherNamespaceId: 0,
    });
    expect(JSON.parse(insertValues.mock.calls[0][0].content)).toEqual({
      type: 'GROUP_JOINED',
      member: {
        account: 'alice',
        profileNamespaceId: 0,
        profileRev: 2,
      },
    });
    expect(threadUpdate).toBe(1);
  });

  it('logs and returns null when best-effort generation fails', async () => {
    const service = new MessageService({} as never, {} as never, {} as never);
    vi.spyOn(service, 'writeSystemMessage').mockRejectedValue(
      new Error('storage unavailable'),
    );
    const logger = { error: vi.fn() };
    Object.assign(service, { logger });

    await expect(
      service.tryWriteSystemMessage(7, {
        type: SystemMessageType.GROUP_JOINED,
        member: {
          account: 'alice',
          profileNamespaceId: 0,
          profileRev: 2,
        },
      }),
    ).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('storage unavailable'),
      expect.anything(),
    );
  });

  it('admits ordinary and directed boundary fanout in the system transaction', async () => {
    vi.stubEnv('SOMS_DOMAIN', 'local.test');
    const stored = {
      id: 11n,
      threadId: 7,
      creatorAccount: '$system',
      profileNamespaceId: 0,
      publisherNamespaceId: 0,
      seq: 5,
      contentType: ContentType.SYSTEM,
      content: JSON.stringify({
        type: SystemMessageType.FRIEND_REMOVED,
        initiator: {
          account: 'bob',
          profileNamespaceId: 0,
          profileRev: 1,
        },
        participants: [
          {
            account: 'bob',
            profileNamespaceId: 0,
            profileRev: 1,
          },
          {
            account: 'alice',
            profileNamespaceId: 0,
            profileRev: 2,
          },
        ],
      }),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const query = {
      set: vi.fn(() => query),
      where: vi.fn(() => query),
      returning: vi.fn().mockResolvedValue([{ curSeq: 5, tombstoneEndSeq: 2 }]),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    const insertQuery = {
      values: vi.fn(() => insertQuery),
      returning: vi.fn().mockResolvedValue([stored]),
    };
    const tx = {
      query: {
        account: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ account: 'bob' }),
        },
      },
      update: vi.fn(() => query),
      insert: vi.fn(() => insertQuery),
    };
    const service = new MessageService({} as never, {} as never, {} as never);

    await service.writeSystemMessageInTx(tx as never, 7, {
      type: SystemMessageType.FRIEND_REMOVED,
      initiator: {
        account: 'bob',
        profileNamespaceId: 0,
        profileRev: 1,
      },
      participants: [
        {
          account: 'bob',
          profileNamespaceId: 0,
          profileRev: 1,
        },
        {
          account: 'alice',
          profileNamespaceId: 0,
          profileRev: 2,
        },
      ],
    });

    expect(enqueueDepartureFanoutsInTx).toHaveBeenLastCalledWith(
      tx,
      { tx, threadId: 7 },
      { threadId: 7, messageEndSeq: 5, tombstoneEndSeq: 2 },
      'P2P',
      undefined,
    );
    expect(enqueueThreadFanoutInTx).toHaveBeenLastCalledWith(
      tx,
      { tx, threadId: 7 },
      { threadId: 7, messageEndSeq: 5, tombstoneEndSeq: 2 },
    );
  });
});
