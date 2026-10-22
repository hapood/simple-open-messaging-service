import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  RequestDecisionDto,
  QueryRelationshipRequestsDto,
} from './relationship-request.dto.js';
import {
  AcceptRelationshipDto,
  ReadRelationshipRequestsDto,
  RevokeRelationshipDto,
} from './relationship.dto.js';

const options = { whitelist: true, forbidNonWhitelisted: true };

describe('request DTO contracts', () => {
  it('revokes by thread only, rejecting the former address and request payloads', async () => {
    expect(
      await validate(
        plainToInstance(RevokeRelationshipDto, { threadId: 12 }),
        options,
      ),
    ).toEqual([]);
    for (const body of [
      { account: 'bob', namespaceId: 0 },
      { threadId: 12, account: 'bob', namespaceId: 0 },
      { requestId: '12' },
      { groupId: 12 },
      { threadId: 0 },
      { threadId: -1 },
      { threadId: 1.5 },
    ])
      expect(
        await validate(plainToInstance(RevokeRelationshipDto, body), options),
      ).not.toEqual([]);
  });
  it.each([RequestDecisionDto, AcceptRelationshipDto])(
    'requires a precise round token for %s',
    async (Dto) => {
      const id = '9007199254740993';
      const dto = plainToInstance(Dto, { requestId: id });
      expect(await validate(dto, options)).toEqual([]);
      expect(dto.requestId).toBe(id);
      for (const requestId of [
        42,
        '0',
        '01',
        '-1',
        '1e3',
        '9223372036854775808',
      ])
        expect(
          await validate(plainToInstance(Dto, { requestId }), options),
        ).not.toEqual([]);
      expect(
        await validate(
          plainToInstance(Dto, { account: 'bob', namespaceId: 0 }),
          options,
        ),
      ).not.toEqual([]);
    },
  );

  it('accepts a zero read head but rejects a feed cursor or numeric ID', async () => {
    expect(
      await validate(
        plainToInstance(ReadRelationshipRequestsDto, { requestReadId: '0' }),
        options,
      ),
    ).toEqual([]);
    for (const body of [{ readThroughFeedId: 42 }, { requestReadId: 42 }])
      expect(
        await validate(
          plainToInstance(ReadRelationshipRequestsDto, body),
          options,
        ),
      ).not.toEqual([]);
  });

  it('inherits bounded page options without converting request IDs', async () => {
    const dto = plainToInstance(QueryRelationshipRequestsDto, {
      bucket: 'RECEIVED',
      before: '9223372036854775807',
      take: '50',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.before).toBe('9223372036854775807');
    expect(dto.take).toBe(50);
    for (const body of [
      { bucket: 'ALL' },
      { bucket: 'SENT', before: '0' },
      { bucket: 'SENT', before: 42 },
      { bucket: 'SENT', take: 0 },
      { bucket: 'SENT', take: 51 },
      { bucket: 'SENT', take: 1.5 },
    ])
      expect(
        await validate(
          plainToInstance(QueryRelationshipRequestsDto, body),
          options,
        ),
      ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(QueryRelationshipRequestsDto, { bucket: 'SENT' }),
        options,
      ),
    ).toEqual([]);
  });
});
