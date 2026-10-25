import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AdminListUserSessionsDto } from './admin.dto.js';

describe('AdminListUserSessionsDto', () => {
  it.each(['app', 'web', 'desktop'])(
    'accepts the %s client with user and IP filters',
    async (client) => {
      const dto = plainToInstance(AdminListUserSessionsDto, {
        userId: 42,
        ip: '192.0.2',
        client,
      });
      expect(await validate(dto)).toEqual([]);
    },
  );
  it('rejects unsupported clients', async () => {
    const errors = await validate(
      plainToInstance(AdminListUserSessionsDto, { client: 'unknown' }),
    );
    expect(errors.map((error) => error.property)).toContain('client');
  });
  it('allows the unfiltered view', async () => {
    expect(await validate(new AdminListUserSessionsDto())).toEqual([]);
  });
});
