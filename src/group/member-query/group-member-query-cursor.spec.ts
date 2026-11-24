import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QueryGroupMembersDto } from '../../dto/group-member-query.dto.js';
import {
  decodeGroupMemberCursor,
  encodeGroupMemberCursor,
} from './group-member-query-cursor.js';

const scope = { threadId: 42, search: 'Alice', excludeSelf: true };
const position = { account: 'alice', profileNamespaceId: 9 };

describe('group member query cursor', () => {
  it('round trips the identity and accepts absent first-page cursors', () => {
    expect(
      decodeGroupMemberCursor(encodeGroupMemberCursor(scope, position), scope),
    ).toEqual(position);
    expect(decodeGroupMemberCursor(null, scope)).toBeNull();
    expect(decodeGroupMemberCursor(undefined, scope)).toBeNull();
  });

  it.each([
    { ...scope, threadId: 43 },
    { ...scope, search: 'other' },
    { ...scope, excludeSelf: false },
  ])('rejects a cursor from another query: %j', (other) => {
    expect(() =>
      decodeGroupMemberCursor(encodeGroupMemberCursor(scope, position), other),
    ).toThrow('invalid group member cursor');
  });

  it.each([
    '',
    '!',
    'a'.repeat(2049),
    Buffer.from('{}').toString('base64url'),
    encodeGroupMemberCursor(scope, { ...position, profileNamespaceId: -1 }),
    encodeGroupMemberCursor(scope, { ...position, account: '' }),
  ])('rejects malformed positions', (cursor) => {
    expect(() => decodeGroupMemberCursor(cursor, scope)).toThrow(
      'invalid group member cursor',
    );
  });
});

describe('group member query DTO', () => {
  it.each([
    { threadId: 1 },
    { threadId: 1, take: 100, cursor: null, excludeSelf: true, search: '%' },
  ])('accepts valid query %j', (input) => {
    expect(validateSync(plainToInstance(QueryGroupMembersDto, input))).toEqual(
      [],
    );
  });

  it.each([
    { threadId: 0 },
    { threadId: 2147483648 },
    { threadId: 1, take: 101 },
    { threadId: 1, take: 0 },
    { threadId: 1, take: 1.5 },
    { threadId: 1, excludeSelf: 'false' },
    { threadId: 1, search: 'a'.repeat(129) },
    { threadId: 1, cursor: 'a'.repeat(2049) },
  ])('rejects invalid query %j', (input) => {
    expect(
      validateSync(plainToInstance(QueryGroupMembersDto, input)).length,
    ).toBeGreaterThan(0);
  });
});
