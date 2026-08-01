import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { isUniqueViolation } from '../database/database-error.js';

/**
 * Account grammar — single source of truth. This module is the code
 * counterpart: every site that creates, validates, normalizes, or mints an account string goes through
 * here. The spec is authoritative; if code and spec disagree, fix the code.
 *
 * Two account classes share the `User.account` column, told apart by a grammar-enforced sigil:
 *   - USER : letters + digits + `.` only, case-insensitive, must start with a letter (3–31 chars, dot-rules
 *     enforced by the regex shape). Digits are allowed; the `!` group sigil stays un-spoofable (§2.1).
 *   - GROUP: a leading `!` + an opaque id (the `!` can never appear in a user account, so the sigil is
 *            an un-spoofable discriminator — no separate type flag is needed for correctness; the
 *            `User.isGroup` boolean mirrors it only as a query-time denormalization).
 */

/** User account: starts with a letter, then letters/digits, dot-separated. The `(\.[a-z0-9]+)*` shape
 *  enforces no leading/trailing/consecutive dot. 3–31 chars (VarChar(31) is the hard ceiling). Digits are
 *  allowed; the `!` group sigil remains un-spoofable because `!` is neither a letter nor a digit.
 *  `/i` only matches — case is normalized on write. */
export const USER_ACCOUNT_RE = /^(?=.{3,31}$)[a-z][a-z0-9]*(\.[a-z0-9]+)*$/i;

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
export function isValidGroupAccount(account: string): boolean {
  return GROUP_ACCOUNT_RE.test(account);
}

/** A wire account is well-formed if it matches EITHER grammar (inbound S2S may carry a user or a group). */
export function isValidAccount(account: string): boolean {
  return isValidUserAccount(account) || isValidGroupAccount(account);
}

/** String-context discriminator (when you have the account but not the loaded row). For DB queries prefer
 *  `where: { isGroup: ... }`. Grammar guarantees this agrees with `User.isGroup` (CHECK constraint). */
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
    throw new Error(`mintGroupAccount invariant violated: produced invalid account [${account}]`);
  }
  return account;
}

/** PostgreSQL unique-constraint violation. Kept under the historical name for call-site stability. */
export function isP2002(e: unknown): boolean {
  return isUniqueViolation(e);
}
