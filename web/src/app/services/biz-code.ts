import { TranslocoService } from '@jsverse/transloco';
import type { StandardResponse } from './model';

/**
 * Mirror of the backend `BusinessCode` enum (src/common/business-code.ts) — the stable numeric contract
 * every error response carries. Kept as plain `const` values (not an enum) so the `BIZ_CODE_KEY` map
 * stays a flat literal lookup. Update both sides together when a code is added.
 */
export const BusinessCode = {
  OK: 0,
  VALIDATION_FAILED: 10000,
  NOT_FOUND: 10001,
  ALREADY_EXISTS: 10002,
  UNAUTHENTICATED: 10003,
  FORBIDDEN: 10004,
  RATE_LIMITED: 10005,
  REFRESH_REUSE_DETECTED: 10006,
  SESSION_REVOKED: 10007,
  QUOTA_EXCEEDED: 10008,
  INTERNAL: 10999,
  FRIEND_SELF: 20001,
  FRIEND_NOT_FOUND: 20002,
  MESSAGE_EMPTY: 30001,
  THREAD_NOT_APPROVED: 30002,
  THREAD_NOT_FOUND: 30003,
  GROUP_NOT_FRIEND: 40002,
  GROUP_INVALID_TOKEN: 40003,
  GROUP_OWNER_MUST_TRANSFER: 40004,
  GROUP_FORBIDDEN: 40005,
  GROUP_TARGET_NOT_MEMBER: 40006,
} as const;

/**
 * Numeric business code → translation key. Error responses carry no `messageKey` on purpose: the numeric
 * `code` is the stable contract, and one map localizes every endpoint's errors uniformly. Success
 * outcomes that share code 0 but need disambiguation (e.g. friend-request "sent / already friends /
 * now friends") are localized via the backend-supplied `messageKey` instead.
 */
const BIZ_CODE_KEY: Readonly<Record<number, string>> = {
  [BusinessCode.VALIDATION_FAILED]: 'errors.biz.validation',
  [BusinessCode.NOT_FOUND]: 'errors.biz.notFound',
  [BusinessCode.ALREADY_EXISTS]: 'errors.biz.alreadyExists',
  [BusinessCode.UNAUTHENTICATED]: 'errors.biz.unauthenticated',
  [BusinessCode.FORBIDDEN]: 'errors.biz.forbidden',
  [BusinessCode.RATE_LIMITED]: 'errors.biz.rateLimited',
  [BusinessCode.REFRESH_REUSE_DETECTED]: 'errors.biz.refreshReuse',
  [BusinessCode.SESSION_REVOKED]: 'errors.biz.sessionRevoked',
  [BusinessCode.QUOTA_EXCEEDED]: 'errors.biz.quotaExceeded',
  [BusinessCode.INTERNAL]: 'errors.biz.internal',
  [BusinessCode.FRIEND_SELF]: 'friend.error.canNotAddSelf',
  [BusinessCode.FRIEND_NOT_FOUND]: 'errors.biz.notFriends',
  [BusinessCode.MESSAGE_EMPTY]: 'errors.biz.messageEmpty',
  [BusinessCode.THREAD_NOT_APPROVED]: 'errors.biz.threadNotApproved',
  [BusinessCode.THREAD_NOT_FOUND]: 'errors.biz.threadNotFound',
  [BusinessCode.GROUP_NOT_FRIEND]: 'errors.biz.groupNotFriend',
  [BusinessCode.GROUP_INVALID_TOKEN]: 'errors.biz.groupInvalidToken',
  [BusinessCode.GROUP_OWNER_MUST_TRANSFER]: 'group.leaveOwnerNote',
  [BusinessCode.GROUP_FORBIDDEN]: 'errors.biz.groupForbidden',
  [BusinessCode.GROUP_TARGET_NOT_MEMBER]: 'errors.biz.groupTargetNotMember',
};

/**
 * Resolve a backend response to a localized, user-facing string.
 *
 * Priority: `messageKey` (backend-supplied i18n key, for code-0 disambiguation) → numeric `code` map
 * (every known business error) → raw English `message` (unknown codes / unmapped backends). The last
 * fallback is intentional: an unmapped code is still better than a blank, and surfaces the gap so the
 * map can be extended.
 */
export function translateBizResult<T>(res: StandardResponse<T>, transloco: TranslocoService): string {
  if (res.messageKey) return transloco.translate(res.messageKey);
  const key = BIZ_CODE_KEY[res.code];
  return key ? transloco.translate(key) : res.message;
}
