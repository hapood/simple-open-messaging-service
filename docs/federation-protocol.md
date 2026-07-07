# SOMS Federation — Protocol & Deployment Guide (v0.1)

> **Status:** Source of truth for both protocol integrators and node operators.
> **Scope:** Server-to-server (S2S) federation for SOMS IM threads.
> **Last updated:** 2026-07-07

---

## 0. Read this first — what SOMS federation is, and is not

SOMS federation lets two independently deployed SOMS instances exchange messages across their users — **like email, but for chat.** This document is the single reference for anyone who wants to **integrate with** a SOMS node (Part I) or **deploy** one (Part II).

### Honest naming (do not mislabel)

SOMS federation is **transport-encrypted**, not end-to-end encrypted.

- ✅ Say: "transport-encrypted federation", "TLS in transit", "server-to-server encrypted channel".
- ❌ Do **not** say: "end-to-end encrypted", "encrypted chat", "private messaging", "E2EE".

**Why the distinction matters:** TLS protects the wire (client↔server, server↔server). It does **not** protect messages from the server operators. When Alice `@alice@soms.io` messages Bob `@bob@other.com`, **both `soms.io` and `other.com` see the plaintext.** Any server admin, any database compromise, any legal compulsion on either server exposes the content. This is the email / Mastodon / Slack model — a legitimate, widely-used model — but it is not the security property users associate with "encrypted chat" (Signal/WhatsApp). The protocol reserves an opaque `content` slot so a future E2EE layer can be added without changing the envelope, but v0.1 ships **TLS only**. Never advertise v0.1 as E2EE.

### The trust model in one sentence

**You trust your own server's administrator, and your peers' server administrators. That is the entire trust boundary.** Everything in this protocol follows from that.

---

# Part I — Protocol (for integrators)

## 1. Intent & non-goals

A **lightweight, JSON-based, IM-native federation protocol.** ActivityPub-inspired (we borrow its HTTP delivery plumbing), **not** ActivityPub-conformant (we use IM vocabulary, not social vocabulary). Serialization is plain JSON, not JSON-LD.

### Design principles

1. **Lightweight above all.** A working v0.1 federation is a few hundred lines on top of the existing server.
2. **IM-native vocabulary.** Threads, participants, messages, receipts, friends — never "activities", "followers", "outbox".
3. **Plain JSON.** No XML streams (XMPP), no JSON-LD `@context` (ActivityPub).
4. **Borrow, don't invent.** HTTP delivery, WebFinger-style discovery, HTTP Message Signatures (RFC 9421), Ed25519, ULIDs, idempotency keys, exponential backoff — all de-facto/W3C/RFC standards.
5. **Allow-list federation by default.** Open federation is not supported in v0.1.
6. **Two delivery channels.** Durable (reliable, retried) for messages/receipts/friendship; ephemeral (best-effort) for presence/typing (v0.2).
7. **No global ordering.** Sort within a thread by `(ts, origin_seq)`. Accept eventual consistency. **This line is never crossed** — anything requiring a DAG, vector clocks, or state resolution is out of scope forever.

### Non-goals (v0.1)

- **Not** conforming to Matrix / XMPP / ActivityPub. Bridges are separate adapter services.
- **Not** end-to-end encryption across federation. `content` is reserved opaque for a future E2EE effort.
- **Not** open federation. Peers must be explicitly trusted, **and** users must be friends before any communication.
- **Not** global ordering, DAG-based state resolution, or strong consistency.

### Why this design, not the alternatives

| Option | Verdict | Reason |
| --- | --- | --- |
| **Matrix** | Rejected (conform) | Full-history replication + DAG state resolution is a maintainer-killer. Conduwuit (the fork that got federation working) was abandoned 2025-05-30; Continuwuity continues it. Element dominates the spec commercially. |
| **XMPP** | Rejected (conform) | Correct IM model, but XML streams are the wrong serialization for a TypeScript stack. Fragmented ecosystem. |
| **ActivityPub** | Borrow plumbing only | Pub/sub social model is not IM: no presence, no durable/ephemeral split, follower-graph audience instead of bounded thread participants. |
| **Tinode** | Reference, not adopted | Mission was "deliver XMPP's federated-IM vision"; federation never shipped. |
| **Custom (this spec)** | Selected | Thin layer over SOMS's already-email-shaped architecture. |

The complexity that sank Matrix (global consistency / DAG) and the complexity Moxie cited when Signal abandoned federation (E2EE across independent operators) are **both out of scope here.** That is what keeps this protocol lightweight.

---

## 2. Core concepts

| Concept | Description |
| --- | --- |
| **Actor (User)** | Identity `@localpart@domain`, e.g. `@alice@soms.io`. DNS-discoverable. |
| **User stub** | A remote user is represented locally as a `User` row with `origin = <domain>` and `federatedId = @bob@other.com`. Friendship and thread participation reference these stubs like any local user. |
| **Friend edge** | A bidirectional friendship between two actors. **The access primitive:** no thread exists between two users (1:1) without one, and no group invite is sent without one. Replicated on both servers. |
| **Thread** | A bounded conversation (1:1 or group). Has exactly one **origin server** owning its identity and monotonic sequence. Federated id: `thr_<rand>@<origin-domain>`. |
| **Message** | A durable payload in a thread. Immutable once issued; edits are separate envelopes referencing it. |
| **Receipt** | Delivery / read confirmation. (Delivery logic v0.2.) |
| **Thread membership** | The canonical access gate at the inbox: **you only receive envelopes for threads you are a member of.** For 1:1 threads, membership is backed by the friend edge. Origin server holds the canonical roster. |

---

## 3. Identity & discovery

### 3.1 Federated identifiers

```
actor   := "@" localpart "@" domain        # @alice@soms.io
thread  := "thr_" rand "@" origin-domain   # thr_8x3k@soms.io
message := origin-assigned ULID            # 01J8X3... (globally unique, time-sortable)
```

A thread's origin server is encoded in the thread id and **never changes.** Remote participants hold a reference, not a copy.

### 3.2 Discovery — layered

Discovery resolves "where is the SOMS service for `<domain>`?" in two layers:

1. **SRV record (optional):** look up `_soms._tcp.<domain>`. If present, it gives the **host:port** (and priority/weight for multi-server deployments; selection algorithm in §6.4).
2. **Fallback:** if no SRV, use `https://<domain>:443`.
3. **`.well-known/soms` (required):** at the resolved host:port, fetch the rich endpoint/key metadata over HTTPS.

```
GET https://<resolved-host>:<port>/.well-known/soms
→ 200 OK
Content-Type: application/json

{
  "inbox":    "https://soms.io/api/s2s/inbox",
  "backfill": "https://soms.io/api/s2s/threads",
  "software": "soms/0.1",
  "keys": [
    { "keyId": "soms.io/key-1", "ed25519": "<base64-public-key>" }
  ]
}
```

`keys` is a **JWKS-style list** (one entry per currently-published signing key, identified by `keyId`); multiple entries coexist during key rotation (§5.1). Verifiers **fetch a peer's key on `keyId`-miss** and cache it with a TTL — they do **not** pin keys (§5.1 explains why fetch-over-HTTPS beats both pinning and DNS-distribution).

### 3.3 Why SRV, not TXT, for host:port

- **SRV** (RFC 2782) is purpose-built for service location: typed fields (priority, weight, port, target), native multi-server failover/load-balancing, understood by every DNS library and operator.
- **TXT is for policy/verification** (SPF/DKIM/DMARC/`_acme-challenge`), not service location. Putting port/version in TXT means inventing a format, parsing it yourself, and re-inventing priority/weight.
- **Version belongs in the live HTTPS endpoint** (`.well-known/soms`), not DNS — DNS TTL caching would make a version field stale after upgrades and create two sources of truth.

See Part II §D2 for SRV record format and configuration.

---

## 4. Wire format (envelope)

Every S2S payload is a plain-JSON envelope. `type` routes handling; `durability` selects the channel.

```json
{
  "type": "message",
  "durability": "durable",
  "id": "01J8X3KF7Q9P2R...",
  "origin": "soms.io",
  "origin_seq": 12345,
  "thread": "thr_8x3k@soms.io",
  "from": "@alice@soms.io",
  "to": ["@bob@other.com", "@carol@third.org"],
  "ts": 1719500000000,
  "prev": "01J8X3KF7Q9P1...",
  "client_message_id": "urn:uuid:...",
  "content": { "kind": "text", "body": "hi" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `message` \| `receipt` \| `presence` \| `typing` \| `thread.invite` \| `thread.leave` \| `friend.request` \| `friend.approve` \| `friend.delete` |
| `durability` | yes | `durable` \| `ephemeral` — routes to delivery channel |
| `id` | yes (durable) | Origin-assigned ULID. Globally unique, time-sortable. Immutable. |
| `origin` | yes | Origin server domain. |
| `origin_seq` | yes (durable) | Monotonic per-`(thread, origin)`. Intra-thread ordering tiebreaker. |
| `thread` | yes (most) | Federated thread id. Absent on `friend.*` envelopes that predate a thread. |
| `from` | yes | Sender actor id. |
| `to` | yes | Remote actors to deliver to (recipient server resolves which are local). |
| `ts` | yes | Origin timestamp, ms since epoch. |
| `prev` | no | Parent message id — display-only reply threading, **not a DAG edge.** |
| `client_message_id` | no | For optimistic-send reconciliation. |
| `content` | yes (`message`) | Opaque payload matching the SOMS message content schema. Reserved as an encryption envelope for future E2EE. |

`content` is intentionally opaque so it can carry:
- today: the existing `{ kind, body }` / album / file-card payloads
- future: an encrypted blob `{ enc, keys }` for E2EE **without changing the envelope**

### 4.1 Friendship envelopes

| `type` | Carries | Notes |
| --- | --- | --- |
| `friend.request` | `from` → `to` | "Alice wants to add Bob." Delivered to Bob's server, surfaced as a friend request to Bob. |
| `friend.approve` | `from` → `to` | "Bob accepted." Both servers materialize the friend edge. **Only after this may a `thread.invite` be sent.** |
| `friend.delete` | `from` → `to` | Unfriend. Fan-out: recipient removes the edge locally and tears down access. Idempotent. |

These mirror SOMS's existing `FRIEND_REQUEST` / `FRIEND_APPROVED` / `FRIEND_DELETED` client SSE events; federation adds the S2S delivery layer.

---

## 5. Trust & access control

There are **two gates. Both must pass** for any communication:

### Gate 1 — Server allow-list

```
FederatedPeer
  domain           PK   # e.g. other.com  (WHICH domains we federate with)
  trustLevel            # pending | trusted | blocked
  addedBy               # admin who approved
  createdAt
  lastSeenAt
```

`FederatedPeer` is a **domain allow-list only** — it records *which* domains are trusted, not their keys. Signing keys are fetched from each peer's `/.well-known/soms` on demand and TTL-cached (§5.1). Inbound requests are accepted **only** from domains in `FederatedPeer` with `trustLevel = trusted` **and** a valid signature over a key the peer currently publishes. Everything else is `401`. No open-federation path in v0.1.

### Gate 2 — Thread membership (the friend gate)

At the inbox, a `message` envelope `{from: @alice, to: @bob}` is rejected unless **Bob is a member of that thread.** For a 1:1 thread, membership is established exclusively by a prior friend edge. This is the user-controlled gate that makes "trust the server" acceptable:

- The server vouches for **sender identity** (it signed the request; the sender is one of its users).
- The friend edge / thread membership is the **user-controlled admission** gate.

> **Security invariant:** without the membership check, a trusted-but-compromised peer server could forge messages "from any of its users → any of your users." The membership check is what prevents that. Servers are trusted to authenticate their users; they are **not** trusted to assert arbitrary relationships on your users.

### 5.1 Server keypairs & signing

Each instance generates an **Ed25519** keypair on first boot. The private key signs all outbound S2S requests and **must be persisted + backed up** — losing it is losing the server's identity (all peers must re-approve; see Rotation). The public key is published in `/.well-known/soms` inside a `keys` list.

**Signing model — DKIM-inspired, RFC 9421 on the wire.** We follow DKIM's (RFC 6376) proven design — a domain signs its outgoing messages with its private key, the receiver verifies with the domain's public key — but use the HTTP-correct standard: **HTTP Message Signatures (RFC 9421)**, the IETF-standardized "DKIM for HTTP", Ed25519-native. (DKIM itself is specified for email; reusing its email canonicalization on HTTP headers would be a misuse.) Element mapping:

| DKIM (RFC 6376) | SOMS S2S |
| --- | --- |
| `DKIM-Signature:` header | RFC 9421 `Signature-Input:` + `Signature:` headers |
| `d=` signing domain | `origin` field + keyId domain; binding rule `from.domain == signer.domain` |
| `s=` selector | `keyId="aaa.com/key-1"` (rotation by version) |
| `bh=` body hash | `Content-Digest` (RFC 9530), covered by the signature |
| `a=rsa-sha256` / `ed25519-sha256` | `a=ed25519` |
| public key in DNS, fetched at verify time | public key in `/.well-known/soms`, **fetched over HTTPS** + TTL-cached |

**Key distribution — fetch over HTTPS, not DNS, not pinning.** The verifier fetches the signer's public key from the signer's `/.well-known/soms` (over HTTPS) on `keyId`-miss, and caches it with a TTL — JWKS-style (key set keyed by `keyId`), the same pattern as OAuth2/JWT `kid`-on-miss. This beats both alternatives:

- **vs DNS (literal DKIM):** DKIM uses DNS only because *email has no HTTPS channel* — SMTP servers shuttle mail directly, no HTTPS GET in the path. We are HTTP-based and already serve `.well-known`, so the constraint doesn't apply. HTTPS key-fetch is TLS-protected + CA-validated-domain-control, strictly stronger than DNS (spoofable without DNSSEC). Copying DKIM's DNS choice would copy a compromise forced on email that we don't share.
- **vs pinning:** fetching fresh means no per-peer key-pinning ceremony and rotation is automatic (update `.well-known`). We trade the marginally stronger "pin once, trust forever" for much simpler ops — acceptable because the HTTPS fetch is already CA-protected.

So on inbound: take the request's `keyId`; if not in cache (or cache expired), `GET https://<signer-domain>/.well-known/soms`, find the matching key, verify. A `keyId`-miss is **never** a rejection on its own — it triggers a fetch. Only a failed fetch, or a signature that verifies against no currently-published key, is a `401`.

**Rotation (zero-downtime, DKIM/JWKS-style).** Because verifiers fetch-on-miss and `.well-known` publishes a *list*, rotate with overlapping keys:

1. **Publish** the new public key in `.well-known` alongside the old one (new `keyId`).
2. **Wait** ≥ peer cache TTL (so peers have re-fetched and cached the new key).
3. **Switch** signing to the new private key (new `keyId`); outbound carries the new `keyId`, peers verify with the now-cached (or fetch-on-miss) new key.
4. **Keep** the old key published for ≥ the outbox max-retry window (24h) so already-queued retries signed with the old `keyId` still verify.
5. **Retire** the old key from `.well-known`.

No peer re-approval needed. If a peer's `.well-known` fetch fails at switch time, the rejected request is retried by the outbox (30s→…) and succeeds once the fetch works — a delay, not a loss.

> **Clock accuracy.** RFC 9421 `Signature-Input` carries a `created` timestamp and TLS certs have validity windows, so **every server MUST run NTP** (`systemd-timesyncd` / `chrony` / `ntpd`) — a D1 prerequisite. Beyond that the design is deliberately clock-tolerant: replays are absorbed by idempotent dedup `(origin, id)` (§6.1) rather than tight time windows, and intra-thread ordering tolerates second-level skew (§7). A badly-skewed clock fails safe (TLS/signature reject → outbox retries → delivers once NTP catches up); no data corruption.

> **Two distinct keys, two distinct jobs.** The **TLS certificate** (CA-issued for the domain, §D5) secures the HTTPS transport layer. The **Ed25519 S2S keypair** (self-generated, persisted, this section) signs S2S requests at the application layer — the DKIM-equivalent key. They are independent; do not confuse them.

---

## 6. Delivery

### 6.1 Durable channel (v0.1)

Sender-responsible push, mirroring email SMTP and ActivityPub inbox delivery.

```
POST https://<recipient-domain>/api/s2s/inbox
Content-Type: application/json
Content-Digest: sha-256=<base64 sha256 of body>
Date: <RFC 7231>
Signature-Input: sig1=("@method" "@path" "@authority" "date" "content-digest");keyid="<origin>/key-1";alg="ed25519";created=<unix-ts>
Signature: sig1=:<base64 ed25519 signature>:

Body: <envelope>
```

| Status | Meaning | Sender action |
| --- | --- | --- |
| `200 OK` `{ "ok": true }` | Accepted (new or already-seen — idempotent) | Mark delivered, stop retrying. |
| `202 Accepted` | Queued, async processing | Stop retrying; errors surface out-of-band (v0.2). |
| `409 Conflict` | Duplicate `(origin, id)` already applied | Treat as success (idempotent). |
| `401 / 403` | Bad signature (after `.well-known` key fetch on `keyId`-miss) / peer not allow-listed / **membership check failed** | Do **not** retry. Alert operator. |
| `4xx` (other) | Permanent rejection | Do not retry. Log. |
| `5xx` / timeout | Transient | Retry with exponential backoff. |

**Semantics: at-least-once with idempotent dedup.** Recipients MUST dedupe by `(origin, id)`. Exactly-once is never attempted — it requires distributed consensus and is the path to Matrix-level complexity.

### 6.2 Retry budget (resolved from v0.1 open questions)

Backoff schedule: **30s → 1m → 5m → 30m → 2h → 24h**, then **dead-letter** for operator inspection. Single-worker per `(thread, recipient-domain)` to preserve `origin_seq` order; parallelism across threads/domains is fine.

### 6.3 Ephemeral channel (v0.2 — placeholder)

Presence and typing are lossy; carry no `id` and are never retried. Candidate transports: periodic best-effort POST to `/api/s2s/presence` (simplest), or a persistent S2S WebSocket per peer pair (lower latency).

### 6.4 Outbound target & address selection

When the `S2SOutboxWorker` delivers an envelope, it selects where to connect in three layers. All three live in our own client code — we do **not** rely on Node's Happy Eyeballs (see "Why explicit racing" below).

**Layer 1 — SRV priority (failover ordering).** Sort SRV targets by `priority` ascending. Every target at a lower priority must be exhausted before any target at a higher priority is tried — strict primary/backup ordering.

**Layer 2 — SRV weight (load balancing, within a priority tier).** Among targets sharing a priority, select **one** by weighted random proportional to `weight`, and fall through to the next same-priority target only on failure. Per RFC 2782, do **not** race same-priority targets in parallel — that defeats the load-balancing intent. (`weight 0` = no weighting; single target.)

**Layer 3 — A/AAAA racing (within one target).** Resolve the chosen target's addresses and race them:

1. Resolve via `dns.resolve4` / `dns.resolve6` (**c-ares**, which bypasses the OS `getaddrinfo` and its RFC 6724 ordering) — so the candidate set and order are identical across OSes.
2. Interleave families (v6, v4, v6, v4…) per RFC 8305 §5.
3. Stagger connection attempts ~250ms; **first to complete wins**; abort the rest.
4. Hard **~5s per-attempt connect timeout** as a universal backstop — worst-case fallback is bounded to seconds, never minutes.

This generalizes from 2 addresses (one v4 + one v6) to **N** addresses: a target with multiple A records (DNS round-robin), multiple AAAA records, or multiple interfaces is handled by the same racing loop. If every address at this target fails, fall through to the next SRV target (back to Layer 2, then Layer 1).

**Why explicit racing (not Node's HE).** Node's `autoSelectFamily` (Happy Eyeballs) has been default-on since Node 20, but it does **not** fully implement RFC 8305 parallel racing and has known `AggregateError`/`ETIMEDOUT` failure modes ([#48145](https://github.com/nodejs/node/issues/48145), [#52216](https://github.com/nodejs/node/issues/52216)). Pin **Node 22+** as the runtime baseline, but implement the racing above in the S2S client so behavior is deterministic and OS-independent regardless of Node's HE maturity.

---

## 7. Ordering & consistency

- **Within a thread:** sort by `(ts, origin_seq)`. `ts` is the origin's clock; `origin_seq` (per-thread, monotonic on origin) breaks ties.
- **`origin_seq`:** allocated by a per-thread counter on the origin server. No cross-thread coordination.
- **Reply threading:** `prev` is display-only, not a DAG edge.
- **Edits/deletes:** last-writer-wins by `ts`; an edit is a new envelope with `edit_of` referencing the original. No merge semantics.
- **Clock skew:** tolerated at second granularity; ordering glitches are an accepted trade-off.
- **Roster authority:** the origin server holds the canonical participant list; each server tracks its own local users' membership locally.
- **No global ordering, ever.**

---

## 8. History backfill

A server pulls thread history from the origin when its user is added/rejoins:

```
GET https://<origin>/api/s2s/threads/<thread-id>/messages?after=<message-id>&limit=50
Signature: ...

→ 200 OK
{ "thread": "thr_8x3k@soms.io", "messages": [ ... ], "hasMore": true }
```

- **Authorization:** only peers with **a local user who is a member of that thread** (proof of membership) may backfill. This prevents a trusted peer from harvesting arbitrary threads' history.
- Only the origin serves canonical history; remotes store only what was delivered/backfilled. **Email/XMPP model, not Matrix's full-replication.**

---

## 9. Federation flows

### 9.1 Cross-server friendship → 1:1 thread

```
Alice@soms.io wants to chat with Bob@other.com.

1. Alice's client → soms.io: "add friend @bob@other.com"      (existing friend-request flow)
2. soms.io → other.com /api/s2s/inbox:
     { type: "friend.request", from: "@alice@soms.io", to: ["@bob@other.com"], ... }
3. other.com verifies Bob exists; surfaces friend request to Bob (existing FRIEND_REQUEST SSE).
4. Bob approves.
5. other.com → soms.io /api/s2s/inbox:
     { type: "friend.approve", from: "@bob@other.com", to: ["@alice@soms.io"], ... }
6. BOTH servers materialize the friend edge (Alice↔Bob stub) locally.
7. soms.io creates the Thread (origin=soms.io, federated id thr_8x3k@soms.io).
8. soms.io → other.com /api/s2s/inbox:
     { type: "thread.invite", thread: "thr_8x3k@soms.io", from: "@alice@soms.io", to: ["@bob@other.com"] }
9. other.com creates a local Thread record pointing to the federated id; pushes NEW_THREAD to Bob.
```

**No `thread.invite` may precede a `friend.approve`.** Step 7 onward is the original spec's thread-creation flow; the friend phase is prepended.

### 9.2 Send a message

```
1. Alice's client → soms.io: send message (existing HTTP write)
2. soms.io: store Message, assign ULID id + origin_seq
3. soms.io: push to local participants via existing SSE NEW_MESSAGE      (unchanged)
4. soms.io FederationService: identify remote participants; write S2SOutbox rows
5. soms.io → each remote /api/s2s/inbox: { type: "message", ... }
6. remote: dedupe by (origin, id), verify membership, store, push via its own SSE
```

Federation is purely additive — appended after the existing local push.

### 9.3 Cross-server group invite

Group invites remain friend-gated: **the inviter and invitee must already be friends across servers** (consistent with local SOMS, where groups invite friends). A `thread.invite` addressed to the new participant triggers backfill (§8) on their server so they see prior history. Once a member, their access grant is thread membership — pairwise friendship with every other member is **not** required (matches local group semantics).

### 9.4 Unfriend

```
Alice removes Bob.
1. soms.io marks the friend edge deleted locally.
2. soms.io → other.com /api/s2s/inbox:
     { type: "friend.delete", from: "@alice@soms.io", to: ["@bob@other.com"] }
3. other.com removes its local edge; subsequent messages between them are rejected at the membership gate.
```

Both directions' access tears down. (1:1 thread history is retained read-only per existing SOMS semantics; only new delivery is blocked.)

---

## 10. Schema (Prisma)

```prisma
// Existing models gain origin/federatedId for federation awareness
model User {
  // ... existing fields
  origin       String   @default("local")   // "local" | <origin-domain>
  federatedId  String?                       // @user@domain, null for local-origin
}

model MessageThread {
  // ... existing fields
  origin       String   @default("local")
  federatedId  String?                       // thr_xxx@origin, null for local-origin
}

// Friendship references User rows (local or remote stub) unchanged;
// federation awareness comes from User.origin/federatedId.

// New: domain allow-list (WHICH domains we federate with — not their keys)
model FederatedPeer {
  domain       String   @id
  trustLevel   String   @default("pending")  // pending | trusted | blocked
  addedBy      String?
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime?
}

// New: cached peer signing keys (fetched from each peer's /.well-known/soms, TTL'd)
model S2SKeyCache {
  domain       String
  keyId        String
  publicKey    String                        // ed25519, base64
  fetchedAt    DateTime @default(now())

  @@id([domain, keyId])
  @@index([domain])
}

// New: outbound delivery queue
model S2SOutbox {
  id              String   @id @default(cuid())
  envelopeId      String                        // origin message id
  threadId        String?
  recipientDomain String
  payload         Json                          // the full envelope
  status          String   @default("pending")  // pending | in_flight | delivered | dead
  attempts        Int      @default(0)
  nextRetryAt     DateTime?
  lastError       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([status, nextRetryAt])
  @@index([threadId, recipientDomain])
}

// New: inbound dedup
model S2SInboxSeen {
  origin       String
  envelopeId   String
  receivedAt   DateTime @default(now())

  @@id([origin, envelopeId])
}
```

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/s2s/inbox` | Receive envelopes from trusted peers |
| `GET` | `/api/s2s/threads/:id/messages` | Backfill history (origin only) |
| `GET` | `/.well-known/soms` | Publish server key + endpoints |

### Services (NestJS)

- `FederationService` — tail of the message-send pipeline. Identifies remote participants, writes `S2SOutbox` rows.
- `S2SOutboxWorker` — drains `pending` rows, signs + POSTs, applies backoff.
- `InboxHandler` — checks `FederatedPeer` allow-list, verifies signature (fetches key on `keyId`-miss from `.well-known`, §5.1), **verifies thread membership**, dedupes via `S2SInboxSeen`, routes by `type`.
- `SignatureService` — Ed25519 sign/verify; RFC 9421 `Signature-Input`/`Signature` construction (DKIM-model, §5.1).
- `DiscoveryService` — SRV + `.well-known/soms` resolution + caching.

### Deferred (explicit non-goals for v0.1)

- **E2EE** — `content` reserved; crypto is a separate effort.
- **Presence / typing** — ephemeral channel, v0.2.
- **Read receipts across federation** — `receipt` type reserved; logic v0.2.
- **Media federation** — remote clients fetch from origin via the existing `/uploads/*` + `media_token` cookie pattern. No replication.
- **Open federation / anti-spam** — allow-list only.
- **Bridges to Matrix / XMPP / ActivityPub** — separate adapter services.
- **Identity portability** — `@user@domain` is bound to its server in v0.1.
- **Multi-device sync across servers** — protocol federates at server granularity only.

---

## 11. References

- **ActivityPub** (W3C) — delivery model. https://www.w3.org/TR/activitypub/
- **HTTP Message Signatures** (RFC 9421) — S2S request signing (DKIM-equivalent for HTTP). https://www.rfc-editor.org/rfc/rfc9421
- **DKIM** (RFC 6376) — signing model reference. https://www.rfc-editor.org/rfc/rfc6376
- **Content-Digest** (RFC 9530) — body integrity for signed requests. https://www.rfc-editor.org/rfc/rfc9530
- **WebFinger** (RFC 7033) — discovery pattern. https://www.rfc-editor.org/rfc/rfc7033
- **SRV** (RFC 2782) — service location. https://www.rfc-editor.org/rfc/rfc2782
- **Underscore labels** (RFC 8552) — service-label convention. https://www.rfc-editor.org/rfc/rfc8552
- **Well-known URIs** (RFC 8615). https://www.rfc-editor.org/rfc/rfc8615
- **Happy Eyeballs** (RFC 8305) — v4/v6 connection racing. https://www.rfc-editor.org/rfc/rfc8305
- **ULID** — sortable ids. https://github.com/ulid/spec
- **Ed25519** (RFC 8032) — server keypairs. https://www.rfc-editor.org/rfc/rfc8032

---

# Part II — Deployment guide (for operators)

This part takes you from zero to a federating SOMS node. Every decision here is justified in Part I.

## D1. Prerequisites

1. **A domain you control the DNS zone for.** This is non-negotiable: to use SRV and `/.well-known/soms`, you must be able to add records to the zone. A DDNS-provided subdomain you don't control is **not** sufficient as your federation identity (see D3).
2. **Node.js 22+.** Required so the S2S HTTP client gets Happy Eyeballs (RFC 8305) dual-stack connection racing by default (see D6).
3. **A SOMS instance** reachable on some host:port (reverse-proxied on 443, or direct on a custom port).
4. **Accurate system clock (NTP).** Run `systemd-timesyncd` / `chrony` / `ntpd`, enabled at boot. RFC 9421 signatures carry a `created` timestamp and TLS certs have validity windows, so clock skew breaks both (§5.1). NTP's ms-level accuracy is sufficient; the protocol is tolerant beyond that (replays absorbed by dedup, ordering tolerates skew).

Your federation identity is `@<your-localpart>@<your-domain>`. The domain in every handle below is the domain whose DNS zone you control.

## D2. DNS setup

You have two deployment shapes.

### Shape A — simplest: reverse proxy on 443 (no SRV needed)

If SOMS is behind a reverse proxy on standard HTTPS port 443, **you do not need any SRV or special DNS.** Discovery resolves `https://<your-domain>:443/.well-known/soms` directly.

Just ensure `/.well-known/soms` is served (it is, by SOMS) and your TLS cert is valid for your domain (D5).

### Shape B — custom port, different host, or multi-server: add SRV

Use SRV when your SOMS is **not** on 443, runs on a host different from your apex domain, or you run multiple servers.

**SRV record format (RFC 2782):**

```
_soms._tcp.<your-domain>.   <TTL>   IN   SRV   <priority> <weight> <port> <target-host>
```

| Field | Meaning | Typical value |
| --- | --- | --- |
| `priority` | Lower = preferred (like MX). Use multiples of 10 to leave room to insert tiers. | `10` |
| `weight` | Load share among same-priority targets. `0` if single server. | `0` |
| `port` | The port SOMS actually listens on. | `7667` (D4) |
| `target` | Hostname that resolves (directly or via CNAME) to A/AAAA records. **Not an IP.** | `soms.your-domain.com.` |

**Single server (the common case):**
```
_soms._tcp.your-domain.com.  3600  IN  SRV  10 0 7667 soms.your-domain.com.
```

**Primary + backup (priority):**
```
_soms._tcp.your-domain.com.  3600  IN  SRV  10 0 7667 primary.your-domain.com.
_soms._tcp.your-domain.com.  3600  IN  SRV  20 0 7667 backup.your-domain.com.
```

**Two servers, weighted load balance:**
```
_soms._tcp.your-domain.com.  3600  IN  SRV  10 70 7667 big.your-domain.com.
_soms._tcp.your-domain.com.  3600  IN  SRV  10 30 7667 small.your-domain.com.
```

**Verify:**
```bash
dig SRV _soms._tcp.your-domain.com +short
# → 10 0 7667 soms.your-domain.com.
```

### Where to configure

| Provider | How |
| --- | --- |
| **BIND zone file** | `_soms._tcp.your-domain.com. IN SRV 10 0 7667 soms.your-domain.com.` (trailing dot = FQDN) |
| **Cloudflare** | Type `SRV` → Name `_soms._tcp` → Priority/Weight/Port/Target fields |
| **AWS Route53** | Type `SRV` → Name `_soms._tcp` → Value `10 0 7667 soms.your-domain.com.` |

### SRV gotchas

1. **`target` is a hostname, not an IP** — it must resolve to A/AAAA records (directly or through a CNAME chain).
2. **Trailing dot in zone files** — `soms.your-domain.com.` not `soms.your-domain.com`. Web UIs usually handle this for you.
3. **Don't put a CNAME at `_soms._tcp` itself.** CNAME must be the only record at a name and carries no port — it can't replace SRV. The dynamic-IP problem is solved at the `target` layer (D3).

### Ports to avoid (collide with mainstream services)

`8448` (Matrix federation — the one to avoid most for a chat protocol), `5222`/`5269` (XMPP), `1883`/`8883` (MQTT), `6660–6669`/`6697` (IRC), `8080`/`8443`/`8000` (alt HTTP(S)), `11434` (Ollama), `7860` (Gradio), `8848` (Nacos), `9000`/`9090`/`9091`, `64738` (Mumble), `25565` (Minecraft). See D4.

### TXT records — when to use them

TXT is **not** for service location. Its legitimate role here is **domain ownership verification**, should you add a DNS-based proof step to peer approval later (optional; v0.1 trust = admin-approved allow-list + keys fetched over HTTPS per §5.1, OOB fingerprint as optional hardening). Do not encode port/version in TXT.

## D3. DDNS / dynamic IP

If your server is on a dynamic IP (home connection, etc.), the DDNS provider keeps an A record updated for you. **Reference that DDNS hostname by name in your SRV `target`** — DNS resolution chases the chain at query time, so clients always reach your current IP. You do **not** CNAME the SRV record itself.

**Option 1 — SRV target is the DDNS hostname directly (simplest):**
```
; DDNS provider auto-updates this:
myhome.ddns.net.                    A    203.0.113.55   (dynamic)

; Your domain:
_soms._tcp.your-domain.com.  3600  IN  SRV  10 0 7667 myhome.ddns.net.
```

**Option 2 — own a stable hostname under your domain (nicer for TLS certs), CNAME it to DDNS:**
```
soms.your-domain.com.        3600  IN  CNAME  myhome.ddns.net.
_soms._tcp.your-domain.com.  3600  IN  SRV    10 0 7667 soms.your-domain.com.
```
`soms.your-domain.com` always tracks your dynamic IP via the CNAME; you can issue a Let's Encrypt cert for `soms.your-domain.com` (your own name).

### DDNS gotchas

1. **Apex domain cannot be a CNAME** (RFC 1034). `your-domain.com. CNAME myhome.ddns.net.` is invalid. Put SOMS on a **subdomain** (`soms.your-domain.com`), or use your provider's ALIAS/CNAME-flattening record type at the apex.
2. **Your federation identity domain must be one whose DNS zone you control.** If your identity *is* a DDNS subdomain you can't add records to, you're stuck on `https://<that-subdomain>:443/.well-known/soms` — no SRV, no custom port. **Own your domain; use DDNS only for IP tracking.**

## D4. Port choice

**Recommended: `7667`.**

It's **SOMS on a T9 phone keypad** (S=7, O=6, M=6, S=7), and it's a palindrome. Distinctive, memorable, and clear of mainstream service ports. It sits in the registered range (1024–49151) and well below Linux's ephemeral port start (32768), so it won't collide with outbound connection source ports.

```
_soms._tcp.your-domain.com.  3600  IN  SRV  10 0 7667 <your-host>.
```

**Bland alternatives** if you want zero thematic baggage: `8321`, `9123`.

**Avoid** the list in §D2 (8448 Matrix, XMPP, MQTT, IRC, alt-HTTP, Ollama, Gradio, Nacos, etc.).

## D5. TLS

All federation traffic is HTTPS. You need a valid TLS cert for **the hostname clients actually connect to** (i.e., the SRV `target`, or your apex if Shape A).

**For dynamic-IP / DDNS deployments, use DNS-01 challenges** (not HTTP-01):
- HTTP-01 breaks when your IP changes mid-renewal or your ISP blocks inbound 80/443.
- DNS-01 only checks a DNS TXT record — your IP can change freely and renewals keep working. This is near-mandatory for DDNS.

Cert managers: `certbot` with a DNS plugin for your provider, or `acme.sh` (supports many Chinese DNS providers via API). Issue the cert for the name in your SRV target / `.well-known` URL.

## D6. IPv4 / IPv6 dual-stack

### The trap: broken IPv6 with AAAA published

If your DDNS publishes both A (v4) and AAAA (v6), and your v6 path is dead (ISP doesn't route v6, v6 firewall drops inbound, address is ULA/unreachable), clients that prefer v6 will try the dead address first. **This is the classic IPv6 blackhole** and the single most common federation-reachability bug on home servers.

### How fallback actually behaves

DNS returns both families; `getaddrinfo` orders them (RFC 6724, v6 first by default). The fallback **speed depends on the client:**

| Client | Behavior | Fallback delay on dead v6 |
| --- | --- | --- |
| Happy Eyeballs (RFC 8305): browsers, curl, **Node 20+/undici**, Go 1.12+ | Races v6 then v4 concurrently after ~250ms | ~250ms |
| No Happy Eyeballs: older/naive clients | Tries v6, waits for full TCP connect timeout | ~60–120s (Linux default `tcp_syn_retries`) |

### Make it robust

1. **SOMS races address families explicitly** in its S2S client (§6.4) — it does **not** depend on Node's Happy Eyeballs, which is incomplete and has known `ETIMEDOUT` failure modes. Node 22+ remains the runtime baseline. (So the "~250ms" row in the table above is what SOMS achieves by its own implementation, not by trusting Node's HE.)
2. **At the DDNS layer, publish AAAA only if v6 is genuinely reachable end-to-end.** Your DDNS updater should probe v6 reachability before publishing AAAA. If in doubt, **publish only A** and skip v6 entirely — simplest and bulletproof.

### Inbound (server side)

Bind SOMS to all interfaces and both families so peers reach you on whichever IP DNS returns. In Node, bind `::` with `ipv6Only: false` (one socket covers v4 + v6 and every network interface/IP on the host), or bind `0.0.0.0` for v4-only-all-interfaces. The same dual-stack listener also covers **multi-IP hosts** — multiple v4 addresses, multiple AAAA, or multiple NICs — accepting connections on all of them with no extra config. Ensure your firewall allows inbound on the SRV port for every family/IP you publish.

## D7. Adding a federation peer

Adding a peer is a **two-step admin action** on both sides:

1. **Operator on server A** adds `other.com` to `FederatedPeer` (`trustLevel = pending`).
2. **A fetches** `other.com/.well-known/soms` over HTTPS (via SRV/HTTPS discovery). Because the fetch is TLS-protected and CA-validated, the published `keys` are trustworthy as-is — A marks `trustLevel = trusted`. Keys are **not** pinned; they're re-fetched on `keyId`-miss per §5.1.
3. **(Optional hardening)** A's operator verifies the key fingerprint with `other.com`'s operator out-of-band (separate trusted channel) to defeat a CA/discovery compromise. Recommended for high-trust pairs; not required for v0.1 since HTTPS already protects the key fetch.
4. The reverse is done on `other.com` (mutual trust is required for bidirectional federation).

Only after both sides are `trusted` do `friend.request` / `thread.invite` / `message` envelopes flow. **Key rotation does not require re-approval** — it's handled by `.well-known` republishing (§5.1).

---

## Quickstart checklist

```
[ ] Own a domain whose DNS zone you control
[ ] SOMS deployed + reachable on host:port (reverse proxy on 443, OR custom port via SRV)
[ ] If non-443/different-host/multi-server: _soms._tcp.<domain> SRV record added (port 7667)
[ ] /.well-known/soms served over HTTPS (publishes `keys` list)
[ ] TLS cert valid for the SRV target / .well-known host (DNS-01 for dynamic IP)
[ ] DDNS: AAAA published only if v6 reachable end-to-end; else A only
[ ] Node 22+; S2S client connect timeout ~5s
[ ] NTP running (systemd-timesyncd / chrony / ntpd)
[ ] Ed25519 S2S signing key persisted + backed up (loss = full re-approval)
[ ] Peer added mutually (trusted); keys fetched from .well-known (OOB fingerprint optional)
[ ] dig SRV _soms._tcp.<domain> +short returns expected record
```

Once two nodes complete this checklist, `friend.request` between their users creates the first cross-server friendship, and the durable channel carries messages from there.
