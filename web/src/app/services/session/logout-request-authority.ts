import { HttpContextToken, HttpRequest } from '@angular/common/http';
import { REQUEST_SCOPE, RequestScope } from '../../request-context';
import { SessionSupersededError } from './session-identity';
import { apiPrefix } from '../constants';

/** A single bounded revocation attempt, never permission for ordinary authentication or data work. */
export class LogoutRequestAuthority {
  readonly signal: AbortSignal;

  private readonly url = `${apiPrefix()}/auth/logout`;

  constructor(owner: AbortSignal) {
    this.signal = AbortSignal.any([owner, AbortSignal.timeout(10_000)]);
  }

  assertRequest(request: HttpRequest<unknown>): void {
    if (
      this.signal.aborted ||
      request.method !== 'POST' ||
      request.urlWithParams !== this.url ||
      request.context.get(REQUEST_SCOPE) !== RequestScope.Authentication
    ) {
      throw new SessionSupersededError();
    }
  }
}

export const LOGOUT_REQUEST_AUTHORITY =
  new HttpContextToken<LogoutRequestAuthority | null>(() => null);
