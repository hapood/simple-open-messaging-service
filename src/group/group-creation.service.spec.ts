import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { group, messageThread, profileVersion } from '../database/schema.js';
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
              table === group
                ? [groupState]
                : table === messageThread
                  ? [thread]
                  : [],
            ),
        })),
      };
    });
    const tx = { insert };
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
    const service = new GroupService(
      database as never,
      {} as never,
      relationshipMutations as never,
      clientStateFeed as never,
      {} as never,
    );

    await service.createNewGroup({
      name: 'Group',
      description: 'Bio',
      owner: 11,
    });

    expect(insertedTables).toEqual([group, messageThread, profileVersion]);
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
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledTimes(2);
  });
});
