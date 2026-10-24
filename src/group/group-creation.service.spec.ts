import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { groupAccount, groupMeta, messageThread } from '../database/schema.js';
import { GroupService } from './group.service.js';

describe('GroupService creation', () => {
  it.each([
    { revision: 2, hasSnapshot: true },
    { revision: 0, hasSnapshot: false },
    { revision: 2, hasSnapshot: false },
  ])(
    'creates the owner without inventing a snapshot (revision=$revision, snapshot=$hasSnapshot)',
    async ({ revision, hasSnapshot }) => {
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
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
        query: {
          identityNamespace: {
            findFirst: vi.fn().mockResolvedValue({ domain: 'local.example' }),
          },
          profileTable: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                hasSnapshot ? { displayName: 'Owner', avatar: '' } : null,
              ),
          },
          account: {
            findFirst: vi.fn().mockResolvedValue({
              account: 'owner',
              defaultProfileRev: revision,
            }),
          },
        },
      };
      const database = {
        db: {
          transaction: vi.fn(
            (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
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
        relationshipMutations as never,
        clientStateFeed as never,
        {} as never,
        messages as never,
      );

      const updateProfile = vi
        .spyOn(
          service as unknown as {
            updateGroupInTx: (...args: unknown[]) => Promise<unknown>;
          },
          'updateGroupInTx',
        )
        .mockResolvedValue({});

      const operation = service.createNewGroup({
        name: 'Group',
        description: 'Bio',
        owner: 11,
      });
      if (revision > 0 && !hasSnapshot) {
        await expect(operation).rejects.toThrow(
          'group creator profile is unavailable',
        );
        expect(writeGroupRelationshipIntentInTx).not.toHaveBeenCalled();
        expect(messages.writeSystemMessageInTx).not.toHaveBeenCalled();
        return;
      }
      await operation;
      expect(tx.query.profileTable.findFirst).toHaveBeenCalledTimes(
        revision === 0 ? 0 : 1,
      );

      expect(insertedTables).toEqual([groupAccount, messageThread, groupMeta]);
      expect(database.db.transaction).toHaveBeenCalledTimes(2);
      expect(updateProfile).toHaveBeenCalledWith(
        tx,
        {
          threadId: 7,
          operatorUserId: 11,
          name: 'Group',
          description: 'Bio',
          avatar: '',
        },
        [11],
      );
      expect(updateProfile.mock.invocationCallOrder[0]).toBeLessThan(
        clientStateFeed.notifyFeedUpdates.mock.invocationCallOrder[0]!,
      );
      expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
        tx,
        7,
        11,
        'ACCEPTED',
        [],
        '',
        { initialRole: GroupRole.OWNER },
      );
      expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(tx, 7, {
        type: 'GROUP_CREATED',
        creator: {
          account: 'owner',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: revision,
        },
      });
      expect(writeGroupRelationshipIntentInTx).toHaveBeenNthCalledWith(
        1,
        tx,
        7,
        11,
        '',
        'REQUESTED',
        [],
        undefined,
        {
          snapshot: {
            displayName: hasSnapshot ? 'Owner' : 'owner',
            avatar: null,
          },
        },
      );
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
    },
  );
});
