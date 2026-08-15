import { ed25519 } from '@noble/curves/ed25519.js';

export interface SigningKeyCertificate {
  keyId: string;
  ed25519: string;
  notBefore: number;
  notAfter: number;
  authorizationSignature: string;
}

const BASE64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

export function signingCertificateStatement(
  certificate: Omit<SigningKeyCertificate, 'authorizationSignature'>,
): string {
  return JSON.stringify({
    keyId: certificate.keyId,
    ed25519: certificate.ed25519,
    usage: 'socfp-http-message-signature',
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
  });
}

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
  try {
    return ed25519.verify(
      Buffer.from(certificate.authorizationSignature, 'base64'),
      Buffer.from(signingCertificateStatement(certificate)),
      Buffer.from(rootPublicKey, 'base64'),
    );
  } catch {
    return false;
  }
}

export function certificateDomain(keyId: string): string | undefined {
  const slash = keyId.indexOf('/');
  if (slash <= 0 || slash === keyId.length - 1) return undefined;
  return keyId.slice(0, slash);
}
