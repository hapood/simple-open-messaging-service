import { isValidSomfpDomain } from '../common/account.js';

/**
 * SOMFP `KeyId` wire type: `Domain "/" KeyName`, where `KeyName` matches
 * `^[A-Za-z0-9._-]{1,64}$`. The complete string before the first `/` is the
 * signer domain; the `KeyName` is opaque and carries no ordering, activation,
 * or rotation semantics.
 *
 * Parsing is exact: no case folding, whitespace trimming, or any other
 * normalization is applied anywhere in the protocol. Matching between a
 * `keyid` and a published certificate is exact over the complete string.
 */
export interface ParsedKeyId {
  domain: string;
  keyName: string;
}

const KEY_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Strictly parse a `KeyId` wire value; returns null for any shape that does not
 *  satisfy the grammar. The domain part is validated as a SOMFP wire Domain. */
export function parseKeyId(value: string): ParsedKeyId | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const domain = value.slice(0, slash);
  const keyName = value.slice(slash + 1);
  if (!isValidSomfpDomain(domain) || !KEY_NAME_RE.test(keyName)) return null;
  return { domain, keyName };
}
