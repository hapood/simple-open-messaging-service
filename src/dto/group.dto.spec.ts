import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { InviteGroupDto } from './group.dto.js';

describe('group invitation address validation', () => {
  it.each([
    { groupId: 1, userIds: [76] },
    { groupId: 1, users: [] },
    { groupId: 1, users: [76] },
    { groupId: 1, users: [{ account: 'friend' }] },
    { groupId: 1, users: [{ account: '!group', domain: 'peer.test' }] },
  ])('rejects malformed invitation %j', async (body) => {
    expect(
      await validate(plainToInstance(InviteGroupDto, body)),
    ).not.toHaveLength(0);
  });
  it('accepts an address without a user id or namespace', async () => {
    expect(
      await validate(
        plainToInstance(InviteGroupDto, {
          groupId: 1,
          users: [{ account: 'friend', domain: 'peer.test' }],
        }),
      ),
    ).toHaveLength(0);
  });
});
