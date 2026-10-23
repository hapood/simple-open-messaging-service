# Administrator Access Management

Status: implemented. This document defines the current application-level access policy.
Self-service credential and second-factor rules are specified in
[Administrator account security](./admin-account-security.md).

## Identity and permissions

A local Account owns login credentials. Its optional Admin record owns backend access, role, and second-factor configuration. User sessions and backend sessions remain separate.

Authorization depends on authenticated roles and the target's stored administrator record, never the account name. Existing records are unchanged: this update includes no schema change or data migration and does not make any account a super administrator.

| Operation | VIEWER | ADMIN | SUPER_ADMIN |
| --- | --- | --- | --- |
| Read user lists and logs | Yes | Yes | Yes |
| Manage ordinary users and change log output level | No | Yes | Yes |
| Grant read-only backend access | No | No | Yes |
| Change non-super administrator roles or access status | No | No | Yes |
| Grant SUPER_ADMIN through an API | No | No | No |
| Change a SUPER_ADMIN grant or reset its second factor administratively | No | No | No |

Super administrators manage their own password and second factors through authenticated account-security flows. Historical super administrators remain super administrators; this is not a database-enforced singleton model.

## Console workflow

The Users and Administrators tab names are unchanged.

- The Users row menu offers **Set as administrator** only to super administrators, for active local users without an Admin record. A confirmation dialog explicitly describes read-only access and revocation of previous user sessions and issued codes.
- `POST /admin/users/:id/grant-viewer` always creates `VIEWER`. No caller-supplied role is accepted as an authorization choice. Accounts with unfinished initial-password setup must finish setup first.
- The old Add administrator dialog and `POST /admin/admins/create` endpoint are removed.
- The Administrators role column is display-only. **Set role** appears beside the existing Disable/Enable control in the actions column.
- The role dialog allows only `VIEWER` and `ADMIN`, requires confirmation, and does not change the enabled state. There is no new ordinary-user role or physical deletion action.
- Super-administrator targets have no administrative mutation controls.
- Disabled Admin records are retained for audit history and credential protection; they are not eligible for a second grant through the user menu.

## Security boundaries and concurrency

Generic user disable/enable, force logout, password initialization, and login-code issuance reject targets with any Admin record, including disabled grants. Use dedicated backend-access and authenticated security flows instead. User list and detail responses include `adminRole` so controls can reflect the server policy. Client-side checks are only presentation; backend checks remain authoritative.

The account row is locked with `FOR NO KEY UPDATE` before checking for an Admin record. Granting access and user-management writes use that same lock, preventing a grant from racing an account disable, password initialization, or code issuance. When both rows are needed, lock order is Account then Admin. Administrator role/status changes re-read state after locking; real role changes/disables revoke backend sessions and login challenges in the same transaction, while same-role updates do not revoke sessions.

Granting access revokes previously issued login codes and user sessions. OTP session issuance checks again under the account lock that the user has no Admin record, preventing an already-verifying code from issuing a session after a grant. Cache invalidation and connection notifications follow the committed revocation.

Backend login, session creation, and session validation check account availability and disable state as well as Admin.enabled. Directly disabled legacy accounts cannot continue using backend sessions. Application entry points do not grant SUPER_ADMIN; the existing initialization path and database state are not migrated.

## Verification

```sh
npm run build:be
npm run build --prefix admin-web
npm test -- src/admin/admin-auth.service.spec.ts src/admin/admin-session-activity.spec.ts src/auth/otp-login.service.spec.ts src/auth/session-token.service.spec.ts
npm run test:e2e -- test/admin-rbac.e2e-spec.ts
npm test --prefix admin-web -- src/routes/admins/admins-page.spec.tsx src/routes/users/users-page.spec.tsx src/routes/users/user-detail-page.spec.tsx src/routes/logs/logs-live-page.spec.tsx
```

The PostgreSQL-backed tests cover grants, role boundaries, super-role protection independent of account name, legacy endpoint removal, generic-user bypass rejection, account disable checks, concurrent grant/disable, session revocation, and log-output authorization/audit. Frontend tests cover role-dialog confirmation, role-based action visibility, grant confirmation, and read-only log controls. These tests do not constitute a complete audit of every administrative endpoint or an authenticated browser visual review.
