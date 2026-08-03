import { TranslocoService } from '@jsverse/transloco';
import { BusinessCode, translateBizResult } from './biz-code';
import type { StandardResponse } from './model';

/**
 * translateBizResult unit tests — the localization router for backend business codes.
 *
 * The numeric `code` is the stable cross-tier contract (see src/common/business-code.ts). This suite pins
 * the three-tier resolution (messageKey → code map → raw message) and guards the friend-domain mapping in
 * particular: FRIEND_NOT_FOUND (20002) is the deleteFriend "not friends" error, distinct from the generic
 * THREAD_NOT_FOUND (30003) it used to reuse. Pure: no Angular surface (mirrors thread-delta / merge-items
 * specs). Transloco is an identity stub — we assert WHICH key is selected, not the bundle's wording (that
 * is the i18n files' job, covered by en.json / zh-CN.json existing the keys).
 */
const transloco = {
  translate: (key: string) => key,
} as unknown as TranslocoService;

/** Build a minimal response envelope; only `code` is required to drive the router. */
function res(
  code: number,
  message = '',
  messageKey?: string,
): StandardResponse {
  return { code, message, messageKey };
}

describe('translateBizResult', () => {
  it('messageKey wins over the code map (code-0 disambiguation: sent / already friends / now friends)', () => {
    expect(
      translateBizResult(res(0, 'sent', 'friend.msg.sent'), transloco),
    ).toBe('friend.msg.sent');
    // Even when a code DOES have a map entry, messageKey takes priority — it is the backend's explicit pick.
    expect(
      translateBizResult(res(30003, 'x', 'friend.msg.nowFriends'), transloco),
    ).toBe('friend.msg.nowFriends');
  });

  it('FRIEND_NOT_FOUND (20002) → errors.biz.notFriends (deleteFriend on a non-friend)', () => {
    expect(
      translateBizResult(
        res(BusinessCode.FRIEND_NOT_FOUND, 'not friends with 42'),
        transloco,
      ),
    ).toBe('errors.biz.notFriends');
  });

  it('FRIEND_SELF (20001) → friend.error.canNotAddSelf', () => {
    expect(
      translateBizResult(res(BusinessCode.FRIEND_SELF, 'x'), transloco),
    ).toBe('friend.error.canNotAddSelf');
  });

  it('maps the thread-domain codes (THREAD_NOT_FOUND 30003 / THREAD_NOT_APPROVED 30002)', () => {
    expect(
      translateBizResult(res(BusinessCode.THREAD_NOT_FOUND), transloco),
    ).toBe('errors.biz.threadNotFound');
    expect(
      translateBizResult(res(BusinessCode.THREAD_NOT_APPROVED), transloco),
    ).toBe('errors.biz.threadNotApproved');
  });

  it('localizes a stale row after its federated friend request was withdrawn', () => {
    expect(
      translateBizResult(res(BusinessCode.INVITE_ALREADY_HANDLED), transloco),
    ).toBe('errors.biz.inviteAlreadyHandled');
  });

  it('maps the generic codes (VALIDATION / UNAUTHENTICATED / FORBIDDEN / RATE_LIMITED / INTERNAL)', () => {
    expect(
      translateBizResult(res(BusinessCode.VALIDATION_FAILED), transloco),
    ).toBe('errors.biz.validation');
    expect(
      translateBizResult(res(BusinessCode.UNAUTHENTICATED), transloco),
    ).toBe('errors.biz.unauthenticated');
    expect(translateBizResult(res(BusinessCode.FORBIDDEN), transloco)).toBe(
      'errors.biz.forbidden',
    );
    expect(translateBizResult(res(BusinessCode.RATE_LIMITED), transloco)).toBe(
      'errors.biz.rateLimited',
    );
    expect(
      translateBizResult(res(BusinessCode.QUOTA_EXCEEDED), transloco),
    ).toBe('errors.biz.quotaExceeded');
    expect(
      translateBizResult(
        res(BusinessCode.FEDERATION_QUOTA_EXCEEDED),
        transloco,
      ),
    ).toBe('errors.biz.federationQuotaExceeded');
    expect(
      translateBizResult(
        res(BusinessCode.FEDERATION_CAPABILITY_DISABLED),
        transloco,
      ),
    ).toBe('errors.biz.federationCapabilityDisabled');
    expect(
      translateBizResult(
        res(BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE),
        transloco,
      ),
    ).toBe('errors.biz.federationPayloadTooLarge');
    expect(translateBizResult(res(BusinessCode.INTERNAL), transloco)).toBe(
      'errors.biz.internal',
    );
  });

  it('20003 has no map entry anymore (dead FRIEND_NO_INCOMING was removed) → falls back to raw message', () => {
    // 20003 was a code the backend never emits; its map row was dropped alongside the FRIEND_NOT_FOUND
    // rename. An unmapped code must surface the raw message rather than render a blank.
    expect(translateBizResult(res(20003, 'raw fallback text'), transloco)).toBe(
      'raw fallback text',
    );
  });

  it('an entirely unknown code falls back to the raw English message', () => {
    expect(translateBizResult(res(99999, 'something unusual'), transloco)).toBe(
      'something unusual',
    );
  });

  it('code 0 with no messageKey falls back to the raw message (success path with no disambiguation)', () => {
    expect(translateBizResult(res(0, 'ok'), transloco)).toBe('ok');
  });
});
