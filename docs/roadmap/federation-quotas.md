# SOMS — Unified Daily Quotas (local + federated peers)

> **Status:** **BUILT** (2026-07-12). Live end-to-end: the counter table + atomic increment, ingest-side
> federation enforcement (S2S `requests` / `messages` / `images` / `largeFiles`), handler-side local
> enforcement, the admin **Quotas** page (`/quotas`), and the consumer `QUOTA_EXCEEDED` toast. See
> `src/quota/quota.service.ts`, `src/admin/admin-quota.controller.ts`, `admin-web/src/routes/quota/`.
> **Scope:** Daily per-**node** volume limits + single-media byte caps, applied to **both** the local
> server's own traffic and each federated peer's traffic. Per-node = per-domain (see §1).
> **Last updated:** 2026-07-12.

---

## 1. What a "node" is, and why this is unified

A quota **node** is just a **domain**:

- the **local node** = this server's own `SOMS_DOMAIN` — all local users share **one aggregate** daily
  budget (server-level, not per-user);
- each **federated peer node** = its peer domain — all traffic from that peer shares one bucket.

One counter table `(domain, date, category)` covers both — no special-casing. Peer domains never equal
`SOMS_DOMAIN`, so the buckets never collide.

**Why unified (a scope change from the original peers-only design):** the abuse surface a daily ceiling
protects against is *volume*, regardless of where it originates. A compromised peer flooding inbound S2S
traffic and a flood of local send/upload traffic both need a ceiling, and the mechanism is identical.
Federation traffic is bounded at the **ingest** boundary (§4.1); local traffic is bounded at the
**user-facing handler** (§4.2). Both attribute to a domain.

> **Per-user quotas are deferred** (§7). There is no `userId` column anywhere; the local node is a single
> server-aggregate bucket by design.

---

## 2. Categories and defaults

| Category      | Global default (per node / day) | Single-item byte cap | Counts what |
|---------------|---------------------------------|----------------------|-------------|
| `requests`    | 100                             | —                    | Friend ops: inbound S2S invites (federation) + outbound friend requests (local). Anti-spam. |
| `messages`    | 5,000                           | —                    | Text messages: local sends + federation pull→store. |
| `images`      | 500                             | 50 MB                | Image media: local image uploads + federation image ingest. |
| `largeFiles`  | 50                              | 500 MB               | Video / file / audio media: local uploads + federation ingest. |

Defaults are env-overridable (`src/federation/federation.config.ts` → `loadQuotaConfig`):

```
SOMS_QUOTA_DAILY_REQUEST_LIMIT=100
SOMS_QUOTA_DAILY_MSG_LIMIT=5000
SOMS_QUOTA_DAILY_IMAGE_LIMIT=500
SOMS_QUOTA_DAILY_LARGE_FILE_LIMIT=50
SOMS_QUOTA_MAX_IMAGE_BYTES=52428800        # 50 MB
SOMS_QUOTA_MAX_LARGE_FILE_BYTES=524288000  # 500 MB
```

Every threshold is **per-node, admin-adjustable** from the Quotas page (§6); an unset field means "use the
global default".

**Reset:** the budget resets at **00:00 UTC**. The counter row is keyed by a UTC calendar day, so "reset"
is automatic — yesterday's row is simply not today's; no cron, no `UPDATE … SET count = 0`. (UTC is
deliberate: one deterministic server-wide reset; per-node timezones are overkill.)

**Counting unit:** a media message with *N* photos counts as **N** image units (per media-item), never 1,
so a single album payload cannot bypass the image cap. A text send counts one `messages` unit; a media
message is counted **once** at its upload step (not again at send), so it is never double-counted.

---

## 3. Storage + override resolution

```prisma
model QuotaDailyUsage {
  domain    String   @db.VarChar(63)   // SOMS_DOMAIN (local node) OR a peer domain
  date      DateTime @db.Date          // UTC calendar day (auto-reset at 00:00 UTC)
  category  String   @db.VarChar(15)   // messages | images | largeFiles | requests
  count     Int      @default(0)

  @@id([domain, date, category])
  @@index([date])                      // cheap purge sweep (§7)
}
```

**Per-node overrides.** A node may override any field; `null` means "use the global default". The two node
kinds store overrides differently:

- **Peer node** → nullable columns on `FederatedPeer`:
  `dailyMsgLimit`, `dailyImageLimit`, `dailyLargeFileLimit`, `dailyRequestLimit`, `maxImageBytes`,
  `maxLargeFileBytes`.
- **Local node** → there is no `FederatedPeer` row for our own domain, so the local override set lives in
  the existing `SystemSetting` KV table under key **`quota:local`** (value = JSON of the same 6 fields).
  This follows the established pattern for operator config that has no dedicated table (same as the VAPID
  keypair).

`QuotaService.effectiveLimit` / `effectiveCap` resolve `override ?? globalDefault` uniformly for both.

**Counter store = the DB (atomic upsert), not an in-process `Map`.** An in-process `Map` is non-atomic
and lost on restart — unsuitable for a quota counter that must survive restart and be exact. The DB
table + an atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING count` (see §4) is the right primitive.
(SOMS is single-instance by design; there is no Redis layer.)

---

## 4. Enforcement

### 4.1 Federation path — ingest-side (throws HTTP 429 / 413)

Federation traffic is bounded at the **ingest boundary** — where peer data lands in our DB — which is the
abuse surface we control. The `origin`/peer domain (signer-bound, enforced by `S2sSignatureGuard`) is the
bucket key.

Two operations on `QuotaService`:

- **`peek(domain, category)`** — read-only pre-check; throws `FEDERATION_QUOTA_EXCEEDED` (429) if already
  at/over the limit, **without writing**. Used on the synchronous S2S POST legs (invite /
  invite-accept) so an exhausted peer's *retry* does not burn a dedup slot (peek runs **before** dedup).
- **`tick(domain, category, tx?)`** — authoritative atomic count + check. If the post-increment count
  exceeds the limit, it throws `FEDERATION_QUOTA_EXCEEDED` (429). When `tx` is supplied it runs the
  increment on that transaction, so the throw rolls **both** back (no count burn, no seq gap).

The atomic increment (the codebase's first `$queryRaw`):

```sql
INSERT INTO "QuotaDailyUsage" ("domain", "date", "category", "count")
VALUES ($1, $2, $3, 1)
ON CONFLICT ("domain", "date", "category")
DO UPDATE SET "count" = "QuotaDailyUsage"."count" + 1
RETURNING "count";
-- then: if returned count > limit → throw (the tx aborts → the increment rolls back).
```

**The over-limit increment rolls back → the counter is exact, never ±1 over.** This is an intentional
upgrade from the original design's accepted ±1 slop (an abuse ceiling that drifts was not good enough when
an exact rollback costs nothing — the increment is already inside a transaction).

Call-sites in `src/federation/federation.service.ts`:

| Category     | Where | Detail |
|--------------|-------|--------|
| `requests`   | `handleInvite`, `handleInviteAccept` | Order: `peek` (reject exhausted before dedup) → `isOpSeen` dedup → `tick` on non-duplicate. Replays never burn quota; exhausted rejections never burn a dedup slot. The peek→tick race is benign — `tick` is the authoritative check. |
| `messages`   | `storePulledMessage` | `tick(fetchedFromDomain, 'messages', tx)` on the **same tx** as the `message.create` + seq increment → an over-limit pull rolls the seq back too (no gap). A dup-pull (P2002) returns before the tick, so it never counts. No 429 to the peer (we initiated the pull); the throw is caught and the message is simply not stored. |
| `images` / `largeFiles` | `fetchMediaChunks` (via `localizeMedia`) | After the byte size is known (the first 206 returns `Content-Range` total; the 200-fallback uses `Content-Length`), `assertUnderCap` (413) then `tick` run **before any chunk is yielded** → nothing is written if over cap/limit. `localizeMedia` classifies `IMAGE → images`, else `largeFiles` (MediaAsset stores no mime; classify by message contentType). The fetch path's catch is best-effort — a 413/413 leaves the message inert (no MediaAsset), does **not** block the text pull, does **not** demote the peer. |

### 4.2 Local path — handler-side (returns 200 + `QUOTA_EXCEEDED`)

Local traffic is bounded at the **user-facing handler**, attributed to `SOMS_DOMAIN`. Local endpoints use
the business envelope, so the rejection is **returned**, not thrown:

```ts
return { code: QUOTA_EXCEEDED, message, data: { category, limit, retryAfter } };  // HTTP 200
```

`QuotaService.tryTickLocal(category)` ticks the local aggregate bucket and **returns** the outcome
(`{ count, limit, retryAfter, exceeded }`) instead of throwing — so the caller renders the `200 + code`
response. It is exact by the same rollback trick: the increment runs in a transaction, and if the
post-increment count exceeds the limit, a sentinel aborts the tx so the over-limit increment rolls back
(the bucket stays **at** the limit in storage; `exceeded` still reports the attempt).

| Category | Handler | Note |
|----------|---------|------|
| `messages`  | `MessageController.sendMessage` (`src/controller/message.controller.ts`) | Ticks only for `PURE_TEXT` — media contentTypes are counted at their upload step, so a media message is never double-counted. |
| `images`    | `UploadController.upload` (`src/upload/upload.controller.ts`) | After the magic-byte check. Avatars (`uploadAvatar`) are **exempt** — profile config, not message traffic. |
| `largeFiles`| `UploadController.uploadFile` / `uploadVideo` / `uploadAudio` | Each ticks `largeFiles`. Local uploads already enforce per-item size via the `/upload` pipeline + MediaAsset CAS, so local gets the **count** cap only — the byte-cap (413) is federation-side. |
| `requests`  | `InviteController.sendFriendInvite` (`src/controller/invite.controller.ts`) | After validation. |

Because local is server-aggregate, **every local user's action increments the same `SOMS_DOMAIN` row.**

---

## 5. Errors (and why a quota hit never demotes)

| Path | Condition | HTTP | Code | Body `data` |
|------|-----------|------|------|-------------|
| Federation | daily count exceeded | **429** | `FEDERATION_QUOTA_EXCEEDED` (50011) | `{ category, limit, retryAfter }` |
| Federation | single-item byte cap | **413** | `FEDERATION_PAYLOAD_TOO_LARGE` (50012) | `{ category, limit: cap, received }` |
| Local | daily count exceeded | **200** | `QUOTA_EXCEEDED` (10008) | `{ category, limit, retryAfter }` |

- `retryAfter` = seconds to the next 00:00 UTC (so an operator/UI can show "resets in 7h").
- A daily hit is **transient** (resets at midnight); a byte-cap refusal is **permanent for that item** (no
  retry).
- **A quota hit never demotes or blocks a peer.** This required a pre-existing bug fix in
  `sendSignedPost`: it previously demoted on *any* non-2xx, so a peer's symmetric 429/413 refusal of our
  outbound POST would have wrongly demoted them. It now demotes only on `401 | 403 | >= 500` (mirroring the
  already-safe `getSigned`); `429 | 413 | 400 | 404 | 410` throw `S2sResponseError` **without** demoting.
- A quota hit is **distinct from `blocked`** (an admin intent that persists until unblocked). See
  `docs/overview/federation-protocol.md` §trust-lifecycle and the `FederatedPeerEvent` audit log.

---

## 6. Admin surface

**Backend** — `src/admin/admin-quota.controller.ts` (`@Public()` opts out of the global JwtAuthGuard so its
own `AdminAuthGuard` runs; writes are `SUPER_ADMIN` only, mirroring the federation block/unblock gate):

- `POST admin/quota/nodes` → `QuotaService.listNodes()`: every node (the local node first, then each
  federated peer) with `isLocal`, `trustLevel`, the 6 override fields, and today's `{count, limit}` per
  category. Three queries total regardless of peer count (peers, a batched usage fetch, the local KV) — no
  N+1.
- `POST admin/quota/nodes/:domain` → `QuotaService.setLimits(domain, dto)`: routes local→`SystemSetting`
  KV, peer→`FederatedPeer` columns. DTO `AdminSetQuotaDto` = 6 `@IsOptional @IsInt @Min(0)` fields. An
  unknown peer throws Prisma P2025 → the controller surfaces `200 + NOT_FOUND` (the local node is always
  settable). Audited via `@Audit('quota.node.setLimits')`.

**Frontend** — a dedicated **Quotas** page (`admin-web/src/routes/quota/quota-page.tsx`, nav key
`quotas`): a table of all nodes (the local node pinned/badged at top + every peer), each row showing
today's usage per category (`count / limit`) + inline-editable thresholds wired to
`useSetQuotaNodeLimits`. Super-admin-only.

**Consumer** — the local quota rejection flows through the existing error-display path on code `10008`
(`web/src/app/services/biz-code.ts` → `errors.biz.quotaExceeded`); no structural client change.

---

## 7. Deferred / out of scope

- **Per-user quotas** — explicitly deferred ("deferred — user-level quotas are a later phase"). The schema has no `userId` column;
  adding per-user later means widening the counter key + a new enforcement dimension. The local node is a
  single server-aggregate budget by design.
- **Serving-side request-rate throttle on `/s2s/*`** — a peer hammering GET endpoints with bogus queries
  drains CPU/DB *without ingesting anything* (so it never trips a category-volume quota). That needs a
  *request-rate* mechanism (like the existing `ThrottleGuard`, keyed by signer domain) — distinct from the
  category-volume quotas here. Documented as follow-up hardening.
- **Old-row purge** of `QuotaDailyUsage` (`DELETE WHERE date < today - 30`) — optional housekeeping; the
  `@@index([date])` is already in place for it.
- **Per-(peer,user) sub-limits** — one rogue user on a peer could exhaust that peer's shared budget → mild
  DoS. Accepted (the peer's own admin polices their users); the admin-adjustable threshold is the relief
  valve. Do not add unless abuse is observed.

---

## 8. Relationship to existing limits

- **Local uploads** (`/upload` pipeline + `MediaAsset` CAS) keep their own size handling (body limit,
  `sharp` for avatars, magic-byte family check). The local quota is the daily **count** cap on top of that
  — a distinct dimension; it does not replace per-item size enforcement.
- **Login rate limiting** (`local.strategy.ts`, in-process sliding window keyed by IP/account) is the
  *burst* throttle for auth; `QUOTA_EXCEEDED` (10008) is the *daily volume* ceiling. Different mechanisms,
  different code (`RATE_LIMITED` 10005 vs `QUOTA_EXCEEDED` 10008).
- **Trust lifecycle** (`trusted / demoted / blocked`) is orthogonal. A quota hit does not demote or block;
  a block does not depend on quota.
