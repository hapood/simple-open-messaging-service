# SOMS Federation — Step 2 Design (cross-server 1:1 messages + chat media)

> **Status:** DESIGN (decided 2026-07-08; coalesced in-memory hint map + self-healing reconnect sweep,
> same day), **implemented + e2e-verified** in the working tree (2026-07-08). All §8 items 1–11 are live:
> schema + `originSeq`, the outbound hint buffer, both `/new-msg-map` routes, the `/messages` pull, the
> inbound drainer, `/get_file` + receiver media-localize, `/ping`, the 60 s reconnect sweep, and
> pull-on-thread-open + slow poll. The federation e2e is **16/16 green** (4 new Step 2 scenarios: text
> push+pull+SSE, idempotent re-sync, pull-on-open recovery, media round-trip — alongside the 12 Step 1 /
> profile tests, no regressions). The resilience story is live: a lost push recovers via the sweep +
> pull-on-open + slow poll. **Deferred** (§9): read receipts/presence/typing,
> history backfill as a feature (Step 2.5), and a durable outbox (only if a future tier
> needs transactional delivery). Per-peer quotas are now **BUILT** (unified local + peers — see
> `docs/roadmap/federation-quotas.md`). Delete propagation is a **non-goal** (§9, not deferred); federated groups shipped
> in Step 3. This is
> the authoritative Step 2 design; it **supersedes** the outbox-push/backfill prose retained in
> `docs/overview/federation-protocol.md` §6.2 / §8 / §9.2 (kept there as rejected-alternative rationale).
> **Scope:** cross-server **1:1 text + media**. **Out of scope:** delete propagation (**non-goal**
> — the origin cannot mutate receiver-local data once delivered; §9), presence/typing (v0.2,
> best-effort/ephemeral), read receipts (v0.2, a separate deferred item — §10), federated **groups** + shared
> thread id (Step 3, built), history backfill as a distinct feature (Step 2.5 — same endpoint as
> incremental pull).

---

## 1. The model in one paragraph

**Coalesced-notify + active-pull, with a self-healing reconnect layer.** A message is stored locally
first (immediate, visible to the sender); a **coalesced in-memory hint map** (`domain_new_msg_map`,
one entry per `(from,to)` conversation holding the sender's latest `originSeq`) is marked dirty and
**flushed to the peer** (best-effort, debounced ~500 ms so a burst becomes one push). The peer
**pulls** the sender's new messages by cursor when it is behind. The sender's `Message` table is the
single source of truth — the hint map is only a latency optimizer, the pull is authoritative, so a
lost or overflowed hint is caught by **pull-on-thread-open** and a **slow periodic poll**. There is
**no persistent outbox, no worker, no dead-letter queue** — the map is volatile (survives a network
outage, not a process restart; pull-on-open is the restart floor), deletion shows up as gaps in the
sequence (absorbed naturally), and delete propagation is a **non-goal** (the origin cannot mutate
receiver-local data; §9) — a local delete stays local. A
**60 s reconnect sweep** plus a dedicated **signed ping** re-handshake demoted peers and **never get
permanently stuck on a cert/key rotation** (every tick re-fetches `.well-known` fresh; we never pin).
Media rides the same trust/friendship chain via a digest-keyed `get_file` (content-addressed → dedup

- integrity + idempotent retry), with **no capability token** — the 3-check authorization chain is
  sufficient because sha256 digests are unguessable.

**Why not outbox-push (the rejected alternative).** An outbox + retry worker is the "durable channel"
ActivityPub/Matrix reach for, but it is the single biggest complexity amplifier (a persistent queue,
single-worker-per-`(thread,domain)` ordering, a dead-letter store, retry/backoff). The pull model
trades a little latency (peer flushes/pulls/opens the thread) for the elimination of all of that: the
message table already exists on both sides, idempotent dedup already exists (`S2SFriendOpSeen` + the new
`originSeq` unique index), and a peer that's down simply isn't flushed until the 60 s sweep brings it
back. The cost — a message is not _guaranteed_ delivered until the peer next flushes/opens/polls — is
acceptable for a human-timescale, low-stakes 1:1 channel, and is exactly the email model SOMS already
mirrors. Reliable _transactional_ delivery (if ever needed for a paid/hosted tier) revives the outbox
**on top of** this design, not instead of it.

---

## 2. Data model

### 2.1 `Message.originSeq` — the cross-server-stable per-(thread, sender) counter

```prisma
model Message {
  // ...existing columns...
  originSeq Int?   // per-(threadId, creator) monotonic seq; the cross-server pull cursor.
                   //   SENDER side: allocated on insert (MAX(originSeq)+1 in the write tx).
                   //   RECEIVER side: copied verbatim from the pulled message (idempotent dedup key).
                   // Nullable: legacy rows (pre-Step-2) and messages in threads that never federate
                   //   stay NULL; Postgres treats NULLs as distinct under the unique index below, so
                   //   they coexist with no backfill. New inserts ALWAYS assign a seq.
  @@unique([threadId, creator, originSeq])   // (a) sender allocation correctness AND (b) receiver dedup
  @@index([threadId, creator, originSeq])    // the pull query + the MAX(cursor) derivation
}
```

**Why one column on both sides (not a separate receiver cursor table).** The receiver's "how far am I"
is derived from the data it already stores: `cursor = MAX(originSeq) WHERE threadId = T AND creator =
<sender-stub-id>`. A dedicated `FederatedMessageCursor` table would be a redundant, drift-prone copy
of a fact already in the message table. The `MAX` is one indexed query (the `[threadId, creator,
originSeq]` index serves both the pull `WHERE originSeq > $after` and the `MAX`). This is the
"derive state from data" pattern — it cannot drift.

**Why `originSeq` and not the sender's `Message.id`.** `Message.id` is per-_server_ auto-increment.
When `alice@aaa` sends, `aaa` assigns its local `id`; when `bbb` pulls and stores alice's message,
`bbb` assigns its OWN new `id` for its copy. The receiver therefore cannot use the sender's `id` as a
stable cursor — `originSeq` is the sender-side value that crosses the wire unchanged and is stored
identically on both sides. Within each server, local read-ordering continues to use `Message.id`
(unchanged) — `originSeq` is solely the federation cursor.

**Allocation (sender side).** Inside the existing `writeMsgToThread` transaction:

```ts
const last = await tx.message.aggregate({
  where: { threadId, creator: userId },
  _max: { originSeq: true },
});
const nextSeq = (last._max.originSeq ?? -1) + 1; // 0-indexed: empty (thread, sender) → first send = seq 0
const msg = await tx.message.create({ data: { /* ...existing... */, originSeq: nextSeq } });
```

`originSeq` is **0-indexed** (first message in a (thread, sender) = seq 0; `-1` = empty / before seq 0),
int32 (≤ 2³¹−1 ≪ 2⁵³ → JSON number, never a string). The forward cursor is `afterSeq` (`seq > afterSeq`,
default `-1` = from seq 0); the backward twin `/messages/before` uses `beforeSeq` (`seq < beforeSeq`,
default `-1` = from latest) — reserved for external federation implementations (SOMS is forward-only).
The `@@unique([threadId, creator, originSeq])` catches the rare same-user concurrent-insert race (two
devices sending at once) as a unique-constraint conflict → the caller retries the transaction (the existing
`clientMessageId` pre-check already absorbs the common retried-send case; this handles the
genuinely-concurrent case). Different users in the same thread never contend (different `creator`).

### 2.2 No new persisted cursor / outbox / federated-thread-id tables

- **No `FederatedMessageCursor`** — derived from `MAX(originSeq)` (§2.1).
- **No `S2SOutbox`** — coalesced in-memory hint map (§2.3), sync flush (best-effort).
- **No shared federated thread id** — each server still owns its own local P2P `MessageThread`
  (unchanged from Step 1). The pull identifies the conversation by the **address pair**
  (`fromAccount`/`toAccount` → `Friendship` → local thread), never by a cross-server thread id. That
  returns only for federated **groups** (Step 3).

### 2.3 In-memory delivery buffers (volatile — no migration, no persistence)

These are **runtime state**, not database tables. They optimize notify delivery across transient
outages; they are NOT a source of truth (the `Message` table is) and they do NOT survive a process
restart (§4.4 — pull-on-open is the restart floor).

**Outbound — `domainNewMsgMap` (the structure the user named).** One entry per `(fromUser → toUser)`
conversation that has new messages the peer doesn't yet know about:

```
Map<peerDomain, Map<"<fromUser>→<toUser>", { latestSeq: number, generatedAt: number }>>
```

- **Latest-seq-wins:** a new message in an existing conversation overwrites `latestSeq` (the peer
  pulls by cursor, so only the highest seq matters). The map is therefore bounded by **active
  conversation count**, not message count — it cannot grow unbounded during a long outage.
- **Marked dirty on send** (§4.1); **flushed** debounced (~500 ms, so a burst coalesces to one push)
  in the steady state, and **drained in batches on reconnect** (§4.3) when the peer was down.
- **Cap:** 10 000 entries per domain (configurable). On overflow, **evict the older half by
  `generatedAt` in one shot** (not one-by-one — avoids thrashing at the boundary). Evicted
  conversations fall back to the poll floor (§4.4). In practice the cap is never approached.
- **Deletion:** an entry is removed only on **successful push ack** (the peer acknowledged
  awareness). A pull of our map by the peer is a **non-destructive peek** — we do not delete on pull
  (idempotency makes a stale re-peek harmless; a newer `latestSeq` overwrites it; bounded by
  conversation count so it never grows).

**Inbound — `pendingPulls` (the receiver's work queue).** Conversations WE need to pull from a peer:

```
Map<"<fromUser>@<peerDomain>→<toLocalUser>", latestSeq: number>
```

Populated by **(a)** receiving a `new-msg-map` push, or **(b)** pulling the peer's outbound map
(§4.3, one-directional fallback). **Drained** by a successful message-pull (`cursor ≥ latestSeq` →
remove). Duplicates across push/pull are absorbed by the `originSeq` unique index (idempotent) — the
user's "push/pull duplication is harmless" invariant.

---

## 3. Endpoints

All five sit under `S2sSignatureGuard` (signed + `trustLevel === 'trusted'`). The guard's binding
check (`from.domain === signer.domain` for bodies that carry `from`) is skipped for GETs (no
`req.body`); for GETs the requester **is** the signing server, so `signer.domain` is the requester
identity directly. Every body that carries `origin` validates `origin === signer.domain` (§3.1).

| Method | Path                                          | Purpose                                                              |
| ------ | --------------------------------------------- | -------------------------------------------------------------------- |
| `POST` | `/api/v1/s2s/new-msg-map`                     | push a batch of OUR outbound hint entries to the peer                |
| `GET`  | `/api/v1/s2s/new-msg-map?take=&cursor=`       | pull the PEER's outbound hint entries (one-directional fallback)     |
| `GET`  | `/api/v1/s2s/messages?from=&to=&after=&take=` | pull the **sender's** messages after a cursor (authoritative)        |
| `GET`  | `/api/v1/s2s/get_file?digest=&from=&to=`      | stream a chat-media asset by sha256 digest                           |
| `GET`  | `/api/v1/s2s/ping`                            | signed liveness probe (reconnect sweep + quiet-peer `lastSuccessAt`) |

> Friend ops keep their own dedicated endpoints (`POST /api/v1/s2s/friend-request` / `friend-approve`),
> unchanged from Step 1. Message delivery uses the two `new-msg-map` routes above — not the friend-op
> endpoints.

Identity on every route is the split `{account, domain}` pair — **no `@`-joined string** (the `@`
is a UI input aid only, per `federation-protocol.md` §3.1).

### 3.1 `new-msg-map` (the coalesced hint: push + pull)

Replaces the per-message `message.notify`. N messages to one peer in a debounce window → **one** push
carrying the dirty entries; a transient outage → entries **buffer in memory** and flush on reconnect.

**Push (ours → peer):**

```json
POST /api/v1/s2s/new-msg-map
{
  "origin": "aaa.com",
  "entries": [
    { "from": "alice", "to": "bob",   "latestSeq": 12345 },
    { "from": "carol", "to": "dave",  "latestSeq": 99 }
  ],
  "hasMore": false,
  "generatedAt": 1719500000000
}
→ 200 { "ok": true }
```

- `origin` (REQUIRED) — our domain, **binding-checked `=== signer.domain`** (missing/mismatch →
  `401`). It is carried explicitly (not just implied by the signature) so a malformed/spoofed body is
  rejected outright; the signer domain remains the authoritative fallback.
- `from` / `to` — **accounts only** (domains implicit: `from` is one of OUR local users, `to` is one
  of the recipient server's users). Lean wire.
- `hasMore` — more batches follow this flush (peer may throttle; the sender deletes each acked batch
  then sends the next).
- On `200` → **delete the pushed entries** from `domainNewMsgMap[peerDomain]`. On failure → keep them
  (the 60 s sweep retries — §4.3).

**Pull (peer's map → ours, one-directional fallback):**

```http
GET /api/v1/s2s/new-msg-map?take=1000&cursor=<opaque>
→ 200 {
  "entries": [ { "from": "carol", "to": "dave", "latestSeq": 99 }, ... ],
  "cursor": "<next-or-null>",
  "hasMore": true
}
```

- The peer serves entries where the recipient is one of OUR users (its outbound map for our domain).
- **Non-destructive peek** — the peer does NOT delete on pull (it deletes only on its own successful
  push-ack). Idempotency + latest-seq-wins makes a stale re-peek harmless and bounded.
- Loop while `hasMore` (each batch ≤ `take`). Because message-pull is idempotent, push/pull overlap
  (when both directions work) is absorbed by the `originSeq` unique index.

**Decisions (the "your call" knobs):** batch size **1000** entries (~80 B each ≈ 80 KB, under the 1 MiB
body limit; configurable); per-domain map cap **10 000**; overflow → **evict the older half by
`generatedAt`** in one shot; debounce flush window **~500 ms**; `hasMore` named for consistency with
the `/messages` endpoint.

### 3.2 `GET /api/v1/s2s/messages` (the authoritative pull)

The receiver pulls the **sender's side only** — never its own authored messages. Query:

- `fromAccount=<account>` — the author, a **local** user on the serving (author's) server. Always the
  peer/source side — never "me".
- `toAccount=<account>` — the requester's user (a foreign stub here); together with `fromAccount`
  identifies the friend pair + thread.
- `toDomain=<domain>` — the requester's domain; **binding-checked `=== signer`** (the signature proves
  only the signer domain, so the requester asserts it explicitly).
- `afterSeq=<originSeq>` — the receiver's cursor (`MAX(originSeq)` it already has); `-1`/omitted = from
  the start (history backfill — Step 2.5 uses the same endpoint).
- `take=<N>` — batch size, default `50`, capped (the quota hook, §6).

The serving server:

1. `S2sSignatureGuard` (signed + trusted; `toDomain === signer` — the requester is the signing server).
2. Resolve `fromAccount` → local user; `toAccount` → foreign stub of the signer domain;
   **`Friendship.status === 'APPROVED'`** (Gate 2).
3. `thread = Friendship.threadId` for that pair.
4. `findMany({ where: { threadId: thread, creator: fromAccount.id, originSeq: { gt: afterSeq } },
orderBy: { originSeq: 'asc' }, take: take + 1 })` → drop the `+1`th as `hasMore`.
5. `latestSeq = MAX(originSeq)` for `(threadId, creator=fromAccount.id)` (the author's high-water mark
   within this thread — informational; the receiver advances its own cursor from the messages it
   STORES, not from `latestSeq`).

Response:

```json
{
  "messages": [
    {
      "originSeq": 12301,
      "contentType": "PURE_TEXT",
      "content": "hi",
      "clientMessageId": "urn:uuid:...", // sender's local idempotency key (debugging only; receiver does NOT store it)
      "ts": 1719500000000, // sender's createdAt, ms — the receiver stores this as createdAt (stable across pull/pull)
      "media": [
        // present iff contentType is IMAGE/VIDEO/FILE/AUDIO
        {
          "digest": "<sha64hex>",
          "ext": "jpg",
          "bytes": 204811,
          "mime": "image/jpeg",
          "w": 1080,
          "h": 1920
        }
      ]
    }
  ],
  "latestSeq": 12345,
  "hasMore": false
}
```

**Media URLs.** The sender's `Message.content` embeds the sender's `/uploads/cas/...` URLs
(cross-origin, useless to the receiver). The pull response therefore surfaces media as structured
`{digest, ext, mime, ...}` (parsed via the existing `extractDigests(content)`), NOT as URLs. The
receiver fetches each digest via `get_file` (§3.3), stores it locally, and **rewrites** the stored
`content` to the same-origin `/uploads/cas/...` URL before insert. A media entry with a known
digest already in the receiver's CAS (`MediaAsset` hit) skips the `get_file` round trip entirely
(content-addressed dedup).

**Delete.** Not represented in the response — a **non-goal** (§9: the origin has no authority over
receiver-local data once delivered). A deleted-by-sender message simply does not appear in the window —
a gap in `originSeq` the receiver absorbs naturally (cursor advances past it). No tombstone shape is
planned; a local delete by either side stays local (never a remote-driven mutation).

### 3.3 `GET /api/v1/s2s/get_file` (media, digest-keyed, 3-check authz)

```http
GET /api/v1/s2s/get_file?digest=<sha64hex>&from=alice&to=bob
Signature-Input: ... (signed by the requester server, keyId = <requester-domain>/key-N)
```

The serving server (the file's **owner**) runs the three checks, then streams:

1. **Signed + trusted** — `S2sSignatureGuard` (`trustLevel === 'trusted'`, valid signature,
   `toDomain === signer`).
2. **Valid friendship** — `fromAccount` is a local user, `toAccount` is a foreign stub of the signer
   domain, and their `Friendship.status === 'APPROVED'`.
3. **File exists in that thread** — `MediaMessage WHERE digest = $D AND threadId = <that
friendship's thread>` exists (one indexed probe on `@@index([digest])`). This reuses the exact
   per-object index the local `/uploads/cas/*` gate uses; it answers "is this digest referenced by
   a message in the thread this friendship backs?"

If all three pass → stream the extensionless CAS blob (`data/cas/<digest[0:2]>/<digest[2:4]>/<digest>`).
Filename, message type and MIME remain message/S2S presentation metadata and do not affect identity.
`Content-Length` comes from `MediaAsset.bytes`. `Range`/resume = optional (Step 2.1). **No capability
token** — the digest is unguessable (256-bit), the 3-check chain proves membership, and the signature
proves the requester is the peer server.

**Receiver stores via the existing CAS interface** (no new media code): the upload service computes
the same sha256 → same extensionless blob path →
`MediaAssetService.upsertAndRef(digest, bytes)` (refcount++ on the dedup hit), then a `MediaMessage`
row `{ messageId, threadId, digest }` is created so the local `/uploads/cas/*` gate authorizes the
local user for free. The stored `Message.content` is rewritten to the same-origin URL. Byte-identical
on disk → served same-origin identically to a locally-uploaded file.

### 3.4 `GET /api/v1/s2s/ping` (signed liveness probe)

```http
GET /api/v1/s2s/ping
→ 200 { "domain": "aaa.com", "ts": 1719500000000 }
```

A dedicated, cheap, **authenticated** heartbeat (not the handshake). A successful signed ping proves
in one round trip: the peer is reachable, TLS is valid, AND the mutual signing keys still verify —
strictly more than TCP reachability, much lighter than the init handshake (which establishes **trust**,
a different job). Used by:

- **The reconnect sweep (§4.3)** — ping first (cheap); only on success proceed to re-handshake (if
  still demoted) + flush/pull. Keeps the 60 s tick cheap when the peer is just briefly down.
- **A slow quiet-peer liveness tick** (optional) — a trusted peer with no recent traffic still gets
  its `lastSuccessAt` refreshed, so the admin "is this peer up?" reads honestly instead of going stale
  between conversations.

> The zero-new-code alternative (reuse `GET /api/v1/s2s/users/:account/revision` as the probe) is
> rejected: it's semantically a profile probe and requires fabricating a `account`. A dedicated ping
> is ~15 lines and decouples liveness from every other concern.

---

## 4. Flows

### 4.1 Send (sender side)

```
1. alice@aaa sends a message (existing HTTP write → MessageService.writeMsgToThread):
   - allocate originSeq = MAX(originSeq for (thread, alice)) + 1, inside the write tx
   - store Message (originSeq set), MediaMessage rows (existing), thread lastMessage cache (existing)
   - SSE NEW_MESSAGE to LOCAL participants (existing, unchanged)
2. AFTER the tx commits, if the thread is federated (the other participant is a foreign stub — a cheap
   ThreadParticipant probe; local-only P2P / GROUP threads skip entirely):
   - mark domainNewMsgMap[peerDomain]["alice→bob"] = { latestSeq: msg.originSeq, generatedAt: now }
   - schedule a debounced flush (~500 ms) for peerDomain — a burst collapses to one push
3. flush = withTrustedPeer(peerDomain, () => POST /new-msg-map { origin, entries:[dirty], hasMore })
   On 200 → delete the pushed entries. On failure → keep them; the 60 s sweep retries (§4.3).
```

### 4.2 Receive (receiver side — push/pull → pull-queue → message-pull → SSE)

```
1. A `new-msg-map` push arrives (POST) OR our reconnect sweep pulls the peer's map (GET) — both feed
   the same inbound queue: for each entry, pendingPulls["alice@peer→bob"] = max(existing, latestSeq).
2. A drainer (per peer) processes pendingPulls:
     cursor = MAX(originSeq) WHERE threadId = <bob↔alice thread> AND creator = <alice stub>
     if latestSeq <= cursor → drop the entry (already current); else message-pull:
       withTrustedPeer(alice.domain, () => getSigned('/api/v1/s2s/messages?from=alice&to=bob&after='+cursor+'&take=50', alice.domain))
3. for each message in the batch (idempotent — @@unique([threadId,creator,originSeq]) absorbs a
   duplicate from a push/pull race):
     - for each media digest: get_file → saveCas → upsertAndRef → MediaMessage row → rewrite content URL
     - insert Message { creator: aliceStub, threadId, originSeq: <sender's value>, contentType, content,
                        createdAt: new Date(ts), clientMessageId: null }   // receiver leaves clientMessageId NULL
     - SSE onNewMessage(bob, serializeBody({threadId, ...msg}))   // the existing fan-out, to bob
4. loop: while (lastOriginSeqInBatch < latestSeq && hasMore) pull next batch ("keep requesting until newest is reached").
5. on cursor ≥ latestSeq → remove the pendingPulls entry (drained).
```

**Where the drainer runs.** v0.1 runs the message-pull **inline within the push handler / sweep tick**
but bounded by its own timeout (text batches are fast; media is best-effort and a per-file failure
stores the message with a placeholder digest for lazy retry, never blocking the text). If profiling
shows stall, the pull schedules onto a short in-process queue (`setImmediate` / a bounded worker) —
the design needs no infrastructure beyond that (no persistent outbox). Push/pull are already deduped,
so an at-most-once pull trigger is fine; a missed pull is caught by pull-on-open/poll.

### 4.3 Reconnect sweep + one-directional pull + cert-rotation safety

> **Implementation status: BUILT** (`FederationReconnectService.onModuleInit`). A 60 s `setInterval`
> drives `sweep()` over `listRecoverablePeerDomains()` (pending/demoted peers), with ±5 s jitter (per-
> domain `setTimeout`) and a per-domain `inFlight` guard (≤1 recovery in flight). `recover(domain)` runs
> exactly the sequence below: `pingPeer` → `ensurePeerTrusted` → `flushDomain` (buffered outbound) →
> `pullPeerMap` (one-directional fallback). The cert/key-rotation safety is inherent — every tick fetches
> `.well-known` fresh (no key pinning), so a rotation can't permanently break us. The guarantees below ARE
> current behavior.

A background sweep owns recovery for **non-trusted** (demoted/pending) peers — today trust only
re-handshakes when some user action triggers `ensurePeerTrusted`; the sweep makes it active and bounded:

- **One timer per demoted/pending peer, every 60 s (± jitter to avoid a thundering herd across many
  simultaneously-demoted peers); at most 1 in-flight attempt per peer.**
- **Each tick:**
  1. `GET /api/v1/s2s/ping` (cheap, signed) — reachability + mutual-key-validity in one round trip.
  2. On ping success → `ensurePeerTrusted(domain)` (re-fetch `.well-known` + re-handshake if still
     non-trusted — self-heal); on ping failure → next tick.
  3. On trust restored → **flush our buffered outbound map** (batched, §3.1 push) AND **pull the
     peer's map** (§3.1 pull) → both feed `pendingPulls` → the drainer pulls messages.

**One-directional connection (A→B works, B→A broken).** Step 3 does **both** directions on every
reconnect: A pushes its map to B (A→B works) **and** A pulls B's map (B→A broken, so B can't push to
A — A harvests B's hints actively). Even with a permanently one-way link, A stays current on B's new
messages because A pulls B's map each tick. Message-pull idempotency makes the push/pull overlap (when
both directions work) harmless.

**Cert/key-rotation safety (the explicit worry — firm guarantee).** The sweep **cannot get
permanently stuck on a cert or key rotation**, because every tick does a FRESH `fetchWellKnown(domain)`
over HTTPS and re-runs the init handshake — **we never pin keys** (the rejected literal-DKIM choice):

- **Peer rotates its S2S signing key** → the fresh `.well-known` returns the new key(s) → we cache and
  verify against them. The overlapping-key rotation (publish new alongside old, keep old ≥ 24 h) means
  a verifying key always exists during the switch window.
- **Peer renews its TLS cert** (DNS-01 auto-renew) → the HTTPS fetch just uses the new cert; no state
  on our side.
- **A tick lands exactly in the broken moment** (old key just retired, fetch half-done) → ping/init
  fails → stay demoted → the next 60 s tick re-fetches cleanly once the peer is stable. Worst case ≈
  60 s of extra downtime, **self-healed**.

The ONLY path to permanent breakage would be pinning a key and refusing to re-fetch — which we
explicitly do not do. The 60 s sweep is the guarantee: it is, in effect, "rediscover this peer from
scratch every 60 s." A normal key rotation doesn't even reach the sweep (fetch-on-miss + TTL absorb it
silently); only a genuinely-broken peer enters the sweep, and the sweep always heals it.

### 4.4 Catch-up triggers (the backstops — and the restart floor)

> **Implementation status: PARTIAL.** The slow periodic poll (item 2) IS built —
> `FederationReconnectService` runs a 5 min `slowPoll` over every trusted peer pulling its `/new-msg-map`,
> which also serves as the restart floor (a process restart with an empty in-memory buffer is caught within
> ≤5 min even if no push lands). The remaining open work is item 1 — pull-on-thread-open for MESSAGES:
> `syncForeignUserIfStale` (chat-open) still syncs the peer **profile** only and does not derive + pull the
> message cursor, so an individual thread is not caught up at the instant of open if every push/poll was
> lost (the 5 min slow poll is the bound). Tracked at §8 item 11.

1. **Pull-on-thread-open** — extends the existing chat-open staleness path. Today
   `syncForeignUserIfStale` probes the peer's `/revision` (profile). Step 2 adds: also derive the
   message cursor and pull (`GET /messages?after=cursor`) — so opening the thread catches up even if
   every push/pull was lost. **This is the restart floor:** the in-memory map is volatile, so after a
   process restart (buffer empty) a user simply opening the conversation re-syncs.
2. **Slow periodic poll** — a backstop sweep over active federated P2P threads (per trusted peer),
   pulling if behind. Low frequency (configurable). The "guaranteed eventual delivery" floor in the
   absence of any push/pull — bounded cost, no worker persistence.

### 4.5 Media (end-to-end)

```
send: alice's image upload → saveCas → MediaAsset(READY) → MediaMessage{message,thread,digest}
      → content embeds /uploads/cas/<dd>/<dd>/<digest> (sender-origin)
pull: bbb receives the message with media:{digest,ext,...}
      → GET /get_file?digest=&from=alice&to=bob (3-check, stream)
      → saveCas (same sha256 → same shard path, byte-identical) → MediaAsset.upsertAndRef
      → MediaMessage{message:bobsCopy, thread:bobsThread, digest}   // local gate now authorizes bob
      → rewrite bobsCopy.content to same-origin /uploads/cas/<dd>/<dd>/<digest>
      → bob's client renders it through the EXISTING /uploads/* media-token gate (no new client path)
```

---

## 5. Unified pre-flight (`withTrustedPeer`) — the user's explicit ask

Every Step 2 outbound interaction (map push / map pull / message-pull / get_file) flows through one
wrapper so "is the handshake still valid?" is checked uniformly and sudden invalidity is handled in
one place:

```ts
/** Every Step 2 outbound S2S op runs through this: ensure trust is current, run the op, demote on
 *  failure. Mirrors postSigned/getSigned's existing demote wiring, but adds the ensurePeerTrusted
 *  precondition so a demoted/blocked peer is caught BEFORE the op, not only after a failure. */
private async withTrustedPeer<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  await this.ensurePeerTrusted(domain);   // no-op if trusted; re-handshake if demoted/pending (self-heal);
                                          //   throws FEDERATION_PEER_BLOCKED if blocked (admin intent)
  return fn();   // postSigned/getSigned already markDemoted on failure; this just guarantees the gate
}
```

- **Sudden invalidity, handled:** a peer trusted moments ago that rotated a broken key / reset its
  server → the op's signature verify or HTTP call fails → `markDemoted` (purge key cache, log event) →
  the **reconnect sweep** (§4.3) sees `demoted` → ping → re-handshake → trusted again. A peer
  **blocked** by the admin mid-convo → `ensurePeerTrusted` throws `FEDERATION_PEER_BLOCKED` (50009)
  before any op → the client surfaces "blocked by your admin" (distinct from "unreachable").
- **Inbound** invalidity is the `S2sSignatureGuard` on the five endpoints (rejects
  `trustLevel !== 'trusted'` + verifies the signature). No new guard code — apply the existing one to
  the new GET routes.

This is "mostly built" (the trust lifecycle, demote-on-failure, and `ensurePeerTrusted` all ship in
Step 1 / Phase H). Step 2's only contribution is routing the new ops through `withTrustedPeer`, plus
the reconnect sweep that actively drives `ensurePeerTrusted` on a 60 s cadence instead of waiting for
a user action.

---

## 6. Quota hook points

Now **BUILT** per `docs/roadmap/federation-quotas.md` (unified local + peers). The pull model makes quota a
**receiver-inbound** concern naturally:

- **Pull response (`GET /messages`)** — the sender's server counts the batch toward the requester
  domain's daily message/image quota before responding; `429 FEDERATION_QUOTA_EXCEEDED` (with the
  batch truncated to the remaining allowance, so a partial pull still advances the cursor). A 50-batch
  × rate is its own rate-limit. Media bytes count toward the image/file/size cap on `get_file`.
- **`get_file`** — `413 FEDERATION_PAYLOAD_TOO_LARGE` over the per-category size cap; byte count
  toward the daily file/image budget.
- **`new-msg-map` push** — rate-limited per `(from, to)` to bound notify-spam; the "no-op if
  `latestSeq <= cursor`" already absorbs redundant entries.

Step 2 v0.1 deliberately exposed the quota hooks (response truncation points, 429/413 codes) without
the enforcement, so quotas could bolt on without an API change — and they since have: the unified
per-node quota system is **BUILT** (`docs/roadmap/federation-quotas.md`), and these Step-2 endpoints now enforce
ingest-side (`requests` / `messages` / `images` / `largeFiles`) via `QuotaService`.

---

## 7. Security summary

| Threat                                                                      | Control                                                                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted / un-signed peer                                                  | `S2sSignatureGuard` on all five routes (`trustLevel === 'trusted'` + RFC 9421 sig)                                                                       |
| Trusted-but-compromised peer forging "from any of its users → any of yours" | Gate 2: the `from`/`to` Friendship MUST be `APPROVED` on the serving server (the membership invariant from `federation-protocol.md` §5 Gate 2)           |
| Peer harvesting arbitrary media                                             | Check 3: digest MUST be referenced by a `MediaMessage` in the friendship's thread                                                                        |
| Spoofed/malformed `origin` / `from`                                         | `origin === signer.domain` binding check (§3.1); GETs identify the requester by `signer.domain` directly                                                 |
| Replay                                                                      | `(origin, id)` dedup on friend-op; `originSeq` unique index idempotently dedups pulled messages AND push/pull duplicates; GETs are inherently idempotent |
| Media token leakage                                                         | No token — digest is unguessable + 3-check authz per request                                                                                             |
| Cross-origin media fetch (CSP)                                              | Receiver localizes bytes into its own CAS, serves same-origin `/uploads/cas/*`                                                                           |
| Sudden peer key rotation / outage                                           | `withTrustedPeer` → `markDemoted` → 60 s reconnect sweep → self-healing re-handshake (§4.3)                                                              |
| Permanent disconnect from cert-rotation boundary                            | Every sweep tick re-fetches `.well-known` fresh; never pins keys → worst case ~60 s extra downtime (§4.3)                                                |

---

## 8. Implementation plan (ordered, verifiable)

> **Progress (DONE, 2026-07-08):** items **1–11 ALL LIVE** and the federation e2e is **16/16 green**.
> The full pipeline ships: `originSeq` allocation (MAX+1 in the write tx, unique-conflict retry on the
> `(threadId, creator, originSeq)` race), `FederationBufferService` (`domainNewMsgMap` + debounced
> ~500 ms flush + half-eviction at the 10 k cap), `POST/GET /new-msg-map`, `GET /messages` +
> `serveOutboundMessages`, the inbound drainer (single-flight, progress-gated re-trigger), `GET
/get_file` + receiver media-localize (`saveCasFromPeer` + sha256 integrity + `MediaMessage`), `GET
/ping`, `withTrustedPeer` + the 60 s reconnect sweep (§4.3), and pull-on-thread-open + slow poll
> (§4.4). Item 12 (e2e) covers the 8 Step 2 message/media scenarios (a–h) alongside the 12 Step 1 /
> profile tests — no regressions. A lost push now self-heals via sweep + pull-on-open + slow poll.
> Bug fixed during e2e: `drainPendingPulls` spun on a persistently failing pull (now progress-gated).
> **Open work is the §9 deferrals** (read receipts/presence/typing, history backfill = Step 2.5, per-peer
> quotas — design ready at `docs/roadmap/federation-quotas.md`). Delete propagation is a non-goal (§9); federated groups
> shipped in Step 3.

1. **Schema migration** — add nullable `Message.originSeq` plus a unique constraint and index on
   `(threadId, creator, originSeq)`. The change originally landed in migration
   `20260709000000_message_origin_seq` and is now represented by the consolidated SQL baseline and
   `src/database/schema.ts`. No data backfill (NULL is correct for legacy rows).
2. **`originSeq` allocation** — in `MessageService.writeMsgToThread`, allocate `MAX+1` inside the tx;
   retry unique-constraint conflicts caused by concurrent sends from the same user. Return `originSeq`
   on the saved message.
3. **Outbound buffer** — `domainNewMsgMap` (per-domain `Map<"from→to", {latestSeq,generatedAt}>`) +
   mark-dirty-on-send + debounced (~500 ms) flush + **half-eviction** on 10 k overflow (older half by
   `generatedAt`). Volatile (in-memory).
4. **`new-msg-map` endpoints** — `@Post('new-msg-map')` (guard + `origin===signer` binding + batch
   ack → caller deletes pushed entries) and `@Get('new-msg-map')` (paginated, non-destructive peek)
   in `S2sController`. `hasMore` on both.
5. **Pull endpoint** — `@Get('messages')` in `S2sController` (guard + 3-check + query); returns the
   §3.2 shape. Add `FederationService.serveOutboundMessages(fromAddress, toAddress, after, take)`.
6. **Inbound `pendingPulls` + drainer** — populate on push-receive AND on map-pull; drain via
   `FederationService.pullMessages(fromAddress, localUserId, after, take)` (`withTrustedPeer` +
   `getSigned`); idempotent insert; `SseService.onNewMessage` fan-out; loop until caught up.
7. **`get_file` endpoint** — `@Get('get_file')` in `S2sController` (guard + 3-check + stream from CAS
   shard).
8. **Media localize on receiver** — expose `UploadService.saveCas` publicly (or a thin
   `saveCasFromPeer(digest, ext, buf)` wrapper); in the pull store path, fetch each digest → `saveCas`
   → `MediaAssetService.upsertAndRef` → `MediaMessage` create → rewrite `content` to same-origin.
   Best-effort (a per-file failure stores the message with a placeholder digest for lazy retry).
9. **`ping` endpoint** — `@Get('ping')` in `S2sController` → `{ domain, ts }`; refreshes
   `lastSuccessAt` via `markContactSuccess`.
10. **[BUILT] Unified pre-flight + reconnect sweep** — `FederationService.withTrustedPeer(domain, fn)`
    routes new ops through it. `FederationReconnectService` drives the 60 s reconnect sweep (per demoted/
    pending peer, ±5 s jitter, ≤1 in-flight via `inFlight`): `pingPeer` → `ensurePeerTrusted` → flush the
    outbound map + pull the peer's map. The slow quiet-peer liveness tick is the 5 min `slowPoll`.
11. **[PARTIAL] Catch-up triggers** — the slow periodic poll sweep IS built
    (`FederationReconnectService.slowPoll`, 5 min over trusted peers, also the restart floor). Still open:
    extend `syncForeignUserIfStale` (chat-open) to also pull MESSAGES (so an individual thread catches up
    at open, not just within the 5 min slow-poll bound).
12. **e2e** — extend `test/federation.e2e-spec.ts`: (a) alice sends → bob receives via push+pull,
    assert stored + SSE shape; (b) media round-trip (image digest arrives, localizes, renders
    same-origin); (c) peer down → notify buffers → peer back → 60 s sweep flushes → bob catches up;
    (d) lost push → bob opens thread → pull-on-open catches up; (e) one-directional (block B→A) → A
    pulls B's map → stays current; (f) blocked peer → push/pull refused with `FEDERATION_PEER_BLOCKED`;
    (g) idempotent pull (duplicate push → one stored row); (h) cert/key rotation simulation → sweep
    re-fetches `.well-known` → self-heals within ~60 s, never permanent. Reuses the two-node harness
    (aaa/bbb.local) + per-fork DB isolation.

---

## 9. Deferred (explicit non-goals for Step 2 v0.1)

- **Delete propagation — NON-GOAL (origin has no authority over receiver-local data).** Once a
  message is pulled + stored it is the receiver's local data; the origin may NOT reach back to mutate it
  (the delivered-immutability / email model — this sidesteps distributed mutation consensus entirely). A
  local delete by either side stays local; a deleted-by-sender message is a gap on the receiver
  (absorbed), never a remote-driven tombstone.
- **Presence / typing** — v0.2, best-effort ephemeral (lossy, carry no `id`, never retried).
- **Read receipts across federation** — v0.2, **a separate deferred item (not the lossy presence/typing
  path).** A receipt is append-only metadata ("user X read msg Y at T"), NOT a mutation of message data,
  so it is compatible with the immutability principle above. It is NOT best-effort — delivery is wanted;
  the channel is undecided. `receipt` type reserved in `federation-protocol.md` §10.
- **[BUILT in Step 3] Federated groups** — the generalization landed in Step 3: a group is a `!`-User
  addressed by account (never a cross-server thread id, per §3.1), and the pull model generalizes to N
  foreign senders (the origin-hub aggregates per-author). See `docs/roadmap/federation-step3-design.md`.
- **History backfill as a feature** — Step 2.5; it IS the `/messages?after=0` endpoint (no new code,
  just a UI affordance + a bulk quota).
- **Restart-resilient hints** — the in-memory map is volatile; pull-on-open (§4.4) is the floor. If a
  future tier needs the hints themselves to survive restart, persist a tiny `lastPushedSeq per
(domain, fromUser, toUser)` and reseed on boot — optional, v0.2.
- **Reliable transactional delivery (outbox)** — only if a future tier needs delivery guarantees
  beyond "caught up on next flush/open/poll"; would layer ON TOP of this design (the outbox would
  retry the map push, not replace the pull).
