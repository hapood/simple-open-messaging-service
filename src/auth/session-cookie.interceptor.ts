import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';
import { refreshSessionCookies } from './media-token.js';

/** Request field the {@link SessionAuthGuard} (in session-auth.guard.ts) sets when the request's session
 *  slid its server deadline AND it was a cookie-authed PERSISTENT web/desktop session — the signal +
 *  cookie value this interceptor needs to re-issue the browser cookie. */
export interface SessionSlideRequest {
  sessionSlideToken?: string;
}

/**
 * The cookie-side of sliding: re-issues the browser session cookie (refreshed maxAge) when the request's
 * session just extended its server deadline, so an active session's cookie tracks the session instead of
 * capping at the login-time TTL. The decision + cookie value are stashed on the request by
 * {@link SessionAuthGuard} (`sessionSlideToken`); this interceptor performs the actual Set-Cookie so the
 * GUARD stays a pure auth decision (return/throw) and response mutation lives in the interceptor — the
 * idiomatic NestJS split (guards decide, interceptors augment the response).
 *
 * Runs in the PRE-phase (before `next.handle()`): the guard has already set the flag (guards run before
 * interceptors), and the handler hasn't run yet — so for the hijacked SSE `/events` stream the cookie is
 * queued before `reply.hijack()` (no post-hijack setCookie). Like all pre-handler cookie writes it's
 * silently dropped on `/events` because hijack bypasses Fastify's send; that's fine, API calls (which do
 * slide) are frequent alongside the stream. Only PERSISTENT web/desktop sessions leave a flag; session
 * cookies + native/Bearer requests don't, and app tokens never slide. `/uploads/*` (a Fastify static
 * route, outside the NestJS interceptor pipeline) re-issues directly in its own preHandler.
 */
@Injectable()
export class SessionCookieInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<SessionSlideRequest>();
    const token = req.sessionSlideToken;
    if (token) {
      refreshSessionCookies(context.switchToHttp().getResponse<FastifyReply>(), token);
    }
    return next.handle();
  }
}
