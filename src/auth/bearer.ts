/** Extract the opaque session token from an `Authorization: Bearer <token>` header value,
 *  case-insensitively. Returns `undefined` when the header is absent or not a Bearer header. Shared by
 *  the global {@link SessionAuthGuard} (cookie-first, Bearer fallback) and the `@Public()` logout handler
 *  (which resolves the session from the body, the cookie, OR the Bearer — see `auth.controller.ts`). */
export function extractBearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}
