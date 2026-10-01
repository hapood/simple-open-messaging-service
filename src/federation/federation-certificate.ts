import { ed25519 } from '@noble/curves/ed25519.js';

/** One entry of the well-known `roots` group: a root public key and the half-open
 *  validity interval during which it may authorize signing certificates. */
export interface RootKeyEntry {
  ed25519: string;
  notBefore: number;
  notAfter: number;
}

export interface SigningKeyCertificate {
  keyId: string;
  ed25519: string;
  root: string;
  notBefore: number;
  notAfter: number;
  authorizationSignature: string;
}

const BASE64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

/** The canonical certificate statement (Transport and Security 1.3): UTF-8 JSON
 *  with fixed field order and no extra whitespace. `root` binds the certificate
 *  to its authorizing root public key. */
export function signingCertificateStatement(
  certificate: Omit<SigningKeyCertificate, 'authorizationSignature'>,
): string {
  return JSON.stringify({
    keyId: certificate.keyId,
    ed25519: certificate.ed25519,
    root: certificate.root,
    usage: 'somfp-http-message-signature',
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
  });
}

/** Strict shape and signature validation of one certificate against the named
 *  root public key. Structural validity of the root itself (canonical base64)
 *  is checked here; group membership and interval enclosure against the
 *  publisher's `roots` group are the document validator's responsibility. */
export function verifySigningCertificate(
  certificate: SigningKeyCertificate,
  rootPublicKey: string,
): boolean {
  if (
    !BASE64_KEY_RE.test(rootPublicKey) ||
    !BASE64_KEY_RE.test(certificate.ed25519) ||
    !BASE64_SIGNATURE_RE.test(certificate.authorizationSignature) ||
    !Number.isSafeInteger(certificate.notBefore) ||
    !Number.isSafeInteger(certificate.notAfter) ||
    certificate.notBefore < 0 ||
    certificate.notBefore >= certificate.notAfter
  ) {
    return false;
  }
  if (certificate.root !== rootPublicKey) return false;
  try {
    return ed25519.verify(
      Buffer.from(certificate.authorizationSignature, 'base64'),
      Buffer.from(
        signingCertificateStatement({
          keyId: certificate.keyId,
          ed25519: certificate.ed25519,
          root: certificate.root,
          notBefore: certificate.notBefore,
          notAfter: certificate.notAfter,
        }),
      ),
      Buffer.from(rootPublicKey, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Structural check of one `roots` group entry (interval sanity and canonical
 *  base64 key); uniqueness and overlap are document-level properties. */
export function isValidRootKeyEntry(entry: unknown): entry is RootKeyEntry {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as { ed25519?: unknown; notBefore?: unknown; notAfter?: unknown };
  return (
    typeof value.ed25519 === 'string' &&
    BASE64_KEY_RE.test(value.ed25519) &&
    Number.isSafeInteger(value.notBefore) &&
    Number.isSafeInteger(value.notAfter) &&
    (value.notBefore as number) >= 0 &&
    (value.notBefore as number) < (value.notAfter as number)
  );
}
