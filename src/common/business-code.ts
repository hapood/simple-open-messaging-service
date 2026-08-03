/**
 * Business code segments (P1b status-code alignment).
 *
 * Modeled on WhatsApp Cloud API's "grouped by domain prefix" independent code space:
 * - 0       success
 * - 10xxx   generic business (validation / not-found / conflict / unauthenticated / rate-limit / server)
 * - 20xxx   friend & conversation state machine
 * - 30xxx   message domain
 * - 40xxx   group domain
 * - 50xxx   federation S2S (peer not trusted / bad signature / binding violation / duplicate /
 *           unsupported type / key-fetch failed / malformed)
 * - 60xxx   admin settings (VAPID keypair validation)
 *
 * Convention (see protocol-plan §5.2): business outcomes always return HTTP 200 + a business code;
 * only the protocol/system layer — unauthenticated(401) / not-found(404) / conflict(409) /
 * server-error(500) — retains its HTTP status code for the broad category, with body.code mapped
 * to the matching 10xxx segment. The S2S friend-op endpoints are entirely protocol/system-tier
 * (auth/system/conflict), so the HTTP status drives sender retry (2xx delivered / 4xx permanent
 * dead / 5xx backoff retry) and the code is for logging/detail.
 */
export enum BusinessCode {
  OK = 0,

  // 10xxx generic
  VALIDATION_FAILED = 10000, // parameter validation failed (was ValidationPipe 400)
  NOT_FOUND = 10001, // resource not found
  ALREADY_EXISTS = 10002, // resource already exists (conflict)
  UNAUTHENTICATED = 10003, // unauthenticated
  FORBIDDEN = 10004, // forbidden
  RATE_LIMITED = 10005, // rate limited / IP banned
  REFRESH_REUSE_DETECTED = 10006, // refresh-token reuse → force frontend re-login (family revoked at the root)
  SESSION_REVOKED = 10007, // session revoked (all-device logout / password change / single-device kick)
  QUOTA_EXCEEDED = 10008, // daily-quota budget exhausted on a LOCAL user endpoint (HTTP 200 + this code; the
  // body carries {category, limit, retryAfter}). Distinct from the IP-burst RATE_LIMITED
  // (10005): a daily budget is a business outcome, not a protocol rate-limit. See src/quota/.
  INVALID_CREDENTIALS = 10009, // wrong account/password at a login boundary (consumer /auth/login, admin /admin/login).
  // Distinct from UNAUTHENTICATED (10003): 10003 = a request lacking valid auth
  // mid-session (expired/invalid/reused token) → "please sign in again"; 10009 = the
  // user is already AT the login screen and the typed credentials don't match →
  // "incorrect account or password". Same code for wrong-account and wrong-password
  // to avoid user enumeration (see AuthService.validateUser, which collapses both).
  REGISTRATION_DISABLED = 10010, // self-registration is closed (admin-provisioned accounts only); POST user/register
  // refuses. Advertised via GET /config registrationOpen=false, so the UI hides the
  // register affordance; this is the defense-in-depth server gate.
  LOGIN_METHOD_DISABLED = 10011, // the requested login method is disabled under the current loginMode (GET /config).
  // Returned by the password-login path under APP_OTP_AND_QR, and by OTP/QR under
  // PASSWORD_ONLY.
  OTP_INVALID = 10012, // admin-issued one-time login code does not match / no active code for the account
  OTP_EXPIRED = 10013, // one-time login code is past its expiresAt
  OTP_CONSUMED = 10014, // one-time login code was already used (single-use)
  QR_INVALID = 10015, // QR login token unknown / malformed
  QR_EXPIRED = 10016, // QR login token is past its TTL
  PASSWORD_NOT_SET = 10017, // password-login attempted on a no-password account (OTP/QR-only). UI: "contact the administrator to set the initial password". NOT counted toward the brute-force ban (no password to guess).
  MUST_CHANGE_PASSWORD = 10018, // the authenticated user's password is the admin-generated INITIAL value and must be rotated. Thrown by the global SessionAuthGuard for EVERY route except the password-set escape hatch (+ @Public) — a server-side gate, NOT a frontend hint, so a user cannot keep using the initial password by skipping the set-password screen or calling the API directly. Same response shape regardless of login method (password/OTP/QR), so the gate is login-method-agnostic.
  TWO_FACTOR_INVALID = 10019, // admin TOTP / backup code did not match (login verify, disable, regenerate) — or no backup codes left. Counted toward the admin-2FA brute-force lock; collapsed with wrong-code to avoid code-value enumeration.
  TWO_FACTOR_CHALLENGE_EXPIRED = 10020, // admin login/setup token (challenge or pending) is invalid or past its TTL — the admin must restart the login/enroll flow.
  TWO_FACTOR_NOT_ENABLED = 10021, // a 2FA operation (login verify, disable, regenerate) targeted an admin who does not have 2FA enabled.
  TWO_FACTOR_ALREADY_ENABLED = 10022, // admin tried to begin 2FA setup while already enrolled (use disable first to re-enroll with a fresh secret).
  WEBAUTHN_NOT_AVAILABLE = 10023, // WebAuthn is unavailable in this deployment (SOMS_TLS_MODE=disabled over a non-localhost origin → not a secure context). Surfaced by the status endpoint so the UI hides the passkey affordance; the endpoints themselves still respond.
  WEBAUTHN_CHALLENGE_EXPIRED = 10024, // a WebAuthn pending token (registration or assertion) is invalid or past its TTL — the admin must restart the enroll/login flow.
  WEBAUTHN_VERIFICATION_FAILED = 10025, // verifyRegistrationResponse / verifyAuthenticationResponse rejected the credential (tampered, wrong RP/origin, counter regression / suspected clone). Counted toward the admin-2FA brute-force lock at the login boundary.
  INTERNAL = 10999, // server error

  // 20xxx friend / invite state
  FRIEND_SELF = 20001, // cannot invite / friend yourself
  FRIEND_NOT_FOUND = 20002, // cannot unfriend someone who is not your friend (delete-friend on a non-edge)
  FRIEND_INVALID_TARGET = 20004, // cannot befriend this target (e.g. a `!`-group account)
  INVITE_NOT_FOUND = 20010, // invite does not exist or is no longer pending
  INVITE_EXPIRED = 20011, // invite is past its expiresAt
  INVITE_NOT_YOURS = 20012, // invite belongs to another user (not your decision / not your outgoing)
  INVITE_ALREADY_HANDLED = 20013, // invite already accepted / rejected / revoked

  // 30xxx message domain
  MESSAGE_EMPTY = 30001, // message has no content
  THREAD_NOT_APPROVED = 30002, // conversation not established / not approved
  THREAD_NOT_FOUND = 30003, // no such conversation
  FORWARD_MAX_DEPTH_EXCEEDED = 30004, // forwarding a depth-3 bundle would create an unsupported depth-4 snapshot
  FORWARD_INVALID_BUNDLE = 30005, // malformed/missing/inaccessible forward bundle or source message

  // 40xxx group domain
  GROUP_NOT_FRIEND = 40002, // non-friend cannot be invited
  GROUP_INVALID_TOKEN = 40003, // invalid invite token
  GROUP_OWNER_MUST_TRANSFER = 40004, // owner must transfer before leaving
  GROUP_FORBIDDEN = 40005, // role permission denied (cannot kick/modify/transfer this target)
  GROUP_TARGET_NOT_MEMBER = 40006, // target is not an active member of the group
  GROUP_DISSOLVED = 40007, // terminal group state: history remains readable, sending/membership changes stop

  // 50xxx federation (S2S) — protocol/system-tier; HTTP status drives sender retry, code is detail.
  //       Exception: GET /s2s/messages returns business outcomes at HTTP 200 (the pull itself succeeded; the
  //       body IS the result), so a 200 + code there is a normal outcome, not a retryable failure.
  FEDERATION_PEER_NOT_TRUSTED = 50001, // signer domain not in FederatedPeer trusted (401, no retry)
  FEDERATION_BAD_SIGNATURE = 50002, // signature invalid OR keyId not in the published set (401, no retry)
  FEDERATION_BINDING_VIOLATION = 50003, // from.domain != signer.domain (401, no retry)
  FEDERATION_DUPLICATE = 50004, // (origin, opId) already applied (409 → idempotent success)
  FEDERATION_KEY_FETCH_FAILED = 50006, // .well-known key fetch transient failure (503 → retry)
  FEDERATION_MALFORMED = 50007, // malformed Signature-Input / friend-op payload (401, no retry)
  FEDERATION_DELIVERY_FAILED = 50008, // sync S2S send failed (peer unreachable/rejected) — user retries
  FEDERATION_PEER_BLOCKED = 50009, // an admin blocked this peer domain — federation refused (403, no retry)
  FEDERATION_GROUP_AUTHOR_LEFT = 50010, // per-author group pull: the author is no longer an active member → thrown
  // as HTTP 410 GONE on /s2s/messages?fromAccount=... so the origin dissolves its
  // roster entry (softLeaveMember + bump group meta). The pulling side detects it
  // via S2sResponseError.status === 410 (NOT by the body code); 410 is a resource-
  // state signal, not a peer failure, so getSigned does NOT demote.
  FEDERATION_QUOTA_EXCEEDED = 50011, // a federated peer exceeded its daily-quota budget → HTTP 429 (transient; the
  // body carries {category, limit, retryAfter = seconds to 00:00 UTC}). Returned on
  // the synchronous POST /s2s/invite leg; the pull-based messages/media legs refuse
  // internally (no peer-visible status). NEVER demotes the peer — 429 is outside the
  // demote set in getSigned/sendSignedPost. See src/quota/.
  FEDERATION_PAYLOAD_TOO_LARGE = 50012, // an inbound federated media item exceeds the single-item byte cap → HTTP 413
  // (permanent for that item; the body carries {category, limit, received}). Refused
  // at ingest before any disk write. NEVER demotes the peer.
  FEDERATION_CAPABILITY_DISABLED = 50013, // the peer administrator set this category's effective limit/cap to 0.
  // This is a stable policy refusal (HTTP 403), not a depleted daily budget: retrying after midnight
  // cannot help. The body carries {category}; NEVER demotes the peer.

  // 60xxx settings (admin-managed runtime config)
  VAPID_INVALID = 60001, // VAPID keypair failed validation (malformed / mismatched pair / bad subject)

  // 70xxx 1:1 WebRTC call domain (signaling coordinator + lifecycle; media is P2P)
  CALL_NOT_ALLOWED = 70001, // cannot call this user (not friends / no active P2P thread)
  CALL_NOT_FOUND = 70002, // callSid unknown, or the call is no longer active (already ended)
  CALL_NOT_PARTICIPANT = 70003, // you are neither the caller nor the callee of this call
  CALL_BUSY = 70004, // the callee — or the caller — is already in an active call (one active call per user)
  CALL_INVALID_TRANSITION = 70005, // this call state transition is not allowed (e.g. accept a non-ringing call)
  CALL_PEER_UNREACHABLE = 70006, // a federated call's ring/setup failed — the peer server was unreachable / busy / rejected.
  // Thrown by the caller's server when the S2S `incoming` POST fails; the `unreachable` terminal
  // bubble is already written before this surfaces to the caller's client.
}
