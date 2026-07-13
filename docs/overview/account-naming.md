# Account Naming Specification

> **Single source of truth** for the `account` field's grammar on SOMS. Every code site that
> **creates, validates, stores, or splits** an account string MUST conform to this document:
>
> - `RegisterDto` — local user registration
> - Group-creation flow — group account minting
> - Federation inbound validation — `requireS2SAddress` / `requireAddress`
> - Federation address split — `account@domain`
>
> If this spec and the code disagree, **this spec is authoritative**. Code comments at each site
> link back here rather than restating the rules.

## 1. Mental model: `account` = the email local-part

In a SOMS address `account@domain`, `account` corresponds to the **email local-part** (everything
left of `@`) and `domain` to the email domain. SOMS borrows email's `account@domain` shape but uses
an intentionally **small, URL-safe charset subset** — because an account is not only a login handle.
It is simultaneously:

- a **URL path parameter** (`GET /api/v1/s2s/users/:account`), and
- a **federation wire field** (carried in JSON bodies, signed by RFC 9421).

Email's full RFC 5321 `atext` set includes characters that are **fatal** in those roles
(`/` path-sep, `?` query, `#` fragment, `%` pct-encoding, `@` separator), so they are excluded.

## 2. Two account classes — distinguished by grammar, not convention

SOMS stores two kinds of accounts in the **same** `User.account` column. They are told apart by the
**first character (sigil)**, enforced by **mutually-exclusive regular expressions**:

| Class | Sigil | Example | Who may mint it |
| --- | --- | --- | --- |
| **User** | none — must start with a letter | `alice`, `john.smith`, `h2user` | the registration endpoint (`RegisterDto`) |
| **Group** | `!` | `!01hzxw7x...` | the group-creation flow only |

### 2.1 Why a grammar-enforced sigil (a security property)

A **user account may contain only letters, digits, and `.`** (§3.1) — never `!` — so the sigil `!` can
**never appear in a user account**. The grammar therefore makes user/group discrimination
**un-spoofable**: nobody can register `!admin` as a username to impersonate a group — the registration
regex rejects it. (Digits are allowed; this does not weaken the sigil, since `!` is neither a letter
nor a digit.) Type
discrimination is a property of the string itself, not a separate `type` flag or a code-path
convention that could be bypassed.

### 2.2 Why `!` (and why not `#`)

Surveyed the established chat sigil conventions:

- **Matrix** (spec appendices / MSC2312): `@` user, `#` room **alias** (human-readable),
  `!` room **ID** (opaque, canonical), `$` event.
- **IRC** (RFC 2811 §4): `#` standard channel (primary), `&` server-local, `+` modeless,
  `!` safe channel.

The most *recognizable* "group" symbol is `#` — but `#` is the URL **fragment delimiter**, so it can
never survive as a raw path parameter (`GET /users/#x` truncates at `#`). Matrix itself treats `#` as
the **alias** role, not the identity role. The canonical, URL-safe, email-legal sigil for an **opaque
room/group identity** is `!` — exactly Matrix's room-ID choice — so SOMS uses `!` for the canonical
group identity token.

**`#` is reserved** for a possible future human-readable **alias layer** (resolved out-of-path, never
a stored account sigil), matching Matrix's two-layer `!`-ID / `#`-alias split. It MUST NOT be used as
a stored account sigil today.

## 3. Grammar

### 3.1 User account

```
user_account := [a-zA-Z][a-zA-Z0-9]* ( "." [a-zA-Z0-9]+ )*     with length 3–31
```

Regex (**validate**, then **normalize** — see §4):

```regex
/^(?=.{3,31}$)[a-z][a-z0-9]*(\.[a-z0-9]+)*$/i
```

- **Charset:** ASCII letters and digits `[A-Za-z0-9]` and `.`. **Must start with a letter**; **no
  underscore, no other symbols.** Digits are allowed elsewhere — the `!` group sigil stays un-spoofable
  because `!` is neither a letter nor a digit (§2.1).
- **Dot rules:** no leading `.`, no trailing `.`, no consecutive `..`. The `(\.[a-z0-9]+)*` structure
  enforces this — `.` is only ever a single separator between alphanumeric runs.
- **Length:** 3–31 characters. The DB column is `VarChar(31)` (`prisma/schema.prisma`); 31 is the
  hard ceiling.
- **Semantics of `.`:** **significant, not collapsed.** `alice` ≠ `alice.bob` ≠ `alicebob` are three
  distinct accounts. This is NOT Gmail-style dot-ignoring.

### 3.2 Group account

```
group_account := "!" opaque_id
```

Regex:

```regex
/^![a-z0-9]{2,30}$/        // already lowercase; total length 3–31
```

- **Sigil:** a single leading `!`.
- **Body:** a server-generated **opaque** identifier over `[a-z0-9]`, **2–30 chars** (so `!` + body
  ≤ 31, the column ceiling). The RECOMMENDED body is a 26-char Crockford-base32 **ULID**
  (`!01hz...`) — case-insensitive by design, safe to store lowercase, and collision-free without a
  name-squatting / rename-resolution dance (the same reason Matrix room IDs are opaque).
- **Minting authority:** the group-creation flow ONLY. The registration endpoint rejects
  `!`-prefixed strings automatically, because `!` is neither a letter nor a digit (§3.1).
- Human-readable group names live on `Group.name` (Unicode allowed) and/or a future `#`-alias —
  **never** on the identity account.

### 3.3 Group-id collision handling — regenerate, do NOT retreat

A ULID body is collision-free by construction (80-bit random; ~2^40 same-millisecond draws for a
50% collision). **Therefore there is no digit-style backoff/retreat algorithm** — that pattern is for
deterministic names that collide by construction (sequential counters, human-picked names), the
opposite of an opaque random id. (The codebase already applied the same principle to files: uploads
are content-addressed by sha256 CAS, not by a collision-retreat filename — `sanitizeName` only
cleans names, it never appends an incrementing suffix.)

The `@@unique([account, domain])` index makes a Prisma `P2002` *theoretically* possible, so the
minting path uses a **bounded regenerate-and-retry** loop as a correctness safety net — NOT a suffix
retreat:

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  const account = '!' + mintUlid();           // fresh random draw each attempt
  try { return await createGroupUser(account, /* … */); }
  catch (e) { if (!isP2002(e)) throw e; }      // regenerate, never append a counter
}
throw new Error('ULID collision after 3 attempts (probabilistically impossible)');
```

The random source MUST be a **CSPRNG** (`crypto.getRandomValues`), not `Math.random` — for the full
80-bit collision resistance and consistency with the project's `lib/uuid` stance (see
`crypto-randomuuid-secure-context`).

## 4. Case handling (REQUIRED, not optional)

SOMS accounts are **case-insensitive**: `Alice`, `alice`, `ALICE` denote the same account.

**The regex `/i` flag does NOT achieve this.** Postgres' default `@@unique([account, domain])` index
is **case-sensitive**, so two writes `Alice` and `alice` would otherwise create two rows. Therefore:

- **Normalize on write:** every code path that stores an account MUST `toLowerCase()` before
  insert/upsert. The DB stores the canonical lowercase form.
- **Normalize on lookup:** reads by account SHOULD match the lowercased input (defensive; the writers
  are the real gate).
- This applies to **both** `account` and the paired `domain` (DNS/email domains are case-insensitive
  too).

(Alternative: a case-insensitive collation / `CITEXT` column. Normalize-on-write is chosen because it
is collation-independent, explicit, and survives across DB engines and backups.)

## 5. Reserved characters (never in an account)

| Char | Reason |
| --- | --- |
| `@` | The address separator (`account@domain`). The client splits on `@`; an `@` inside `account` would make the split ambiguous. (Email allows `@` only inside quoted-strings; SOMS forbids quoted-strings entirely.) |
| `/ ? #` | URL-hostile: path separator / query / fragment. `#` is additionally the future alias sigil (§2.2). |
| `%` | URL percent-encoding prefix; a bare `%` is an invalid URL. |
| `_` `^` `` ` `` `{` `\|` `}` `~` and everything else | Outside the v1 URL-safe subset; not needed. |

## 6. Address form

```
address := { account, domain }              // on the wire: two fields — NEVER an @-joined string
display := account + "@" + domain           // UI input aid only; client splits before any API call
```

- A group address on the wire is `{ account: "!01hz...", domain: "soms.io" }`.
- Because `@` is forbidden in `account` (§5), splitting `account@domain` on `@` is always unambiguous
  for both users and groups.

## 7. Identity immutability — an account is never renamed

An account is **set exactly once, at creation**, and is **never mutated afterward** — not by the user,
not by an admin, not by any internal path. There is no rename / change-account operation in SOMS.

- **Users:** the `account` is fixed at registration (`RegisterDto` → `addUser`). The self-service
  profile endpoint (`updateProfile`) updates only the display `name` and `bio` — **never** `account`.
- **Groups:** the `!`-sigil account is minted once by the group-creation flow (§3.2 / §3.3) and is fixed
  for the group's lifetime. (A group's human-readable `Group.name` MAY change; its identity account
  MAY NOT — the un-spoofable sigil, §2.1.)
- **Federated stubs:** a remote `User` stub's `account` is copied from the peer's profile at resolve
  time and is likewise immutable — a peer cannot retcon a stub's account after the fact.

**Why immutability is load-bearing (a federation identity property).** The `account` is the identity
token in the wire address `{ account, domain }` (`federation-protocol.md` §3.1). It is referenced by
friendships, thread membership, messages (`creator`), signed S2S payloads (`from` / `to`), and —
crucially — by the **remote `User` stubs every peer server stores**, keyed conceptually on
`{ account, domain }`. If `alice` could rename to `alice2`:

1. every peer's stub for `alice@<domain>` would orphan — a `resolve` / friend-op / message-pull for the
   old account would 404, silently severing the relationship; and
2. the old `account` slot would free up, so a **different person could re-register `alice`** and inherit
   every still-cached remote stub — a silent impersonation of the original user.

Renaming is therefore **forbidden at the identity layer, not merely unimplemented**. This pairs with the
deferred **identity-portability** non-goal (`federation-protocol.md` §10: `user@domain` is bound to its
server — the `domain` half is equally immutable) to make the **entire federated address immutable**: a
user is `{ account, domain }` for life, on both halves. (§4 case-normalization is a write-time transform
applied once at creation, not a later mutation.)

## 8. Data reset — no migration

The v0.1 registration regex was `^[a-zA-Z][a-zA-Z0-9_]{2,30}$` (letters + digits + underscore). The
grammar was later tightened to **letters + `.` only** (no digits, no underscore), shipped over a full
table reset (drop/recreate — no migration, no legacy handles preserved). **Digits have since been
re-allowed** (§3.1): the grammar is now letters + digits + `.`, must start with a letter. The `!` group
sigil stays un-spoofable (`!` is neither a letter nor a digit). Underscode remains excluded; re-adding
it would be a separate review of this document. No migration was needed for the digit change — the DB
CHECK constraint only enforces the `!`/`isGroup` consistency, not the user charset.

## 9. Related / supersedes

- Supersedes the `thr_<rand>@<origin-domain>` **federated thread-id** form for groups described in
  `docs/roadmap/federation-step3-design.md`. Canonical group identity is now the `!`-sigil account (§3.2);
  when federated groups are built, align Step 3's thread identity to this scheme rather than keeping
  two conventions.
- Cross-referenced from `docs/overview/federation-protocol.md` §3.1 (federated identifiers).
