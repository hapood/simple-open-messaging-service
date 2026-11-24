import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';

export interface GroupMemberQueryScope {
  threadId: number;
  search: string;
  excludeSelf: boolean;
}

export interface GroupMemberPosition {
  account: string;
  profileNamespaceId: number;
}

export function encodeGroupMemberCursor(
  scope: GroupMemberQueryScope,
  position: GroupMemberPosition,
): string {
  return Buffer.from(
    JSON.stringify([
      1,
      scope.threadId,
      scope.search,
      scope.excludeSelf,
      position.account,
      position.profileNamespaceId,
    ]),
    'utf8',
  ).toString('base64url');
}

/** A cursor is only a validated scan position, never authorization or a snapshot. */
export function decodeGroupMemberCursor(
  cursor: string | null | undefined,
  scope: GroupMemberQueryScope,
): GroupMemberPosition | null {
  if (cursor == null) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 6 ||
      value[0] !== 1 ||
      value[1] !== scope.threadId ||
      value[2] !== scope.search ||
      value[3] !== scope.excludeSelf ||
      typeof value[4] !== 'string' ||
      value[4].length < 1 ||
      value[4].length > 31 ||
      !Number.isInteger(value[5]) ||
      value[5] < 0 ||
      value[5] > 2147483647
    )
      throw new Error();
    const position = {
      account: value[4],
      profileNamespaceId: value[5] as number,
    };
    if (encodeGroupMemberCursor(scope, position) !== cursor) throw new Error();
    return position;
  } catch {
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'invalid group member cursor for this query',
      HttpStatus.BAD_REQUEST,
    );
  }
}
