# Browser E2E Bug: Disabled user detail exposes login-code action

Status: Fixed on 2026-09-21, verified in browser lab.

## Scenario

- Platform: Web browser E2E, built frontend served through the federation lab.
- Node: Bravo Admin at `http://localhost:3102/admin/users`.
- Admin session: `admin-bravo`.
- `/api/v1/admin/me`: `role = SUPER_ADMIN`.
- Target user: `eve94564495` (`Eve 94564495`).
- List API result: `isDeleted: true`, derived from `Account.disabledAt IS NOT NULL`.
- Detail API result: user profile returned without the same disabled/deleted marker, so the detail page
  treated the account as active.

## Expected

A disabled user detail page should show the disabled/banned state consistently
with the user list and should not expose login-code issuance. If the user must
log in again, the admin should first re-enable the account.

## Actual

The detail page showed the user as active/normal and exposed `签发登录码`. After
confirming the dialog, the backend correctly rejected the operation:

```json
{"code":10004,"message":"cannot issue a login code for a disabled user","data":null}
```

The generic admin-web error formatter displayed this as `你没有权限执行此操作`.
That made the failure look like a super-admin permission problem, but the raw API
response shows the real cause was a disabled target user.

## Evidence

- Screenshot from the misleading detail/dialog state:
  `/tmp/soms-browser-e2e/bug-bravo-admin-issue-otp-permission-denied.png`
- Console errors: none collected.
- Page errors: none collected.
- Raw API checks from the same browser session:
  - `/api/v1/admin/me` returned `SUPER_ADMIN`.
  - `/api/v1/admin/users` returned `eve94564495` with `isDeleted: true`.
  - `/api/v1/admin/users/4/issue-login-code` returned code `10004` with
    message `cannot issue a login code for a disabled user`.

## Impact

The login-code feature itself did not randomly fail for active users. The Admin
detail surface can misrepresent a disabled account as active and expose an action
that the backend must reject. Browser validation for Admin ban/restore should use
an active fresh user or re-enable this target before issuing a login code.

## Fix

`UserManageService.getUserDetail()` now carries the same disabled-account signal
as the user list by returning `user.isDeleted` from `Account.disabledAt`. The
existing Admin detail page logic then shows the disabled badge and hides
login-code issuance for disabled local users.

## Verification

- `npm run build:be` passed.
- `npm test --prefix admin-web -- --run src/routes/users/user-detail-page.spec.tsx` passed.
- Browser lab against Bravo Admin verified `eve94564495` detail API returns
  `isDeleted: true`; the page shows `已封禁` and `解禁`, hides `签发登录码`, and
  collected no console or page errors.

Note: the separate `tokenVer undefined` display is unrelated legacy Admin UI
state and was intentionally left for a separate cleanup.
