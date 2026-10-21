import {
  isValidRootKeyEntry,
  type RootKeyEntry,
  type SigningKeyCertificate,
  verifySigningCertificate,
} from './federation-certificate.js';
import { selectFederationProtocolVersion } from './federation-protocol.js';
import { parseKeyId } from './key-id.js';

/** The public `/.well-known/somfp` v1 discovery document. Owned here so the
 *  document contract has one definition shared by discovery and diagnostics. */
export interface WellKnownDoc {
  software?: string;
  protocolVersions: number[];
  roots: RootKeyEntry[];
  keys: SigningKeyCertificate[];
  [key: string]: unknown;
}

const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

/** Normalize to the canonical SOMFP server identity form; rejects anything that
 *  is not a plain lowercase hostname. */
export function normalizeFederationDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (!DOMAIN_RE.test(normalized)) throw new Error(`invalid domain ${domain}`);
  return normalized;
}

/** Full peer-side validation of a discovery document (Transport and Security 1.1):
 *  shape, protocol-version selection, software sanity, the roots group (unique keys,
 *  sane intervals, at least one currently valid root), and every signing certificate
 *  (keyId domain binding and uniqueness, root group membership, interval enclosure,
 *  authorization signature), plus at least one currently valid signing key. Pure: no
 *  cache writes, no network. Throws with a reason on the first violation. */
export function validateWellKnownDocument(
  domain: string,
  value: unknown,
): WellKnownDoc {
  const normalized = normalizeFederationDomain(domain);
  const doc = value as Partial<WellKnownDoc> | null;
  const softwareValid =
    doc?.software === undefined ||
    (typeof doc.software === 'string' &&
      Buffer.byteLength(doc.software) >= 1 &&
      Buffer.byteLength(doc.software) <= 128 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(doc.software));
  const now = Date.now();
  if (
    !doc ||
    selectFederationProtocolVersion(doc.protocolVersions) !== 1 ||
    !softwareValid ||
    !Array.isArray(doc.roots) ||
    doc.roots.length === 0 ||
    !Array.isArray(doc.keys) ||
    doc.keys.length === 0
  ) {
    throw new Error(`well-known ${normalized}: malformed v1 document`);
  }
  // Root group: unique canonical keys, sane intervals, and at least one
  // currently valid root when the document is consumed.
  const rootEntries = new Map<string, RootKeyEntry>();
  for (const entry of doc.roots) {
    if (!isValidRootKeyEntry(entry) || rootEntries.has(entry.ed25519)) {
      throw new Error(`well-known ${normalized}: invalid roots group`);
    }
    rootEntries.set(entry.ed25519, entry);
  }
  if (
    ![...rootEntries.values()].some(
      (entry) => entry.notBefore <= now && now < entry.notAfter,
    )
  ) {
    throw new Error(`well-known ${normalized}: no currently valid root`);
  }
  const ids = new Set<string>();
  for (const certificate of doc.keys) {
    const authorizing = rootEntries.get(certificate?.root as string);
    if (
      !certificate ||
      typeof certificate.keyId !== 'string' ||
      parseKeyId(certificate.keyId)?.domain !== normalized ||
      ids.has(certificate.keyId) ||
      !authorizing ||
      // The certificate interval must be enclosed by its root's interval.
      certificate.notBefore < authorizing.notBefore ||
      certificate.notAfter > authorizing.notAfter ||
      !verifySigningCertificate(certificate, certificate.root)
    ) {
      throw new Error(`well-known ${normalized}: invalid signing certificate`);
    }
    ids.add(certificate.keyId);
  }
  if (
    !doc.keys.some(
      (certificate) =>
        certificate.notBefore <= Date.now() &&
        Date.now() < certificate.notAfter,
    )
  ) {
    throw new Error(`well-known ${normalized}: no currently valid signing key`);
  }
  return doc as WellKnownDoc;
}
