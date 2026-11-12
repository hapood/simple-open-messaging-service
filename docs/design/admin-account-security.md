# Administrator account security

For role assignment, access revocation, and administrator-management permissions,
see [Administrator access management](./admin-access.md).

## Ownership and storage

Administrators share the password on their linked `Account`. The existing `Admin`,
`AdminSession`, `SessionToken`, `TwoFactorBackupCode`, `WebAuthnCredential`, and
`AdminLoginChallenge` tables are reused. There is no additional schema or cache.

[AccountSecurityService](../../src/admin/account-security.service.ts) owns
self-service password and factor changes. Controllers derive the administrator
and session identifiers from the authenticated principal, never from request bodies.

## Fresh authentication

Password changes, authenticator enrollment/removal, recovery-code regeneration,
and passkey enrollment/removal require the current password. If a second factor
is enrolled, the operation also requires a fresh authenticator code, recovery
code, or passkey assertion. TOTP and passkeys can coexist; either enrolled factor
satisfies the second step. Renaming a passkey changes only its display label.

The consumer password-change/set endpoints and user initial-password generation
refuse administrator-linked accounts. Administrators must use My Account so those
paths cannot bypass their second factor. The super-administrator recovery endpoint
cannot reset the caller's own authenticator or any SUPER_ADMIN target's authenticator.
Super administrators must use authenticated self-service security operations.

Passkey assertion tokens bind the administrator, current session, operation,
credential target when relevant, and a fingerprint of the current authentication
state. Enrollment permits additionally wrap the candidate registration or TOTP
setup token and expire after five minutes. The browser never receives the stored
password hash in those tokens. Login assertions are bound to their specific
single-use login challenge, rather than just the administrator identifier.

## Commit and replay protection

Security mutations acquire `FOR NO KEY UPDATE` locks in Account → Admin → session
order, recheck the initiating session and authentication state, then consume the
proof and mutate security data. TOTP counters and recovery-code consumption are
transactional. A passkey counter CAS that loses its race fails authentication.
Zero-counter authenticators also need the operation binding and session checks;
the authenticator counter alone is not replay protection.

Successful security mutations revoke all of the caller's admin and consumer
sessions, including the initiating session. They invalidate pending admin login
challenges and advance the existing account update timestamp, invalidating older
signed proofs. The initiating session's revocation makes enrollment permits and
mutation assertions unusable after success, without another challenge table.
Failed transactions do not change passwords or revoke sessions.

Session issuance participates in the account lock and checks captured password
state before publishing a credential. QR handoffs retain the authorizing session
identifier and check that session when issuing the destination credential.

## Existing cache behavior

The consumer session cache remains a single-process optimization. A fresh,
unexpired entry authenticates without a database read. A miss or activity deadline
rechecks the database; validation can update an existing entry but cannot recreate
one deleted by revocation.

Issuance initializes its entry before committing/releasing the account lock and
publishes the plaintext credential only after commit. A failed issuance commit
removes that entry. This prevents a delayed initialization from recreating a
cache entry after password rotation. Security mutations delete revoked entries
before returning success and notify connected consumer clients to sign out.

This preserves the existing single-instance deployment assumption; it does not
introduce distributed cache invalidation or claim multi-instance cache coherence.

## Console behavior

My Account is in the personal-account footer. Administrator Sessions is the
`/sessions/admins` tab under Login & security, separate from consumer sessions.
My Account shows the server-observed current request IP, not an immutable
historical login IP. Every administrator, including VIEWER, can end their own
other console sessions. Only SUPER_ADMIN can end another administrator's session.
The current session is flagged and must be ended through Logout, not a row action.
Revocation is immediate and audited; the server enforces ownership and supplies
`canRevoke` for presentation. The list excludes revoked, expired, idle-expired,
and disabled-admin sessions; valid does not mean currently online.

Security dialogs warn about signing out all devices. Recovery codes are displayed
once after commit; account queries are paused while the dialog is open to avoid
an authentication refetch redirecting away before the codes are saved.
