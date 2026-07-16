-- SessionToken.persistent: whether a web/desktop session's cookie is persistent (14-day sliding) or
-- session-scoped (dropped on browser close — the "don't keep me logged in" choice). The cookie-slide
-- path (re-issuing the cookie on activity) only refreshes PERSISTENT cookies; session cookies live for
-- the browser session and need no refresh. App tokens never expire, so this is moot for them (default
-- true, unused). The browser can't report persistence per-request (it sends only the cookie value, not
-- its maxAge/attributes), so it must live server-side. Default true so pre-existing rows behave as
-- persistent (matching the prior fixed 30-day cookie).
ALTER TABLE "SessionToken" ADD COLUMN "persistent" BOOLEAN NOT NULL DEFAULT true;
