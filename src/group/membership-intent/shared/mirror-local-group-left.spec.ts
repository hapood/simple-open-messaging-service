import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { acquireThreadContentLockInTx } from '../../../common/locks/thread-content-lock.js';
import { groupMemberProfileAddress } from '../../meta/group-member-profile-address.js';
import { writeMirrorLocalGroupLeftInTx } from './mirror-local-group-left.js';

describe('writeMirrorLocalGroupLeftInTx', () => {
  it('writes a complete local profile address in the departure notice', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            type: 'GROUP',
            groupId: 7,
            account: '!group',
            domain: 'local',
            id: 7,
            seq: 12,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ profileNamespaceId: 0, profileRev: 4 }],
      })
      .mockResolvedValue({ rows: [{ seq: 12 }] });
    const tx = {
      execute,
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({ defaultProfileRev: 4 }),
        },
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue({ domain: 'local' }),
        },
      },
    };

    const threadLock = await acquireThreadContentLockInTx(tx as never, 7);
    expect(threadLock).toBeDefined();
    await expect(
      writeMirrorLocalGroupLeftInTx(tx as never, {
        threadId: 7,
        localMemberId: 3,
        memberAccount: 'alice',
        publisherNamespaceId: 7,
        threadLock: threadLock!,
      }),
    ).resolves.toBe(12);

    const query = new PgDialect().sqlToQuery(
      execute.mock.calls.at(-1)![0] as never,
    );
    expect(
      groupMemberProfileAddress({
        account: 'alice',
        publisherNamespaceId: 7,
        profileNamespaceId: 0,
        profileRev: 4,
      }),
    ).toEqual({
      account: 'alice',
      publisherNamespaceId: 7,
      profileNamespaceId: 0,
      profileRev: 4,
    });
  });
});
