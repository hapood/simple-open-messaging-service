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
  INTERNAL = 10999, // server error

  // 20xxx friend & conversation state machine
  FRIEND_SELF = 20001, // cannot friend yourself
  FRIEND_UNKNOWN_STATE = 20002, // friend state machine unknown state
  FRIEND_NO_INCOMING = 20003, // no pending friend request

  // 30xxx message domain
  MESSAGE_EMPTY = 30001, // message has no content
  THREAD_NOT_APPROVED = 30002, // conversation not established / not approved
  THREAD_NOT_FOUND = 30003, // no such conversation

  // 40xxx group domain
  GROUP_NOT_FRIEND = 40002, // non-friend cannot be invited
  GROUP_INVALID_TOKEN = 40003, // invalid invite token
  GROUP_OWNER_MUST_TRANSFER = 40004, // owner must transfer before leaving
  GROUP_FORBIDDEN = 40005, // role permission denied (cannot kick/modify/transfer this target)
  GROUP_TARGET_NOT_MEMBER = 40006, // target is not an active member of the group

  // 50xxx federation (S2S) — all protocol/system-tier; HTTP status drives sender retry, code is detail.
  FEDERATION_PEER_NOT_TRUSTED = 50001, // signer domain not in FederatedPeer trusted (401, no retry)
  FEDERATION_BAD_SIGNATURE = 50002, // signature invalid OR keyId not in the published set (401, no retry)
  FEDERATION_BINDING_VIOLATION = 50003, // from.domain != signer.domain (401, no retry)
  FEDERATION_DUPLICATE = 50004, // (origin, opId) already applied (409 → idempotent success)
  FEDERATION_KEY_FETCH_FAILED = 50006, // .well-known key fetch transient failure (503 → retry)
  FEDERATION_MALFORMED = 50007, // malformed Signature-Input / friend-op payload (401, no retry)
  FEDERATION_DELIVERY_FAILED = 50008, // sync S2S send failed (peer unreachable/rejected) — user retries
  FEDERATION_PEER_BLOCKED = 50009, // an admin blocked this peer domain — federation refused (403, no retry)
}
