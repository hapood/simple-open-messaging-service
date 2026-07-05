# SOMS Federation Protocol — v0.1 (Draft)

> **Status:** Draft, pre-implementation. Captured as source of truth before coding.
> **Scope:** Server-to-server (S2S) federation for SOMS IM threads.
> **Last updated:** 2026-07-05

---

## 1. Intent

This document specifies a **lightweight, JSON-based, IM-native federation protocol** that lets two independently deployed SOMS instances exchange messages across their thread participants — like email, but for chat.

It is **ActivityPub-inspired, not ActivityPub-conformant**. We borrow ActivityPub's HTTP delivery plumbing (POST-to-inbox, WebFinger discovery, HTTP Signatures) because it is proven and standard, but we use **IM vocabulary** (threads, participants, presence, durable vs ephemeral) instead of social vocabulary (activities, followers, outbox fan-out). The serialization is **plain JSON**, not JSON-LD.

### Non-goals (v0.1)

- **Not** conforming to Matrix, XMPP, or ActivityPub specs. Bridges to them are separate adapter services (see §13).
- **Not** end-to-end encryption across federation. The envelope reserves an opaque `content` slot so E2EE can be layered on later, but v0.1 guarantees only TLS transport between servers.
- **Not** open federation. v0.1 is **allow-list only** — peers must be explicitly trusted.
- **Not** global ordering, DAG-based state resolution, or strong consistency. We accept eventual consistency, last-writer-wins for edits, and best-effort ordering by timestamp.

---

## 2. Background & Positioning

Reconnaissance of the existing landscape (July 2026) drove every design decision:

| Option | Verdict | Reason |
| --- | --- | --- |
| **Matrix** | Rejected (conform) | Full-history replication + DAG state resolution is a maintainer-killer. Conduwuit (the one fork that got federation working) was abandoned in 2025. Element dominates the spec commercially. |
| **XMPP** | Rejected (conform) | Correct IM model, but XML stream protocol is the wrong serialization for a TypeScript stack. Ecosystem is fragmented; no default E2EE. |
| **ActivityPub** | Borrow plumbing only | Pub/sub social model is not IM: no presence, no durable/ephemeral split, follower-graph audience instead of bounded thread participants. |
| **Tinode** | Reference, not adopted | Stated mission ("deliver on XMPP's vision: federated IM") but federation never landed. |
| **Conduit / Conduwuit / Continuwuity / Tuwunel** | Cautionary tale | Revolving door of abandoned projects proves Matrix conformance burns out maintainers. |
| **Custom (this spec)** | Selected | Thin layer over SOMS's already-email-shaped architecture. Borrows proven primitives, adds nothing novel. |

**Design discipline:** the line we do not cross is global consistency. Everything that would require a DAG, vector clocks, or state resolution is out of scope forever — that is the exact complexity that made Matrix heavy and is what keeps this protocol lightweight.

---

## 3. Design Principles

1. **Lightweight above all.** A working v0.1 federation between two instances is a few hundred lines of NestJS on top of the existing server.
2. **IM-native vocabulary.** Threads, participants, messages, presence, receipts — never "activities", "followers", or "outbox".
3. **Plain JSON.** No XML streams (XMPP), no JSON-LD `@context` machinery (ActivityPub).
4. **Borrow, don't invent.** Every primitive (HTTP POST delivery, WebFinger discovery, HTTP Signatures, Ed25519 keys, ULIDs, idempotency keys, exponential backoff) is a de-facto or W3C standard with mature libraries.
5. **Allow-list federation by default.** Open federation is opt-in and not supported in v0.1.
6. **Two delivery channels.** Durable (reliable, retried) for messages/receipts; ephemeral (best-effort) for presence/typing. This split is what makes the protocol IM rather than social.
7. **No global ordering.** Sort within a thread by `(ts, origin_seq)`. Accept eventual consistency.

---

## 4. Core Concepts

| Concept | Description |
| --- | --- |
| **Actor (User)** | Identity `@localpart@domain`, e.g. `@alice@soms.io`. DNS-discoverable. |
| **Thread** | A bounded conversation (1:1 or group). Has exactly one **origin server** which owns its identity and monotonic sequence. Federated id: `thr_<rand>@<origin-domain>`. |
| **Message** | A durable payload in a thread. Immutable once issued; edits/receipts are separate envelopes that reference it. |
| **Receipt** | Delivery / read confirmation for a message. |
| **Presence** | Online / offline / away status. Ephemeral. **Deferred to v0.2.** |
| **Typing** | "User is typing…" indicator. Ephemeral. **Deferred to v0.2.** |
| **Durable channel** | HTTP POST, idempotent, at-least-once, retried. Carries messages + receipts. |
| **Ephemeral channel** | Best-effort, lossy. Carries presence + typing. **v0.2.** |

---

## 5. Identity & Discovery

### 5.1 Federated identifiers

```
actor   := "@" localpart "@" domain        # @alice@soms.io
thread  := "thr_" rand "@" origin-domain   # thr_8x3k@soms.io
message := origin-assigned ULID            # 01J8X3... (globally unique, time-sortable)
```

The origin server of a thread is encoded in the thread id and **never changes**. A thread's home is always its origin; remote participants hold a reference to it, not a copy.

### 5.2 Server discovery

```
GET https://<domain>/.well-known/soms
→ 200 OK
Content-Type: application/json

{
  "inbox":      "https://soms.io/api/s2s/inbox",
  "backfill":   "https://soms.io/api/s2s/threads",
  "server_key": "ed25519:base64-public-key",
  "key_id":     "soms.io/key-1",
  "software":   "soms/0.1"
}
```

Discovery is fetched once and cached. The `server_key` is verified against the locally trusted key in `FederatedPeer` (§8); a mismatch means the peer rotated keys and must be re-approved by an admin.

---

## 6. Wire Format (Envelope)

Every S2S payload is a plain-JSON envelope. The `type` discriminator routes handling; `durability` selects the delivery channel.

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
| `type` | yes | `message` \| `receipt` \| `presence` \| `typing` \| `thread.invite` \| `thread.leave` |
| `durability` | yes | `durable` \| `ephemeral` — routes to delivery channel |
| `id` | yes (durable) | Origin-assigned ULID. Globally unique, time-sortable. Immutable. |
| `origin` | yes | Origin server domain. |
| `origin_seq` | yes (durable) | Monotonic per-`(thread, origin)`. Used for intra-thread ordering. |
| `thread` | yes | Federated thread id. |
| `from` | yes | Sender actor id. |
| `to` | yes | Remote actors to deliver to (recipient server resolves which are local). |
| `ts` | yes | Origin timestamp, ms since epoch. |
| `prev` | no | Previous message id in thread — parent pointer for reply threading. **Not a DAG; display-only.** |
| `client_message_id` | no | For optimistic-send reconciliation (already exists in SOMS client-side). |
| `content` | yes | Opaque payload matching the existing SOMS message content schema. Reserved as an encryption envelope for future E2EE. |

`content` is intentionally opaque at the protocol layer so it can carry:
- today: the existing `{ kind, body }` / album / file card payloads
- future: an encrypted blob `{ enc: "...", keys: {...} }` for E2EE without changing the envelope

---

## 7. Delivery

### 7.1 Durable channel (v0.1)

Sender-responsible push, mirroring email SMTP and ActivityPub inbox delivery.

```
POST https://<recipient-domain>/api/s2s/inbox
Content-Type: application/json
Date: <RFC 7231>
Signature: keyId="<origin>/key-1",algorithm="ed25519",signature="<base64>"
Body: <envelope>
```

Recipient response contract:

| Status | Meaning | Sender action |
| --- | --- | --- |
| `200 OK` `{ "ok": true }` | Accepted (new or already-seen — idempotent) | Mark delivered, stop retrying. |
| `202 Accepted` | Queued, async processing | Stop retrying; recipient will surface errors out-of-band (v0.2). |
| `409 Conflict` | Duplicate `(origin, id)` already applied | Treat as success (idempotent). |
| `401 / 403` | Bad signature / peer not in allow-list | Do **not** retry. Alert operator. |
| `4xx` (other) | Permanent rejection | Do not retry. Log. |
| `5xx` / timeout | Transient | Retry with exponential backoff. |

**Delivery semantics: at-least-once with idempotent dedup.** Recipients MUST dedupe by `(origin, id)`. Never attempt exactly-once — that requires distributed consensus and is the path to Matrix-level complexity.

### 7.2 Ephemeral channel (v0.2 — design placeholder)

Presence and typing are lossy. Candidate transports, to be decided in v0.2:
- **Option A:** periodic best-effort POST to `/api/s2s/presence` (simplest, chattier).
- **Option B:** a persistent S2S WebSocket per peer pair (lower latency, more state).

Either way, ephemeral envelopes carry no `id` and are never retried. Drops are acceptable; the next update overwrites prior state.

### 7.3 Outbox & retry

The origin server maintains an **`S2SOutbox`** table — a durable queue of envelopes awaiting delivery to each recipient server. Responsibilities:

- Fan-out: one envelope with N recipients → N outbox rows (one per recipient domain).
- Retry: exponential backoff (e.g. 30s → 1m → 5m → 30m → 2h → 24h, then dead-letter).
- Dead-letter queue for operator inspection after max retries.
- Ordering preservation: deliver to a given recipient in `origin_seq` order per thread. (Single-worker per `(thread, recipient-domain)` to avoid reordering; parallelism across threads/domains is fine.)

---

## 8. Trust & Authentication

### 8.1 Server keypairs

Each SOMS instance generates an **Ed25519** keypair on first boot. The private key signs all outbound requests; the public key is published in `/.well-known/soms` and stored by every peer in their `FederatedPeer` table.

Key rotation is supported (`key_id` versioning). On detecting a mismatch between the published key and the trusted key, peers MUST reject delivery and surface an admin task to re-verify the new key out-of-band.

### 8.2 Request signing

**HTTP Signatures** (the de-facto standard used by ActivityPub / Mastodon). Sign `Date`, `Digest` (SHA-256 of body), and `Host` headers. Recipient verifies using the origin's published `server_key`.

### 8.3 Allow-list federation

```
FederatedPeer
  domain           PK   # e.g. other.com
  server_key            # trusted Ed25519 public key
  key_id                # current key version
  trust_level           # trusted | blocked
  added_by              # admin who approved
  created_at
  last_seen_at
```

Inbound requests are accepted **only** from domains present in `FederatedPeer` with `trust_level = trusted` AND a valid signature. Everything else is `401`. There is no open-federation path in v0.1.

Adding a peer is a two-step admin action:
1. Operator on server A adds `other.com` to `FederatedPeer` (pending).
2. A fetches `other.com/.well-known/soms`, stores its `server_key`, marks `trusted`.

---

## 9. Ordering & Consistency

- **Within a thread:** sort by `(ts, origin_seq)`. `ts` is the origin's clock at send time; `origin_seq` breaks ties (same origin, same millisecond).
- **Reply threading:** `prev` is a parent pointer for "in reply to" display only. It is **not** a DAG edge and participates in no state resolution.
- **Edits / deletes:** last-writer-wins by `ts`. An edit is a new envelope of type `message` with an `edit_of` field (extension) referencing the original `id`. Conflict between concurrent edits is resolved by `ts`; no merge semantics.
- **Clock skew:** origin timestamps are advisory. A skew of seconds between servers is tolerated; ordering glitches are accepted as a trade-off for not running a consensus protocol.
- **No global ordering, ever.** This is the line that keeps the protocol lightweight. If a future requirement demands global ordering, that requirement is out of scope for this protocol family.

---

## 10. History Backfill

A server that needs history for a thread (e.g. its user was just added, or rejoined) pulls from the origin:

```
GET https://<origin>/api/s2s/threads/<thread-id>/messages?after=<message-id>&limit=50
Authorization: S2S <signed-token>
Signature: ...

→ 200 OK
{
  "thread": "thr_8x3k@soms.io",
  "messages": [ <envelope>, ... ],
  "hasMore": true
}
```

- Paginated by `after` (exclusive) using the origin `id`/`origin_seq` cursor.
- Authenticated + signed like all S2S traffic.
- Only the origin serves canonical history. Remote servers store only what was delivered to their users (plus what they backfilled). This is the **email/XMPP model**, explicitly not Matrix's full-replication model.

---

## 11. Federation Flows

### 11.1 Create a cross-server thread

```
Alice@soms.io wants to chat with Bob@other.com.

1. Alice's client → her server: "create thread with @bob@other.com"   (existing SOMS flow, like friend-add)
2. soms.io: creates local Thread, origin=soms.io, federated id thr_8x3k@soms.io
3. soms.io: resolves other.com via /.well-known/soms, verifies peer trusted
4. soms.io → other.com /api/s2s/inbox:
     { type: "thread.invite", thread: "thr_8x3k@soms.io",
       from: "@alice@soms.io", to: ["@bob@other.com"], ... }
5. other.com: verifies Bob exists, creates local Thread record pointing to the federated id
6. other.com: pushes to Bob's client via existing SSE NEW_THREAD mechanism
7. Both directions now exchange `message` envelopes over the durable channel
```

### 11.2 Send a message

```
1. Alice's client → soms.io: send message (existing HTTP write)
2. soms.io: stores Message, assigns ULID id + origin_seq
3. soms.io: pushes to local participants via existing SSE NEW_MESSAGE     (unchanged)
4. soms.io FederationService: identifies remote participants in the thread
5. soms.io → each remote /api/s2s/inbox: { type: "message", ... }
6. remote server: dedupes by (origin, id), stores, pushes to its local participants via its own SSE
```

Step 3 is unchanged SOMS behavior. Federation is purely additive — appended after the existing local push.

### 11.3 Add a remote participant to an existing thread

Group growth. A new `thread.invite` envelope addressed to the new participant triggers backfill (§10) on their server so they see prior history.

---

## 12. v0.1 Scope

### In scope

- `message` envelopes, durable channel, between two trusted SOMS instances.
- `thread.invite` flow for 1:1 and group thread creation across servers.
- History backfill from origin.
- Ed25519 + HTTP Signatures + allow-list trust.
- At-least-once delivery with idempotent dedup and exponential-backoff retry.
- Admin-managed peer allow-list.

### Deferred (explicit non-goals for v0.1)

- **E2EE** — envelope reserves the slot; crypto design is a separate effort.
- **Presence / typing** — ephemeral channel, v0.2.
- **Read receipts across federation** — durable `receipt` envelope type is reserved; delivery logic v0.2.
- **Media federation** — remote clients fetch from origin via the existing `/uploads/* + media_token` cookie pattern (signed URL hand-off). No media replication.
- **Open federation / anti-spam** — allow-list only.
- **Bridges to Matrix / XMPP / ActivityPub** — separate adapter services, own spec.
- **Identity portability** — `@user@domain` is bound to its server in v0.1. Key-rotation + forwarding records are a future hardening pass.
- **Multi-device sync across servers** — each server handles its own user's devices; the protocol federates at server granularity only.

---

## 13. Mapping to SOMS Architecture

Federation is a thin additive layer. The existing client-side kernel, SSE worker, and message content schema change nothing.

### 13.1 Schema changes (Prisma)

```prisma
// Existing MessageThread gains:
model MessageThread {
  // ... existing fields
  origin       String   @default("local")   // "local" | <origin-domain>
  federatedId  String?                       // thr_xxx@origin, null for local-origin
}

// New: trusted remote servers
model FederatedPeer {
  domain       String   @id
  serverKey    String                        // ed25519 public key, base64
  keyId        String
  trustLevel   String   @default("pending")  // pending | trusted | blocked
  addedBy      String?
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime?
}

// New: outbound delivery queue
model S2SOutbox {
  id           String   @id @default(cuid())
  envelopeId   String                        // origin message id
  threadId     String
  recipientDomain String
  payload      Json                          // the full envelope
  status       String   @default("pending")  // pending | in_flight | delivered | dead
  attempts     Int      @default(0)
  nextRetryAt  DateTime?
  lastError    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

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

### 13.2 New endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/s2s/inbox` | Receive envelopes from trusted peers |
| `GET` | `/api/s2s/threads/:id/messages` | Backfill history (origin only) |
| `GET` | `/.well-known/soms` | Publish server key + endpoints |

### 13.3 New services (NestJS)

- `FederationService` — hooked at the tail of the message-send pipeline. Identifies remote participants, writes `S2SOutbox` rows, fans out.
- `S2SOutboxWorker` — background poller. Drains `pending` rows, signs + POSTs, applies backoff.
- `InboxHandler` — verifies signature, checks `FederatedPeer`, dedupes via `S2SInboxSeen`, routes by `type`.
- `SignatureService` — Ed25519 sign/verify + HTTP Signature header construction.
- `DiscoveryService` — fetches + caches `/.well-known/soms`.

### 13.4 Existing code touched

- `message.service.ts` — append `FederationService.dispatch()` call after the existing local SSE push.
- `MessageThread` creation path — populate `origin` / `federatedId` when creating cross-server threads.
- Admin console — add a "Federation peers" management screen.

---

## 14. Open Questions (resolve before v0.1 freeze)

1. **Identity format** — confirm `@localpart@domain` vs a scheme that decouples user handle from server (e.g. portability-friendly). v0.1 leans to `@localpart@domain` for simplicity.
2. **`origin_seq` allocation** — per-thread counter on origin, or per-server global counter. Per-thread is more natural for chat; confirm no read-after-write hazards across threads.
3. **Thread participant roster authority** — does the origin server hold the canonical participant list, or does each server track its own? Leaning: origin is canonical for the roster; servers track their local users' membership locally.
4. **Backfill authorization granularity** — any trusted peer, or only peers that have a local user in the thread? Leaning: the latter (proof of membership).
5. **Retry budget** — exact backoff schedule and dead-letter policy.
6. **Admin approval UX for new peers** — out-of-band key verification flow.

---

## 15. References

- **ActivityPub** (W3C) — delivery model inspiration. https://www.w3.org/TR/activitypub/
- **HTTP Signatures** — request authentication. https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures
- **WebFinger** (RFC 7033) — discovery pattern. https://www.rfc-editor.org/rfc/rfc7033
- **ULID** — sortable unique identifiers. https://github.com/ulid/spec
- **Ed25519** (RFC 8032) — server keypairs. https://www.rfc-editor.org/rfc/rfc8032
- **IETF MIMI** (More Instant Messaging Interoperability) — watch for alignment opportunities, do not depend on. https://datatracker.ietf.org/wg/mimi/documents/
- **XMPP** (RFC 6120) + XEP-0313 (MAM), XEP-0045 (MUC), XEP-0384 (OMEMO) — IM semantics reference, not conformance target.
