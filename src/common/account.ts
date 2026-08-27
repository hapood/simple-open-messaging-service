import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { isUniqueViolation } from '../database/database-error.js';

/**
 * Account grammar — single source of truth. This module is the code
 * counterpart: every site that creates, validates, normalizes, or mints an account string goes through
 * here. The spec is authoritative; if code and spec disagree, fix the code.
 *
 * Person and group addresses use distinct tables and grammar classes:
 *   - USER : SOMFP UserAccount (`[a-z0-9][a-z0-9._-]{0,29}`), normalized to lowercase on local input.
 *     The `!` group sigil stays un-spoofable because it is outside that alphabet.
 *   - GROUP: a leading `!` + an opaque id (the `!` can never appear in a user account, so the sigil is
 *            an un-spoofable discriminator stored only in Group.account).
 */

/** SOMFP UserAccount: 1–30 ASCII chars; first char is alphanumeric, remaining chars may additionally
 *  contain `.`, `_`, or `-`. `/i` accepts friendly local input; every write normalizes to lowercase,
 *  while Federation wire validators require the already-normalized lowercase form. */
export const USER_ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,29}$/i;

/** Already-normalized SOMFP wire form. Unlike USER_ACCOUNT_RE, uppercase input is rejected. */
export const SOMFP_USER_ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,29}$/;

const SOMFP_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

/** Group account: `!` + 2–30 chars of `[a-z0-9]` (total 3–31). The recommended body is a 26-char ULID. */
export const GROUP_ACCOUNT_RE = /^![a-z0-9]{2,30}$/;

/** Lowercase an account for storage/lookup. REQUIRED because Postgres' `@@unique([account, domain])` is
 *  case-sensitive — the `/i` regex flag does NOT achieve case-insensitivity at the DB level. Apply on
 *  every write (and defensively on lookup). */
export function normalizeAccount(account: string): string {
  return account.toLowerCase();
}

export function isValidUserAccount(account: string): boolean {
  return USER_ACCOUNT_RE.test(account);
}

export function isValidSomfpUserAccount(account: string): boolean {
  return SOMFP_USER_ACCOUNT_RE.test(account);
}

/** A globally meaningful SOMFP server identity. RFC 6762 `.local` names are link-local and the bare
 *  `local` label is reserved by SOMS as its persistence marker, so neither is valid on the wire. */
export function isValidSomfpDomain(domain: string): boolean {
  return (
    domain.length <= 253 &&
    SOMFP_DOMAIN_RE.test(domain) &&
    domain !== 'local' &&
    !domain.endsWith('.local')
  );
}

export function parseSomfpUserAddress(
  address: string,
): { account: string; domain: string } | null {
  const separator = address.indexOf('@');
  if (separator <= 0 || separator !== address.lastIndexOf('@')) return null;
  const account = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  return isValidSomfpUserAccount(account) && isValidSomfpDomain(domain)
    ? { account, domain }
    : null;
}
export function isValidGroupAccount(account: string): boolean {
  return GROUP_ACCOUNT_RE.test(account);
}

/** A wire account is well-formed if it matches EITHER grammar (inbound S2S may carry a user or a group). */
export function isValidAccount(account: string): boolean {
  return isValidUserAccount(account) || isValidGroupAccount(account);
}

/** String-context discriminator for wire addresses. Database queries use the User or Group table. */
export function isGroupAccount(account: string): boolean {
  return account.startsWith('!');
}

// ── ULID minting (CSPRNG) ─────────────────────────────────────────────────────────────────────────
// ulid@3.0.2's default `ulid()` draws randomness from Math.random. We inject a CSPRNG (node:crypto
// randomBytes) so group ids get the full 80-bit collision resistance, consistent with the project's
// crypto stance. monotonicFactory additionally guarantees no within-process same-ms collision.
const csprng = (): number => randomBytes(4).readUInt32BE(0) / 0x100000000;
const monotonicUlid = monotonicFactory(csprng);

/** A 26-char Crockford-base32 ULID, CSPRNG-backed + monotonic within the process. Lowercase (ULID base32
 *  is case-insensitive) to match the case-insensitive account contract. */
export function mintUlid(): string {
  return monotonicUlid().toLowerCase();
}

/** A group account = `!` + a fresh ULID. The CALLER wraps the row create in a regenerate-on-P2002 loop
 *  — multi-process same-ms draws can still collide at the unique index, so
 *  the loop is a real (if probabilistically rare) safety net, not a digit-suffix retreat. */
export function mintGroupAccount(): string {
  const account = '!' + mintUlid();
  // Belt-and-suspenders on a proven-impossible path: the lowercased Crockford-base32 ULID alphabet is a
  // strict subset of GROUP_ACCOUNT_RE's [a-z0-9], so this CAN'T fail today. Enforce the contract anyway so
  // a future ULID-library swap can't silently mint an illegal account. Internal invariant → a thrown Error
  // (5xx), NOT a user-facing BusinessException — this is a "the mint is broken" bug, not user input.
  if (!isValidGroupAccount(account)) {
    throw new Error(
      `mintGroupAccount invariant violated: produced invalid account [${account}]`,
    );
  }
  return account;
}

/** PostgreSQL unique-constraint violation. Kept under the historical name for call-site stability. */
export function isP2002(e: unknown): boolean {
  return isUniqueViolation(e);
}
