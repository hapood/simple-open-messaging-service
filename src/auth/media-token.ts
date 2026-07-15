/** The httpOnly cookie carrying the session token for same-origin /uploads/* media requests (a bare
 *  `<img src>` / CSS `url()` can't set an Authorization header, so the browser attaches this cookie
 *  automatically). Mirrors the session token (validated by BearerAuthService via the /uploads/* hook);
 *  set on login, cleared on logout. */
export const MEDIA_TOKEN_COOKIE = 'media_token';

/** Cookie options for the media session token. `secure: 'auto'` honors X-Forwarded-Proto (trustProxy:1),
 *  so it is set over TLS in prod and dropped correctly in plain-HTTP dev. httpOnly keeps it
 *  JS-unreadable (XSS-safe); sameSite:'strict' blocks cross-site sending while same-origin <img>/<a>
 *  still attach it automatically. maxAge = the web session's 30-day sliding ceiling (the cookie is set
 *  once at login; the server-side session token is the authority and slides independently on use). */
export const MEDIA_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: 'auto' as const,
  path: '/',
  maxAge: 30 * 24 * 60 * 60, // 30 days, in seconds
};
