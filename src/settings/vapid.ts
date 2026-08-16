import {
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
} from 'node:crypto';

/** A Web Push VAPID keypair + contact subject (RFC 8292). All fields are base64url strings. */
export interface VapidConfig {
  /** Uncompressed P-256 public key, base64url (65 bytes: 0x04 || X || Y) — the value browsers pass to
   *  PushManager.subscribe as applicationServerKey. Public by design — safe to expose to clients (the
   *  browser fetches it from GET /notifications/vapid-key to subscribe). */
  publicKey: string;
  /** P-256 private key scalar, base64url (32 bytes). Secret — used to sign the VAPID JWT per send.
   *  Write-only from the admin UI's perspective: never returned by a read endpoint. */
  privateKey: string;
  /** Contact URL surfaced to the push service / subscriber for sender identity — mailto: or https:. */
  subject: string;
}

/** Deterministic VAPID health-check report (no network access). */
export interface VapidHealthReport {
  /** A VAPID config row is stored at all. */
  configured: boolean;
  /** publicKey decodes to a 65-byte uncompressed P-256 point (leading 0x04). */
  publicKeyValid: boolean;
  /** privateKey decodes to the 32-byte P-256 scalar. */
  privateKeyValid: boolean;
  /** publicKey is derivable from privateKey (a genuine P-256 keypair, not two unrelated values). */
  pairMatches: boolean;
  /** subject is a well-formed mailto: or https: URL. */
  subjectValid: boolean;
  /** FCM send transport configured (the conventional service-account file was loaded). */
  fcmConfigured: boolean;
  /** FCM CLIENT config present (a valid data/google-services.json is on disk). This
   *  is independent of `fcmConfigured`: the server can send (service-account set) without a client config
   *  present, and vice versa — a half-configured server is observable here. */
  firebaseClientConfigured: boolean;
  /** Web Push transport ready (configured AND keypair valid). */
  webPushConfigured: boolean;
  /** This server's public domain (read-only — from SOMS_DOMAIN env, the federation identity). */
  somsDomain: string;
  /** Human-readable problems (empty when healthy). */
  errors: string[];
}

/** publicKey is base64url of a 65-byte uncompressed P-256 point (leading 0x04). */
export function isValidPublicKey(publicKey: string): boolean {
  try {
    const buf = Buffer.from(publicKey, 'base64url');
    return buf.length === 65 && buf[0] === 0x04;
  } catch {
    return false;
  }
}

/** privateKey is base64url of the 32-byte P-256 scalar. */
export function isValidPrivateKey(privateKey: string): boolean {
  try {
    return Buffer.from(privateKey, 'base64url').length === 32;
  } catch {
    return false;
  }
}

/** subject is a mailto: or https: URL (the RFC 8292 sender contact). */
export function isValidSubject(subject: string): boolean {
  try {
    const u = new URL(subject);
    return u.protocol === 'mailto:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Verify the public key is derivable from the private key — i.e. they are a genuine P-256 keypair, not
 *  two unrelated pasted values. Offset-free JWK round-trip: the only byte slices are the well-known fixed
 *  cuts of the uncompressed point (the wire format itself), so no ASN.1/DER offsets are involved. Returns
 *  false (never throws) if either input is malformed. */
export function pairMatchesKey(publicKey: string, privateKey: string): boolean {
  try {
    const pub = Buffer.from(publicKey, 'base64url');
    const priv = Buffer.from(privateKey, 'base64url');
    if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32)
      return false;
    const jwk = {
      kty: 'EC' as const,
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: priv.toString('base64url'),
    };
    const privKey = createPrivateKey({ key: jwk, format: 'jwk' });
    const derived = createPublicKey(privKey).export({
      format: 'jwk',
    }) as JsonWebKey;
    return derived.x === jwk.x && derived.y === jwk.y;
  } catch {
    return false;
  }
}
