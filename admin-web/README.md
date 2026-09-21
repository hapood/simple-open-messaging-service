# admin-web

The admin console for **SOMS** — a React single-page app that drives user
management, session auditing, and login-ban control.
It talks to the same NestJS API as the Angular client (`web/`) but authenticates
through a **physically isolated admin account system** (independent JWT secret,
`scope: 'admin'` claims, separate `Admin` / `AdminRefreshToken` tables). Admin
and user credentials never cross.

> See the repo root `README.md` for the tri-client architecture
> (API `:3000` / web `:4200` / admin-web `:5180`) and `docs/overview/architecture.md`
> for the admin auth subsystem.

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | React 19 |
| Language | TypeScript |
| Bundler / dev server | Vite 8 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| UI primitives | **shadcn (`base-nova` style) on [Base UI](https://base-ui.com/) (`@base-ui/react`)** — **not Radix**. There are zero Radix dependencies in this repo; components compose via Base UI's `render` prop (no `asChild`). |
| Data fetching | TanStack Query v5 (one `useQuery` / `useMutation` hook per domain) |
| Routing | react-router v7 (`createBrowserRouter`) |
| Forms | react-hook-form + zod |
| HTTP | native `fetch` (no axios) — all requests are `POST` |
| Icons / toasts / theme | lucide-react, sonner, next-themes |
| Linter | **Oxlint** (not ESLint) |

## Quick start

The API server must be running on `:3000` (see repo root). From the repo root:

```bash
npm install --prefix admin-web
npm run dev --prefix admin-web     # http://localhost:5180
```

Other scripts:

```bash
npm run build --prefix admin-web   # tsc -b && vite build
npm run preview --prefix admin-web # serve the production build
npm run lint --prefix admin-web    # oxlint
```

## Configuration

- **Dev port:** `5180`, `strictPort: true` (Vite fails hard if the port is busy,
  so the access URL is deterministic), `host: true` (LAN-accessible, matching
  `ng serve --host 0.0.0.0` on the Angular client).
- **API proxy:** `/api` is proxied to `http://localhost:3000` in dev, so the
  client uses same-origin relative URLs and avoids hard-coded hosts.
- **`API_BASE`** (`src/lib/constants.ts`): `import.meta.env.VITE_API_BASE ?? '/api/v1'`.
  Override with `VITE_API_BASE` only for non-proxy deployments; the default works
  for dev and same-origin production.
- **Path alias:** `@` → `src/`.
- **Admin bootstrap:** the API self-seeds the initial admin (`account=admin`) on startup from
  `ADMIN_BOOTSTRAP_PASSWORD` when none exists — no manual seed step is required.
  does the same via dotenv. Then log in here.

## Project layout

```
admin-web/src/
├── api/            # per-domain API functions (auth, users, sessions, bans, …)
│   └── client.ts   # unified request(): Bearer injection, envelope unwrap, 401 retry
├── auth/           # AuthProvider, token-store, single-flight refresh, force-logout
├── components/
│   ├── common/     # shared widgets (e.g. timestamp)
│   ├── layout/     # admin shell / nav
│   ├── route/      # ProtectedRoute guard
│   └── ui/         # shadcn / Base UI primitives
├── hooks/          # TanStack Query hooks
├── lib/            # constants, api-error, utils
├── routes/         # one folder per page (login, users, sessions, admin-sessions, bans)
└── types/          # ApiResult<T> envelope + domain types
```

## Auth model

Mirrors the Angular client's pattern but is **fully isolated** from it:

- **Access token:** held in memory only (a module-level variable in
  `src/auth/token-store.ts`). Lost on page refresh and rebuilt via the refresh
  flow — never persisted.
- **Refresh token:** persisted in `localStorage` under the dedicated key
  **`admin_refresh_token`** (the user client uses `refresh_token`), so the two
  systems cannot collide in the same origin.
- **Single-flight refresh:** `src/auth/refresh-singleton.ts` ensures concurrent
  401s share one refresh request.
- **Transparent retry (`src/api/client.ts`):** a protected request that receives
  HTTP 401 **or** business code `10003` (unauthenticated) triggers one refresh,
  then retries the original call exactly once.
- **Reuse detection:** business code `10006` (`REFRESH_REUSE_DETECTED`) triggers
  `forceLogout` anywhere in the app — the admin's refresh-token family has been
  revoked on the server and a full re-login is required.
- **Public paths:** `/admin/login` and `/admin/renew-access` skip the
  `Authorization` header and the retry loop (otherwise the refresh chain would
  recurse).

## API client

Every call goes through `request<T>(path, body?)` in `src/api/client.ts`, which:

1. Sends a `POST` with `Content-Type: application/json` and a `Bearer` access
   token (unless the path is public).
2. Unwraps the `ApiResult<T>` envelope (`{ code, message, data?, hasMore? }`).
3. On `code !== 0`, throws an `ApiError(code, message, status)`.

Business codes handled client-side (`src/lib/constants.ts`, aligned with the
API's `src/common/business-code.ts`):

| Code | Meaning |
| --- | --- |
| `0` | OK |
| `10000` | validation failed |
| `10003` | unauthenticated → transparent refresh + retry |
| `10004` | forbidden |
| `10005` | rate limited |
| `10006` | refresh reuse detected → force logout |

## Routes

| Path | Page | Notes |
| --- | --- | --- |
| `/login` | `LoginPage` | public; admin credentials |
| `/` | — | redirects to `/users` |
| `/users` | `UsersPage` | list, search, disable/enable, force-logout, reset password |
| `/sessions` | `SessionsPage` | active **user** sessions across the system |
| `/admin-sessions` | `AdminSessionsPage` | active **admin** sessions (audits who is logged into the console itself) |
| `/bans` | `BansPage` | login bans (IP / account), unban |
| `*` | `NotFoundPage` | |

All non-login routes are wrapped in `ProtectedRoute`, which redirects to
`/login` when no admin session exists.
