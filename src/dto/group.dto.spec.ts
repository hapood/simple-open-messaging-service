import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateGroupDto, UpdateGroupDto, InviteGroupDto } from './group.dto.js';

describe('group invitation address validation', () => {
  it.each([
    { groupId: 1, userIds: [76] },
    { groupId: 1, users: [] },
    { groupId: 1, users: [76] },
    { groupId: 1, users: [{ account: 'friend' }] },
    { groupId: 1, users: [{ account: '!group', domain: 'peer.test' }] },
    { groupId: 1, users: [{ account: 'friend', namespaceId: 'x' }] },
  ])('rejects malformed invitation %j', async (body) => {
    expect(
      await validate(plainToInstance(InviteGroupDto, body)),
    ).not.toHaveLength(0);
  });
  it('accepts an address with an identity namespace id', async () => {
    expect(
      await validate(
        plainToInstance(InviteGroupDto, {
          groupId: 1,
          users: [{ account: 'friend', namespaceId: 7 }],
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('group name boundaries', () => {
  for (const Dto of [CreateGroupDto, UpdateGroupDto] as const) {
    it.each([30, 31])(`${Dto.name} accepts %i characters`, async (length) => {
      const body =
        Dto === CreateGroupDto
          ? plainToInstance(CreateGroupDto, {
              groupId: 1,
              name: '界'.repeat(length),
            })
          : plainToInstance(UpdateGroupDto, {
              groupId: 1,
              name: '界'.repeat(length),
            });
      expect(await validate(body)).toHaveLength(0);
    });

    it(`${Dto.name} rejects 32 characters with an actionable message`, async () => {
      const body =
        Dto === CreateGroupDto
          ? plainToInstance(CreateGroupDto, {
              groupId: 1,
              name: 'a'.repeat(32),
            })
          : plainToInstance(UpdateGroupDto, {
              groupId: 1,
              name: 'a'.repeat(32),
            });
      expect(await validate(body)).toEqual([
        expect.objectContaining({
          property: 'name',
          constraints: {
            maxLength: 'group name must be at most 31 characters',
          },
        }),
      ]);
    });
  }
});
