import { describe, expect, it, vi } from 'vitest';
import {
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../database/schema.js';
import { GroupService } from './group.service.js';

describe('GroupService creation', () => {
  it.each([0, 2])(
    'initializes the founding owner without a request presentation (revision=%i)',
    async (revision) => {
      const insertedTables: unknown[] = [];
      const tx = {
        insert: vi.fn((table: unknown) => {
          insertedTables.push(table);
          return {
            values: vi.fn(() => ({
              returning: vi
                .fn()
                .mockResolvedValue(
                  table === groupAccount ? [{ id: 5 }] : [{ id: 7 }],
                ),
            })),
          };
        }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
        query: {
          profileTable: { findFirst: vi.fn() },
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
      const relationshipMutations = {
        initializeFoundingMembershipInTx: vi.fn().mockResolvedValue(undefined),
        writeGroupRelationshipIntentInTx: vi.fn(),
        writeMemberRelationshipIntentInTx: vi.fn(),
      };
      const clientStateFeed = { notifyFeedUpdates: vi.fn() };
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

      await service.createNewGroup({
        name: 'Group',
        description: 'Bio',
        owner: 11,
      });

      expect(tx.query.profileTable.findFirst).not.toHaveBeenCalled();
      expect(insertedTables).toEqual([
        groupAccount,
        messageThread,
        groupMeta,
        groupMetaMemberFeed,
      ]);
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
      expect(
        relationshipMutations.initializeFoundingMembershipInTx,
      ).toHaveBeenCalledExactlyOnceWith(tx, 7, 11, []);
      expect(
        relationshipMutations.writeGroupRelationshipIntentInTx,
      ).not.toHaveBeenCalled();
      expect(
        relationshipMutations.writeMemberRelationshipIntentInTx,
      ).not.toHaveBeenCalled();
      expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(tx, 7, {
        type: 'GROUP_CREATED',
        creator: {
          account: 'owner',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: revision,
        },
      });
      expect(
        messages.writeSystemMessageInTx.mock.invocationCallOrder[0],
      ).toBeLessThan(
        relationshipMutations.initializeFoundingMembershipInTx.mock
          .invocationCallOrder[0]!,
      );
      expect(
        relationshipMutations.initializeFoundingMembershipInTx.mock
          .invocationCallOrder[0],
      ).toBeLessThan(updateProfile.mock.invocationCallOrder[0]!);
    },
  );
});
