# admin-web

The SOMS administration console is a React single-page app for user management,
session administration, login restrictions, and operational monitoring. It talks to
the same NestJS API as the Angular client, but uses a separate opaque console session.
Administrators share their linked local account's password; roles and second factors
belong to the Admin record. Consumer and console sessions are independent.

See [administrator access](../docs/design/admin-access.md),
[account security](../docs/design/admin-account-security.md), and the
[Admin API](../docs/api/api.md#admin-api) for authorization and protocol details.

## Development

Start the API on port 3000, then run from the repository root:

```sh
npm install --prefix admin-web
npm run dev --prefix admin-web
npm run build --prefix admin-web
npm test --prefix admin-web
npm run lint --prefix admin-web
```

Vite serves port 5180 with `strictPort` and LAN access. `/api` proxies to
`http://localhost:3000`. `VITE_API_BASE` overrides the default `/api/v1` base;
console authentication requires same-origin cookies. The API can bootstrap the
initial administrator using `ADMIN_BOOTSTRAP_PASSWORD` when no administrator exists.
Never put credentials in frontend configuration.

## Stack and organization

- React 19, TypeScript, Vite 8, Tailwind CSS v4.
- shadcn Base UI primitives (`@base-ui/react`), not Radix; use `render`, not `asChild`.
- TanStack Query v5, React Router v7, react-hook-form and zod.
- Native fetch, lucide-react, sonner, next-themes; Oxlint for linting.
- `src/api/`: API calls and envelope handling.
- `src/auth/`: authentication context and sign-out handling.
- `src/components/`: shared widgets, layout, route guards, and UI primitives.
- `src/hooks/`: query and mutation hooks.
- `src/routes/`: feature pages; `src/types/`: response types.

## Authentication and requests

The browser sends the httpOnly `admin_session` cookie with same-origin requests.
There is no browser-stored bearer or refresh token and no token-renewal request.
Protected navigation checks `/admin/me` before mounting the console. Login may
require a TOTP, recovery-code, or passkey challenge before a session is issued.
Logout revokes the console session and clears administrator query state.

`src/api/client.ts` unwraps `{ code, message, data }` and throws `ApiError` for
business errors. Protected HTTP 401 or code 10003 signs the user out rather than
retrying with a refresh token. Login challenge endpoints bypass that redirect.
The client also handles code 10006 defensively as sign-out. Rate-limit responses
are not automatically retried. Management requests use POST; public configuration
reads and streaming interfaces use their respective protocols.

## Navigation and management

Dashboard is standalone. The remaining navigation groups are Users & content,
Login & security, Monitoring, Federation & network, and Services & configuration.
My Account and Logout belong to the personal footer.

| Path | Purpose |
| --- | --- |
| `/login` | Password and second-factor sign-in |
| `/` | Redirect to `/dashboard` |
| `/dashboard` | Operational overview |
| `/users` | Single personnel roster, console role, and authorized row actions |
| `/users/:id` | User details, console observations, sessions, restrictions, connections, and push registrations |
| `/sessions` | Valid consumer sessions, filtered by user ID, IP, and client |
| `/sessions/admins` | Console sessions; end own other sessions or, as SUPER_ADMIN, another administrator's |
| `/connections` | Live SSE connections aggregated by user, not by device/session |
| `/bans` | Account-grouped login restrictions and independent IP restrictions |
| `/security` | My Account and self-service security |

The old `/admin-sessions` and separate administrator-roster routes are removed,
without compatibility redirects. The API `/admin/admin-sessions` remains the
canonical console-session endpoint; it is not a page route or a compatibility API.

Consumer session tables share revocation, recent activity, inactivity timeout,
and current validity deadline across the global list, user details, and quick view.
All clients have sliding expiry; none are displayed as permanently trusted.
"Sign out all users" ignores filters and ends chat sessions, not console sessions.
Console role/status operations live in the user row menu. Details retain TOTP
status and last console sign-in without widening the roster.

Login restrictions are not account bans. Account release clears all four account
login dimensions; IP release is separate. Unknown accounts stay visible without
invented user links. Queries that fail must not be presented as zero connections
or no restrictions. Full login-security history and device-level online association
are deferred; see the access document for logging and audit limitations.
