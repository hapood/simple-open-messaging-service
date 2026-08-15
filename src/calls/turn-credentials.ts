import { createHmac } from 'node:crypto';

/**
 * TURN REST API credentials (the time-limited shared-secret auth coturn's `use-auth-secret` /
 * `static-auth-secret` mode uses). Per the TURN REST convention (draft-uberti-behave-turn-rest):
 * the app mints a per-user, time-boxed credential from a secret it holds in common with coturn;
 * coturn recomputes the same HMAC at handshake time to validate it. The plaintext secret never
 * leaves the server — it is operational infra config, read from SOMS_TURN_REST_SECRET.
 *
 * - username = "<expiryUnixSeconds>:<userId>" — the expiry is the credential's deadline; the userId
 *   suffix lets coturn attribute the relay user (informational on the coturn side).
 * - credential = HMAC-SHA1(secret, username), base64 — coturn's expected algorithm for REST creds.
 */

export interface TurnRestCredential {
  username: string;
  credential: string;
}

/** Default credential TTL when SOMS_TURN_TTL is unset (1 hour). */
export const DEFAULT_TURN_TTL_SECONDS = 3600;

/** Mint a time-limited TURN REST credential. `nowSeconds` is injected so tests are deterministic. */
export function mintTurnCredential(
  secret: string,
  userId: number,
  ttlSeconds: number,
  nowSeconds: number,
): TurnRestCredential {
  const expiry = nowSeconds + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, credential };
}

/** One iceServers entry (matches the browser's RTCIceServer shape, minus DOM-only fields). */
export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Assemble the WebRTC iceServers config for a user. STUN (SOMS_STUN_URLS) is always returned when
 * configured. TURN (time-limited REST creds) is added when SOMS_TURN_URLS AND SOMS_TURN_REST_SECRET
 * are BOTH set; when NEITHER is set the result is STUN-only (or empty) — the normal no-TURN mode
 * (calls still work P2P for cone-NAT pairs; TURN is the relay fallback), NOT an error. A PARTIAL
 * TURN config (one set without the other) is a deployment misconfiguration and THROWS: handing the
 * client a silently-STUN-only set when the operator clearly intended a TURN relay would mask the
 * broken relay until the 10–20% of calls that need it fail. Fail loud (the thrown Error surfaces as
 * HTTP 500 via the global filter). `nowSeconds` is injected for deterministic testing.
 */
export function buildIceServers(
  userId: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { iceServers: IceServerEntry[] } {
  const iceServers: IceServerEntry[] = [];

  const stunRaw = process.env.SOMS_STUN_URLS;
  if (stunRaw) {
    const urls = stunRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length > 0)
      iceServers.push({ urls: urls.length === 1 ? urls[0] : urls });
  }

  const turnRaw = process.env.SOMS_TURN_URLS;
  const secret = process.env.SOMS_TURN_REST_SECRET;
  // TURN invoked (at least one of URLs/secret set) ⇒ BOTH must be present.
  if (turnRaw || secret) {
    if (!turnRaw || !secret) {
      throw new Error(
        'TURN misconfiguration: SOMS_TURN_URLS and SOMS_TURN_REST_SECRET must both be set, or both unset (STUN-only).',
      );
    }
    const urls = turnRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ttl = Number(process.env.SOMS_TURN_TTL) || DEFAULT_TURN_TTL_SECONDS;
    const cred = mintTurnCredential(secret, userId, ttl, nowSeconds);
    iceServers.push({
      urls: urls.length === 1 ? urls[0] : urls,
      username: cred.username,
      credential: cred.credential,
    });
  }

  return { iceServers };
}
