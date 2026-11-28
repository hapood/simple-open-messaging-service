import { HttpContext, HttpRequest } from '@angular/common/http';
import { REQUEST_SCOPE, RequestScope } from '../../request-context';
import { apiPrefix } from '../constants';
import { LogoutRequestAuthority } from './logout-request-authority';
import { SessionSupersededError } from './session-identity';

describe('LogoutRequestAuthority', () => {
  it('adds a fixed deadline to the owner signal', () => {
    const expired = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(expired.signal);
    try {
      const authority = new LogoutRequestAuthority(
        new AbortController().signal,
      );
      const request = new HttpRequest(
        'POST',
        `${apiPrefix()}/auth/logout`,
        {},
        {
          context: new HttpContext().set(
            REQUEST_SCOPE,
            RequestScope.Authentication,
          ),
        },
      );
      authority.assertRequest(request);
      expect(timeout).toHaveBeenCalledWith(10_000);
      expired.abort();
      expect(() => authority.assertRequest(request)).toThrow(
        SessionSupersededError,
      );
    } finally {
      timeout.mockRestore();
    }
  });
});
