/**
 * Business code segments (P1b status-code alignment).
 *
 * Modeled on WhatsApp Cloud API's "grouped by domain prefix" independent code space:
 * - 0       success
 * - 10xxx   generic business (validation / not-found / conflict / unauthenticated / rate-limit / server)
 * - 20xxx   friend & conversation state machine
 * - 30xxx   message domain
 * - 40xxx   group domain
 * - 50xxx   federation S2S (recognition required / bad signature / binding violation / duplicate /
 *           unsupported type / malformed)
 *
 * Convention (see docs/api/api.md): business outcomes always return HTTP 200 + a business code;
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
  PROFILE_RESOLUTION_CAPACITY = 10026, // bounded profile scheduler cannot admit another immutable key or evidence method; retry later
  INTERNAL = 10999, // server error

  // 20xxx friend / invite state
  FRIEND_SELF = 20001, // cannot invite / friend yourself
  FRIEND_NOT_FOUND = 20002, // the requested relationship does not exist
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
  CLIENT_FEED_CURSOR_UNAVAILABLE = 30006, // a message or tombstone body cursor is invalid; data carries integer resume bounds
  THREAD_FEED_CURSOR_INVALID = 30007, // attention range is ahead of the current account feed

  // 40xxx group domain
  GROUP_INVALID_TOKEN = 40003, // invalid invite token
  GROUP_OWNER_MUST_TRANSFER = 40004, // owner must transfer before leaving
  GROUP_FORBIDDEN = 40005, // role permission denied (cannot kick/modify/transfer this target)
  GROUP_TARGET_NOT_MEMBER = 40006, // target is not an active member of the group
  GROUP_DISSOLVED = 40007, // terminal group state: history remains readable, sending/membership changes stop
  GROUP_FULL = 40008, // this origin server's local group-member capacity has been reached (not an S2S protocol limit)

  // 50xxx federation (S2S). Ordinary operation outcomes use HTTP 200 and the code carries the
  // business meaning. Only malformed/authentication failures (400/401), temporary service
  // unavailability (503), and registered peer-relationship conflicts (409) use non-200 JSON responses.
  FEDERATION_RECOGNITION_REQUIRED = 50001, // required directional recognition prerequisites are incomplete (401)
  FEDERATION_BAD_SIGNATURE = 50002, // signature invalid OR keyId not in the published set (401, no retry)
  FEDERATION_BINDING_VIOLATION = 50003, // from.domain != signer.domain (401, no retry)
  FEDERATION_DUPLICATE = 50004, // (origin, opId) already applied (HTTP 200 idempotent result)
  FEDERATION_MALFORMED = 50007, // malformed HTTP/header/query/JSON or operation payload (400, no retry)
  FEDERATION_DELIVERY_FAILED = 50008, // sync S2S send failed (peer unreachable/rejected) — user retries
  FEDERATION_PEER_BLOCKED = 50009, // registered fatal federation relationship conflict (HTTP 409)
  FEDERATION_GROUP_AUTHOR_LEFT = 50010, // retained business code for a remote group author that has left
  FEDERATION_QUOTA_EXCEEDED = 50011, // a federated peer exceeded an implementation-defined quota → HTTP 200;
  // the body carries only {retryAfter}. Returned on
  // state/message/media ingestion refuses internally (no peer-visible status). NEVER degrades the peer —
  // 429 is outside the degradation set in getSigned/sendSignedPost. See src/quota/.
  FEDERATION_PAYLOAD_TOO_LARGE = 50012, // a parsed federation item exceeds its operation limit → HTTP 200
  // (permanent for that item; v1 defines no structured data for this code). Refused at ingest before
  // any disk write. NEVER degrades the peer.
  FEDERATION_CAPABILITY_DISABLED = 50013, // the peer administrator set this category's effective limit/cap to 0.
  // This is a stable business refusal (HTTP 200), not a depleted daily budget: retrying after midnight
  // cannot help. The body carries {category}; NEVER degrades the peer.
  FEDERATION_LOCAL_IDENTITY_LOST = 50014, // local federation service cannot sign safely (HTTP 503)
  FEDERATION_IDENTITY_MISMATCH = 50015, // registered fatal root identity conflict (HTTP 409)
  FEDERATION_PEER_IDENTITY_LOST = 50016, // internal/local diagnostic; not a Federation v1 wire code
  FEDERATION_FEED_CURSOR_UNAVAILABLE = 50019, // missing/expired feed cursor; data carries operation-specific recovery boundaries
  FEDERATION_PROTOCOL_VERSION_UNSUPPORTED = 50020, // registered fatal version conflict (HTTP 409)
  FEDERATION_RANGE_NOT_SATISFIABLE = 50021,
  FEDERATION_PROFILE_NOT_DISCLOSED = 50023, // the user has chosen not to disclose the public profile
  // to this peer. A publisher MAY return NOT_FOUND instead to avoid revealing whether the account exists.
  FEDERATION_MESSAGE_QUERY_RATE_LIMITED = 50024, // HTTP 200 + { retryAfter }; query cursor is unchanged
  FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE = 50025, // HTTP 200 + { retryAfter }; peer is not degraded
  FEDERATION_NAMESPACE_INACTIVE = 50026, // local client attempted to write to a thread owned by an archived namespace
  FEDERATION_DOMAIN_CONFLICT = 50027, // the presented domain is bound to another peer identity or is pending on one; not fatal for the existing relationship
  FEDERATION_DOMAIN_CHANGE_REJECTED = 50028, // administrator rejected a verified domain re-binding candidate; fatal for the relationship
  FEDERATION_ROOT_CHANGE_REJECTED = 50029, // administrator rejected a verified root rotation arrival; operation-level, the pin and lifecycle are retained
  FEDERATION_PUBLIC_KEY_UNRECOGNIZED = 50030, // the supplied public key is not part of this server's retained key history (sealed-challenge service)
  FEDERATION_PROVENANCE_DECLINED = 50031, // the responder declines the entire message-provenance batch; HTTP 200, no results; not a transport or peer-lifecycle event

  // 60xxx settings (admin-managed runtime config)

  // 70xxx 1:1 WebRTC call domain (signaling coordinator + lifecycle; media is P2P)
  CALL_NOT_ALLOWED = 70001, // cannot call this user (not friends / no active P2P thread)
  CALL_NOT_FOUND = 70002, // callSid unknown, or the call is no longer active (already ended)
  CALL_NOT_PARTICIPANT = 70003, // you are neither the caller nor the callee of this call
  CALL_BUSY = 70004, // the callee — or the caller — is already in an active call (one active call per user)
  CALL_INVALID_TRANSITION = 70005, // this call state transition is not allowed (e.g. accept a non-ringing call)
  CALL_PEER_UNREACHABLE = 70006, // a federated call's ring/setup failed — the peer server was unreachable / busy / rejected.
  CALL_CANCELLED = 70007, // a federated call was already cancelled; converge pending local state to cancelled.
  CALL_TERMINATED = 70008, // a federated call already reached another terminal outcome; stop dependent frames.
  // Thrown by the caller's server when the S2S `incoming` POST fails; the `unreachable` terminal
  // bubble is already written before this surfaces to the caller's client.
}
