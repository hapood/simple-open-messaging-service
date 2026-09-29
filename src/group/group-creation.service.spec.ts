import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import {
  groupAccount,
  groupMeta,
  messageThread,
  profileTable,
} from '../database/schema.js';
import { GroupService } from './group.service.js';

describe('GroupService creation', () => {
  it('creates the owner through the authored relationship without a separate roster row', async () => {
    const groupState = {
      id: 5,
      account: '!group',
      domain: 'local',
      name: 'Group',
      avatar: '',
      description: 'Bio',
      defaultProfileRev: 1,
    };
    const thread = { id: 7 };
    const insertedTables: unknown[] = [];
    const insert = vi.fn((table: unknown) => {
      insertedTables.push(table);
      return {
        values: vi.fn(() => ({
          returning: vi
            .fn()
            .mockResolvedValue(
              table === groupAccount
                ? [groupState]
                : table === messageThread
                  ? [thread]
                  : [],
            ),
        })),
      };
    });
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = {
      insert,
      execute,
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'owner',
            defaultProfileRev: 2,
          }),
        },
      },
    };
    const database = {
      db: {
        transaction: vi.fn((callback: (value: typeof tx) => Promise<unknown>) =>
          callback(tx),
        ),
      },
    };
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const relationshipMutations = {
      writeGroupRelationshipIntentInTx,
      writeMemberRelationshipIntentInTx,
    };
    const clientStateFeed = {
      notifyFeedUpdates: vi.fn(),
    };
    const messages = {
      writeSystemMessageInTx: vi.fn().mockResolvedValue({
        message: { seq: 1 },
        messageId: 1n,
      }),
    };
    const service = new GroupService(
      database as never,
      {} as never,
      relationshipMutations as never,
      clientStateFeed as never,
      {} as never,
      messages as never,
    );

    await service.createNewGroup({
      name: 'Group',
      description: 'Bio',
      owner: 11,
    });

    expect(insertedTables).toEqual([
      groupAccount,
      messageThread,
      profileTable,
      groupMeta,
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      7,
      11,
      'ACCEPTED',
      [],
      '',
      undefined,
      { initialRole: GroupRole.OWNER },
    );
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(tx, 7, {
      type: 'GROUP_CREATED',
      creator: {
        account: 'owner',
        domain: 'local',
        profileNamespaceId: 0,
        profileRev: 2,
      },
    });
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledTimes(2);
    expect(
      writeGroupRelationshipIntentInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(
      messages.writeSystemMessageInTx.mock.invocationCallOrder[0]!,
    );
    expect(
      messages.writeSystemMessageInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(
      writeMemberRelationshipIntentInTx.mock.invocationCallOrder[0]!,
    );
  });
});
