# SOMS Federation — Per-Peer Quotas (design notes, NOT YET BUILT)

> **Status:** Design notes only. **Deferred** until the real federation communication protocol
> (Step 2 — cross-server messages / images / files) is designed. Captured here so the decisions are
> not lost and can be picked up unchanged when that work begins.
> **Scope:** Daily per-peer limits and single-media size caps on federated (auto-handshaked) traffic.
> **Last updated:** 2026-07-08

---

## 1. Why this is deferred

The limit categories below (**messages / images / videos / large-files**) are all **Step 2** traffic.
Step 1 (what ships today) only federates `friend.*` envelopes — control traffic, low volume, no media.
So as of today there is **nothing in those categories to count**. Building idle enforcement now would
ship a half-feature (admin sets thresholds that gate zero traffic). The honest sequencing is:

1. **First** — design the real federation protocol (Step 2: how a message/image/file actually crosses
   servers — sync inline vs. outbox+worker vs. blob-reference). That choice *determines* several
   decisions in §5 (notably large-file transport — see §5.1).
2. **Then** — land this quota model as part of, or right after, Step 2, so there is real traffic to
   enforce against.

The schema and enforcement shape below are stable regardless of that choice and can be lifted
verbatim when the time comes.

---

## 2. Requirement (as requested)

For each auto-handshaked peer server, enforce per-day limits that reset at **0:00**:

| Category            | Daily limit | Single-item size cap |
|---------------------|------------|----------------------|
| Messages            | 5,000      | —                    |
| Images              | 500        | 50 MB                |
| Videos + large files | 50         | 500 MB               |

- Thresholds are **per-peer, admin-adjustable** from the admin console.
- Exceeding a threshold → the receiving S2S endpoint returns an appropriate error.
- Applies to **auto-handshaked** servers (i.e. federated peers), not local traffic.

---

## 3. Design

### 3.1 Storage — date-keyed counters (reset = automatic)

Counters are keyed by `(domain, date)`, where `date` is the calendar day (YYYY-MM-DD). "Reset at
0:00" is therefore **automatic** — yesterday's row is simply not today's; no cron, no `UPDATE … SET
count = 0`. Old rows are tiny and periodically purged (`DELETE WHERE date < today - N`).

```prisma
model FederatedPeerDailyUsage {
  domain    String   @db.VarChar(63)
  date      DateTime @db.Date                       // calendar day; UTC (see §5.2)
  category  String   @db.VarChar(15)                // messages | images | largeFiles
  count     Int      @default(0)

  @@id([domain, date, category])
  @@index([date])                                   // cheap purge sweep
}
```

### 3.2 Per-peer threshold overrides (admin-adjustable)

Global defaults live in `federation.config.ts` (env-overridable): `5000 / 500 / 50 / 50 MB / 500 MB`.
A peer may **override** any of them; `null` means "use the global default".

```prisma
// added to FederatedPeer (all nullable)
dailyMsgLimit        Int?
dailyImageLimit      Int?
dailyLargeFileLimit  Int?
maxImageBytes        Int?     // default 50 MB
maxLargeFileBytes    Int?     // default 500 MB
```

### 3.3 Enforcement point — inbound inbox

Quotas gate **inbound** traffic (what this server *receives from* the peer — the abuse surface), at the
S2S inbox, in this order:

1. **Dedup first** (`S2SInboxSeen`). A replayed/duplicated envelope must **not** burn quota.
2. **Atomic count + check.** Increment and compare in one statement to close the check-then-increment
   race (two concurrent envelopes from the same peer would otherwise both pass):
   ```sql
   INSERT INTO "FederatedPeerDailyUsage" (domain,date,category,count) VALUES ($1,$2,$3,1)
   ON CONFLICT (domain,date,category) DO UPDATE SET count = "FederatedPeerDailyUsage".count + 1
   RETURNING count;
   -- then: if returned count > limit → reject (and conceptually "un-count", or just accept ±1 over).
   ```
   Pragmatic note: an over-limit op may consume one increment beyond the cap. That is acceptable —
   the cap is an abuse ceiling, not a billing boundary. If exactness is wanted, wrap the increment
   in a tx and roll back on over-limit.
3. **Size cap at ingest.** Reject an oversized item **before** storing it (do not write 600 MB then
   refuse). For media delivered by reference (§5.1), check the declared byte size in the envelope.

### 3.4 Errors

New `FEDERATION_*` business codes (continue the `5001x` block; `FEDERATION_PEER_BLOCKED` is `50009`):

- Count exceeded → HTTP **429** + `FEDERATION_QUOTA_EXCEEDED`, body carries `{category, limit,
  retryAfter}` where `retryAfter` = seconds to the next 0:00 (so the sender's operator/UI can show
  "resets in 7h"). Transient — resets at midnight; **not** a block.
- Oversized item → HTTP **413** + `FEDERATION_PAYLOAD_TOO_LARGE`, body carries `{category, limit,
  received}`. Permanent for that item — no retry.

These are **distinct from `blocked`** (an admin intent that persists until unblocked). A quota hit
is a transient throttle; it never demotes or blocks the peer.

### 3.5 Admin UI

Extend the existing Federation admin page's peer detail dialog with a **Quotas** panel:
- **Today's usage** per category, live (`count / limit`, e.g. `1,204 / 5,000`), with the date shown.
- **Editable thresholds** per peer (override or "use default"); save calls a new admin endpoint that
  writes the nullable override columns.
- A "reset window" hint showing time-to-midnight for the operator's convenience.

---

## 4. Recommended sequencing (when picked up)

1. Add the schema (override columns + `FederatedPeerDailyUsage`) + migration + admin UI for
   thresholds — these are stable and give the admin a place to record the agreed limits per peer.
2. Wire the **one** live counter today's traffic actually produces: inbound `friend.request` per peer
   per day (see §5.6) — real enforcement + observability from day one.
3. Add the message / image / file categories + size caps **as part of Step 2**, once the message/media
   transport design is settled.

---

## 5. Decisions to make before implementing (the gaps)

These are the questions surfaced during design. Each has a recommendation; confirm before building.

### 5.1 🔴 Large files cannot flow through sync federation
A **500 MB** video over a **10 s-timeout** inline S2S POST is fundamentally broken: it times out, and
buffering 500 MB in a `fetch` body is wasteful. Inline sync is fine for *small* media; **large files
need a different transport**: the sender hosts the blob and the envelope carries a **reference URL**
(the receiver fetches it separately, with no 10 s cap and with resume).
So the 500 MB limit really implies **blob-reference federation**, not a bigger POST body. This is the
single biggest architectural dependency on the Step 2 protocol design.

### 5.2 "0:00" in whose timezone?
Must be explicit. **Recommend UTC** (deterministic, one server-wide reset). Per-peer TZ is overkill.
The `date` key makes whatever you pick trivial — it just sets how `date` is computed.

### 5.3 Per-peer-domain aggregate budget
The quota is per *peer domain* (all inbound from that domain shares one bucket), **not** per recipient
user. Consequence: one rogue user on the peer could exhaust the daily budget for everyone on that peer
→ mild DoS. **Recommendation:** accept it (the peer's own admin polices their users); do not add
per-(peer,user) sub-limits unless abuse is observed. The admin-adjustable threshold is the relief valve.

### 5.4 Counting unit for albums
An image-message with N photos — count as **1** or **N** toward the image cap? **Recommend per
media-item (N)**, else a single album envelope bypasses the image cap.

### 5.5 50 MB single-image is very generous
A real image is rarely > 10 MB; 50 MB images are almost always pixel-bombs (which `sharp` already
rejects downstream). **Recommend ~20 MB**, but 50 MB is the operator's call — flagged as loose.

### 5.6 Control traffic (`friend.*`)
Not in the requested categories, but worth a **separate small daily "requests" limit** (e.g. 50–100
per peer) — genuine anti-spam, and it is the *one quota enforceable against today's traffic*. Worth
building even before Step 2.

### 5.7 Outbound quotas
**Recommend: none.** You trust your own users; the abuse surface is inbound. (If a symmetric cap is
ever wanted, the same table model extends trivially with a `direction` column.)

### 5.8 Old usage rows
Tiny, but a periodic purge (`DELETE WHERE date < today - 30`) keeps the table flat. Optional index on
`date` already in §3.1.

---

## 6. Relationship to existing limits

- **Local uploads** (the `/upload` pipeline + `MediaAsset` CAS) already have their own size handling
  (body limit, `sharp` for avatars, magic-byte family check). These federation size caps are
  *additional*, applied at the S2S inbox for inbound media — distinct from the local-upload path.
- **Trust lifecycle** (`trusted / demoted / blocked`) is orthogonal. A quota hit does **not** demote or
  block; a block does **not** depend on quota. See `docs/federation-protocol.md` §trust-lifecycle and
  the `FederatedPeerEvent` audit log.
