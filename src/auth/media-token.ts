import type { FastifyReply } from 'fastify';

/** The httpOnly cookie carrying the opaque session token — the browser's session credential, accepted by
 *  the global `SessionAuthGuard` on every route (cookie-first, Bearer fallback). On the browser it
 *  auto-attaches same-origin (and, for `<img src>` / CSS `url()` that can't set headers, it's the only
 *  way media authenticates); native clients use the Bearer header instead (no cookie store). Set on
 *  login, cleared on logout. (Name kept as `media_token` for historical continuity.) */
export const MEDIA_TOKEN_COOKIE = 'media_token';

/** Cookie options for the session token cookie. `secure: 'auto'` honors X-Forwarded-Proto (trustProxy:1),
 *  so it is set over TLS in prod and dropped correctly in plain-HTTP dev. httpOnly keeps it
 *  JS-unreadable (XSS-safe); sameSite:'strict' blocks cross-site sending while same-origin <img>/<a>
 *  still attach it automatically. The one-year cookie is only a credential carrier; the authoritative
 *  inactivity deadline remains the server-side SessionToken.expiresAt. */
export const MEDIA_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: 'auto' as const,
  path: '/',
  maxAge: 365 * 24 * 60 * 60,
};

/** A NON-httpOnly companion cookie (value `1`) set/cleared in lockstep with {@link MEDIA_TOKEN_COOKIE}.
 *  Purpose: let the pure-httpOnly browser client read login state via `document.cookie` — the session
 *  token itself is httpOnly and thus JS-unreadable, so without this flag the SPA couldn't tell whether a
 *  session exists after a refresh. Carries no secret; same SameSite/secure/maxAge as the token cookie so
 *  its lifetime tracks the real session. Read by the web client's `AuthService.isLoggedIn()` (browser
 *  build only; native builds hold the raw token and don't use it). */
export const LOGGED_IN_COOKIE = 'logged_in';

export const LOGGED_IN_COOKIE_OPTIONS = {
  httpOnly: false,
  sameSite: 'strict' as const,
  secure: 'auto' as const,
  path: '/',
  maxAge: 365 * 24 * 60 * 60,
};

/** Re-issue both session cookies with a refreshed maxAge — the cookie-side of sliding. Called by the
 *  auth guard / the /uploads validator when a cookie-authenticated session slides its server deadline. */
export function refreshSessionCookies(
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(MEDIA_TOKEN_COOKIE, token, MEDIA_COOKIE_OPTIONS);
  reply.setCookie(LOGGED_IN_COOKIE, '1', LOGGED_IN_COOKIE_OPTIONS);
}

/** Set the session credential cookies — the httpOnly `media_token` (the real credential) + the non-httpOnly
 *  `logged_in` presence flag — for a freshly issued session token. Shared by every login flow. */
export function setSessionCookies(reply: FastifyReply, token: string): void {
  refreshSessionCookies(reply, token);
}

/** Clear both session cookies — path must match the set-time path for the browser to drop them. Shared by
 *  the login flows' logout/error paths. */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(MEDIA_TOKEN_COOKIE, { path: '/' });
  reply.clearCookie(LOGGED_IN_COOKIE, { path: '/' });
}
