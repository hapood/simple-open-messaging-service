import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { UpdateProfileDto } from '../dto/user.dto.js';

describe('personal profile name boundary', () => {
  it.each(['a', '界', '😀'])(
    'accepts 31 code points of %s',
    async (character) => {
      const dto = plainToInstance(UpdateProfileDto, {
        name: character.repeat(31),
        bio: '',
      });
      expect(await validate(dto)).toHaveLength(0);
    },
  );

  it('rejects 32 code points with the supported range', async () => {
    const dto = plainToInstance(UpdateProfileDto, {
      name: '😀'.repeat(32),
      bio: '',
    });
    expect(await validate(dto)).toEqual([
      expect.objectContaining({
        property: 'name',
        constraints: { isLength: 'name must be 1-31 chars' },
      }),
    ]);
  });
});
