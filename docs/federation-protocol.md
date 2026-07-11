# SOMS Federation — Protocol & Deployment Guide (v0.1)

> **Status:** Source of truth for both protocol integrators and node operators.
> **Scope:** Server-to-server (S2S) federation for SOMS IM threads.
> **Last updated:** 2026-07-10

---

## 0. Read this first — what SOMS federation is, and is not

> **What is built.** Three steps, all shipped and covered by the dual-process dual-DB e2e harness
> (`test/federation.e2e-spec.ts`, 22 cases of real signed S2S traffic):
> - **Step 1 — friend federation.** Cross-server **friendship** (`alice@soms.io` ↔ `bob@other.com`); on
>   approve each server owns its own 1:1 thread. Delivery is **synchronous** (sign + POST inline, no
>   outbox/worker). Avatars federate inline (base64). Trust via the auto-accepting **init handshake** +
>   a full **trust lifecycle** (trusted → demoted → re-handshake), observable from the admin console.
> - **Step 2 — 1:1 cross-server messages + media.** Light-notify + active **pull** over
>   `GET /api/v1/s2s/messages` (per-`(thread, sender)` `originSeq` cursor + dedup) — NOT a POSTed
>   payload, NOT an outbox/worker. Images localize via the CAS path; large files stream over
>   `Range`/206 on `/get_file`. Authoritative design: `docs/federation-step2-design.md`.
> - **Step 3 — cross-server groups (origin-hub).** The origin server is the single authority for roster
>   AND message history: a member signals the origin, the origin pulls + aggregates + re-signals,
>   members pull the whole thread from the origin. Unified `/s2s/invite` (friend + group); lazy roster
>   meta-pull; group-invite chat card; leave. Authoritative design: `docs/federation-step3-design.md`.
>
> **What is NOT yet built (deferred).** Presence/typing (v0.2, best-effort ephemeral — lossy, no retry),
> read receipts (v0.2, a separate item — NOT best-effort, delivery is wanted), group
> **rename/avatar/description** sync, a durable **active-liveness** leave backstop, origin death/re-homing,
> and per-peer **quota** enforcement (`docs/federation-quotas.md`). **Edit/delete propagation is a
> non-goal**, not deferred — the origin has no authority over receiver-local data once delivered (§9).
> These are flagged inline as **Deferred**. The per-section "Future" headers below that predate Steps 2/3
> are retained as historical design notes — read them as **implemented** per the step-design docs unless
> marked Deferred.

SOMS federation lets two independently deployed SOMS instances exchange messages across their users — **like email, but for chat.** This document is the single reference for anyone who wants to **integrate with** a SOMS node (Part I) or **deploy** one (Part II).

### Honest naming (do not mislabel)

SOMS federation is **transport-encrypted**, not end-to-end encrypted.

- ✅ Say: "transport-encrypted federation", "TLS in transit", "server-to-server encrypted channel".
- ❌ Do **not** say: "end-to-end encrypted", "encrypted chat", "private messaging", "E2EE".

**Why the distinction matters:** TLS protects the wire (client↔server, server↔server). It does **not** protect messages from the server operators. When Alice `alice@soms.io` messages Bob `bob@other.com`, **both `soms.io` and `other.com` see the plaintext.** Any server admin, any database compromise, any legal compulsion on either server exposes the content. This is the email / Mastodon / Slack model — a legitimate, widely-used model — but it is not the security property users associate with "encrypted chat" (Signal/WhatsApp). The protocol leaves room for a future E2EE layer on the message-pull response, but v0.1 ships **TLS only**. Never advertise v0.1 as E2EE.

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
6. **Sync delivery in Step 1.** Friend-op payloads are signed + POSTed **inline** (synchronously, 10 s timeout) — no outbox, no worker, no retry queue. Friend ops are idempotent, so a peer that's down makes the action fail and the user retries safely (the receiver dedupes via `S2SFriendOpSeen`). A durable outbox + retry worker (the "durable channel") revive **only if Step 2 messages** need reliable cross-server delivery; until then sync is the only channel. Ephemeral presence/typing (best-effort) is v0.2.
7. **No global ordering, ever.** Sort within a thread by `(ts, origin_seq)` (Step 2). Accept eventual consistency. **This line is never crossed** — anything requiring a DAG, vector clocks, or state resolution is out of scope forever.

### Non-goals (v0.1)

- **Not** conforming to Matrix / XMPP / ActivityPub. Bridges are separate adapter services.
- **Not** end-to-end encryption across federation. `content` is reserved opaque for a future E2EE effort.
- **Not** open federation. Peers must be explicitly trusted, **and** users must be friends before any communication.
- **Not** global ordering, DAG-based state resolution, or strong consistency.
- **Not** remote edit/delete of delivered messages. The origin's authority ends at delivery — once a peer
  pulls + stores a message it is that receiver's local data (the delivered-immutability / email model).
  A local edit/delete stays local; a deleted-by-sender message is a gap on the receiver, never a
  remote-driven tombstone. (See `docs/federation-step2-design.md` §9.)

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
| **User address** | Identity = a `{account, domain}` pair (e.g. `{account:"alice", domain:"soms.io"}`). The `alice@soms.io` form is a **UI input aid only** — the client splits it before any API call (§3.1). DNS-discoverable by `domain`. |
| **User stub** | A remote user is represented locally as a `User` row with `domain = <peer-domain>` (local users carry the `"local"` sentinel — never exposed; display uses the real `config.domain`). `@@unique([account, domain)]` enforces both local and stub uniqueness (a local "bob" does not block "bob@bbb.com"). Friendship and thread participation reference these stubs like any local user. |
| **Friend edge** | A bidirectional friendship between two users (`Friendship`, one normalized row per pair + `requesterId` for direction). **The access primitive:** no 1:1 thread exists between two users without one. Replicated on both servers via the `friend-request` / `friend-approve` endpoints; carries an optional ≤255-char `reqMessage`. |
| **Thread (Step 1)** | A bounded conversation. In Step 1, **each server owns its own local 1:1 `MessageThread`** for a federated pair on approve — there is **no shared federated thread id** (the `thr_<rand>@<origin-domain>` form returns only for federated **groups**, Step 3). 1:1 messages (Step 2) route by `fromAccount`/`toAccount` → `Friendship` → the local thread. |
| **Trust lifecycle** | `FederatedPeer.trustLevel`: `pending → trusted → demoted → trusted…` (+ `blocked` = admin intent). A trusted peer whose signed op fails is immediately demoted and re-handshakes on next contact (self-healing). Append-only `FederatedPeerEvent` records every transition (§5.2). |
| **Message / Receipt** | **Message:** shipped in Step 2 (cross-server, via `GET /messages` pull + `originSeq` dedup). **Receipt:** v0.2, not shipped. |
| **Thread membership** | The canonical access gate at the friend-op endpoint: **you only receive friend ops for relationships you are a party to.** For 1:1, membership is the friend edge; for groups (Step 3), the local roster. |

---

## 3. Identity & discovery

### 3.1 Federated identifiers

A user address is a **pair of fields — `account` + `domain`** — never an `@`-joined string on the wire:

```
address := { account, domain }    // e.g. { account: "alice", domain: "soms.io" }
```

`account` is the peer's `account`; `domain` is the peer server. The friend-op payloads' `from`/`to` carry these as objects (`{account, domain}`), and the resolve endpoint is `/users/:account`. The `@` separator is a **UI input aid ONLY** — a user types `alice@soms.io` in the search box, the client splits it into the two fields before any API call, and no `@`-joined string ever crosses the wire or appears in a backend definition. (SOMS local `account`s never contain `@`, so the client split is unambiguous.)

> **Account grammar is specified separately** in [`docs/account-naming.md`](./account-naming.md) — the single source of truth for the `account` charset, the `!` group sigil, dot rules, and case handling. There are two account classes: **users** (letters + digits + `.`, must start with a letter) and **groups** (`!`-prefixed opaque ids), distinguished by grammar. A group address on the wire is `{ account: "!01hz...", domain: "soms.io" }`.

> **The federated address is immutable — both halves, for life.** Neither field of `{ account, domain }`
> ever changes after creation. The `account` half is set once at registration / group-create and is
> **never renamed** ([`docs/account-naming.md`](./account-naming.md) §7 — renaming is forbidden at the
> identity layer, not merely unimplemented: it would orphan every peer's remote stub and free the old
> account for re-registration / impersonation). The `domain` half is fixed because `user@domain` is
> bound to its server in v0.1 (identity portability is a deferred non-goal, §10). A user is therefore
> `{ account, domain }` for life; there is **no rename and no re-homing operation on the wire.**

> **Federated thread identity** (shipped): a federated **group** is addressed by its own `!account` (stored as `MessageThread.groupUser.account`, minted on group create, globally unique — the same value on the origin and every mirror, never the DB thread id); 1:1 threads have no shared id (each server owns its own local thread). A message's cross-server identity is the `(creator, originSeq)` pair (Step 2), not a UUID.

### 3.2 Discovery — layered

Discovery resolves "where is the SOMS service for `<domain>`?" in two layers:

1. **SRV record (optional):** look up `_soms._tcp.<domain>`. If present, it gives the **host:port** (and priority/weight for multi-server deployments; selection algorithm in §6.3).
2. **Fallback:** if no SRV, use `https://<domain>:443`.
3. **`.well-known/soms` (required):** at the resolved host:port, fetch the rich endpoint/key metadata over HTTPS.

```
GET https://<resolved-host>:<port>/.well-known/soms
→ 200 OK
Content-Type: application/json

{
  "software": "soms/0.1",
  "keys": [
    { "keyId": "soms.io/key-1", "ed25519": "<base64-public-key>" }
  ]
}
```

S2S endpoint paths (`friend-request`, `friend-approve`, `users/:account`, `messages`, …) are **not** published here — peers derive them from the resolved base URL as `${base}/api/v1/s2s/<path>` (the same way the Step 2 pull routes are resolved). `keys` is a **JWKS-style list** (one entry per currently-published signing key, identified by `keyId`); multiple entries coexist during key rotation (§5.1). Verifiers **fetch a peer's key on `keyId`-miss** and cache it with a TTL — they do **not** pin keys (§5.1 explains why fetch-over-HTTPS beats both pinning and DNS-distribution).

### 3.3 Why SRV, not TXT, for host:port

- **SRV** (RFC 2782) is purpose-built for service location: typed fields (priority, weight, port, target), native multi-server failover/load-balancing, understood by every DNS library and operator.
- **TXT is for policy/verification** (SPF/DKIM/DMARC/`_acme-challenge`), not service location. Putting port/version in TXT means inventing a format, parsing it yourself, and re-inventing priority/weight.
- **Version belongs in the live HTTPS endpoint** (`.well-known/soms`), not DNS — DNS TTL caching would make a version field stale after upgrades and create two sources of truth.

See Part II §D2 for SRV record format and configuration.

---

## 4. Wire format (payload)

> **Step 3 Phase A unification (2026-07-09):** add-friend and add-group now share ONE endpoint —
> `/s2s/invite` (deliver, `kind` FRIEND|GROUP) + `/s2s/invite-accept`. The earlier
> `/s2s/friend-request` + `/s2s/friend-approve` + `/s2s/thread/invite` are removed. The `kind` field on
> `S2SInvite` is the discriminator (FRIEND carries `profile`; GROUP carries the group identity + a
> revision). See `docs/federation-s2s-api.md` for the canonical shapes. The friend-flow narrative below
> (§4.1) still describes the FRIEND semantics; read "POST /s2s/invite {kind:FRIEND}" for the old
> `/friend-request` and "POST /s2s/invite-accept {kind:FRIEND}" for `/friend-approve`.

Every POSTed friend op is a plain-JSON body signed via RFC 9421. The shared base body is:

```json
{
  "id": "01J8X3KF7Q9P2R...",
  "origin": "soms.io",
  "from": { "account": "alice", "domain": "soms.io" },
  "to": [{ "account": "bob", "domain": "other.com" }],
  "ts": 1719500000000
}
```

`friend-request` adds the sender's profile + an optional note so the receiver can create the stub localized
inline (no nested fetch); `friend-approve` is the bare base (pure state confirmation — §4.1):

```json
// POST /api/v1/s2s/friend-request
{ "id": "...", "origin": "soms.io", "from": { "account": "alice", "domain": "soms.io" },
  "to": [{ "account": "bob", "domain": "other.com" }], "ts": 1719500000000,
  "message": "hi",
  "profile": { "account": "alice", "domain": "soms.io", "displayName": "Alice",
               "avatar": { "b64": "...", "w": 512, "h": 512 }, "bio": "", "updatedAt": 1719500000000 } }

// POST /api/v1/s2s/friend-approve
{ "id": "...", "origin": "other.com", "from": { "account": "bob", "domain": "other.com" },
  "to": [{ "account": "alice", "domain": "soms.io" }], "ts": 1719500000000 }
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Origin-assigned ULID. Globally unique, time-sortable. Immutable. The idempotent-dedup key (with `origin`) via `S2SFriendOpSeen`. |
| `origin` | yes | Origin server domain. |
| `from` | yes | Sender address: `{ account, domain }` (split fields — never an `@`-joined string). |
| `to` | yes | Recipient addresses: `[{ account, domain }, ...]`. The recipient server resolves which are local. |
| `ts` | yes | Origin timestamp, ms since epoch. |
| `message` | `friend-request` only | ≤255-char note/reason. Human-readable accompanying text. |
| `profile` | `friend-request` only | The sender's public profile (`{ account, domain, displayName, avatar, bio, updatedAt }`) embedded so the receiver creates the stub localized, inline (avatar is `{ b64, w, h }` per §10.1, or null). `updatedAt` is stored as the stub's `remoteUpdatedAt` for the staleness probe. `friend-approve` does NOT carry a profile — it's a pure state confirmation (§4.1). |

> **No `message` payload type.** Step 2 cross-server messages do **not** travel as a POSTed payload — they
> travel in the response of a signed `GET /api/v1/s2s/messages` (active pull), gated by friendship +
> `originSeq` idempotency (`docs/federation-step2-design.md`). The earlier "durable message envelope"
> design (`type: message`, `durability`, `origin_seq`, `thread`, `prev`, `client_message_id`, opaque
> `content`) was the rejected push alternative. There is no `type` / `durability` field on the wire, and
> `content` is not a payload slot — a future E2EE layer, if ever added, would live on the pull-response
> message shape, not on these friend-op bodies.

### 4.1 Friend-op endpoints

| Endpoint | Carries | Notes |
| --- | --- | --- |
| `POST /friend-request` | `from` → `to` | "Alice wants to add Bob." Carries the sender's `profile` (avatar inline as base64 — §10.1): the target has no stub of the requester yet, so the profile is REQUIRED to create the stub and render the request card. Delivered to Bob's server, surfaced as a friend request to Bob. |
| `POST /friend-approve` | `from` → `to` | "Bob accepted." Pure state confirmation — carries **no** profile. The requester already resolved + localized the approver's stub before sending the request; any later profile change is picked up lazily by the chat-open `/revision` probe (§10.1). Both servers materialize the friend edge and **each creates its own local 1:1 thread** (no `thread.invite` in Step 1; that returns only for federated groups, Step 3). |

Asymmetry is intentional: `friend-request` must carry the profile (stub creation), `friend-approve` need
not (the stub already exists; freshness is the chat-open probe's job, which also covers the request→approve
window).

There is deliberately **no `friend-delete` endpoint** — unfriending is local-only; the peer discovers the
severed edge lazily via rejection-on-send (§9.4). This mirrors SOMS's `FRIEND_REQUEST` / `FRIEND_APPROVED`
client SSE events (federation adds the S2S delivery layer); `FRIEND_DELETED` remains a local-only event.

---

## 5. Trust & access control

There are **two gates. Both must pass** for any communication:

### Gate 1 — Trusted peers (the allow-list)

```
FederatedPeer
  domain            PK     # e.g. other.com  (WHICH domains we federate with)
  trustLevel               # pending | trusted | demoted | blocked
  addedBy                  # admin who set the state, or null = auto-accepted via init
  createdAt                # first discovered
  trustedAt                # start of the current trust epoch (reset on re-trust after demote)
  lastSuccessAt            # last successful signed S2S op (liveness; advanced every GET/POST ok)
  demotedAt                # last trusted→demoted transition
  demoteReason             # latest failure message (cleared on re-trust)
  demotionCount            # flakiness signal
  blockedAt                # admin block time
```

`FederatedPeer` is a **trusted-domain registry** — it records *which* domains are trusted and their current lifecycle state, not their keys. Signing keys are fetched from each peer's `/.well-known/soms` on demand and TTL-cached (§5.1). Inbound requests are accepted **only** from domains with `trustLevel = trusted` **and** a valid signature over a key the peer currently publishes; `demoted`/`pending`/`blocked` are rejected at the guard. No open-federation path. Domains enter `trusted` via the **init handshake** (§D7) — user-triggered, auto-accepting (no manual allow-list step). The full lifecycle is in §5.2.

### Gate 2 — Thread membership (the friend gate)

At the friend-op endpoint, every friend op is gated by relationship. In Step 1 a `friend-request` / `friend-approve` is accepted only for a real local recipient; in Step 2 a message pull (`GET /messages`) is rejected unless **Bob is a member of that thread** (for 1:1, membership is exclusively a prior friend edge). This is the user-controlled gate that makes "trust the server" acceptable:

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

### 5.2 Trust lifecycle (state machine + audit log)

`trustLevel` is a small state machine; `FederationService` owns **all** transitions so the row and the event log stay consistent:

```
pending ──init ok──▶ trusted ◀──re-handshake── demoted
                       │                           ▲
                  (op fails:                     │
                   cert/key/network) ─────────────┘
trusted/pending/demoted ──admin──▶ blocked ──admin──▶ pending (must re-handshake to re-trust)
```

- **`markTrusted(domain)`** — single source for trust establishment (used by outbound `ensurePeerTrusted` and inbound `S2sInitController`). Creates `trusted` + `discovered`/`trusted` events on first contact; promotes `pending`/`demoted` → `trusted` (reset `trustedAt`/`lastSuccessAt`, clear demote cols, event `trusted`); refreshes `lastSuccessAt` only if already trusted (idempotent, no event). **No-op for `blocked`** (admin intent wins).
- **`markContactSuccess(domain)`** — advances `lastSuccessAt` on every successful signed op (`postSigned`/`getSigned`). Throttled: an in-memory per-domain guard skips the DB round trip within a 60 s window, and a conditional `UPDATE … WHERE lastSuccessAt IS NULL OR older-than-window` keeps it correct across restart + multi-instance. Precision is deliberately coarse (~±1 min) — liveness needs minute, not sub-second, granularity, and this avoids a write per message in Step 2.
- **`markDemoted(domain, reason)`** — on any failed signed op to a trusted/pending peer (network/timeout/cert/key), flip to `demoted`, `demotionCount++`, refresh `demotedAt`/`demoteReason`, **purge `S2SKeyCache` for the domain** (a rotated/stale key is the likely cause), and log a `demoted` event. **Self-healing:** the next `ensurePeerTrusted` sees non-trusted → re-runs the init handshake → `trusted` again.
- **`markBlocked` / `markUnblocked`** — admin intent. Block sets `blocked` + `blockedAt` + event; `ensurePeerTrusted` then throws `FEDERATION_PEER_BLOCKED` (50009) so the resolve surfaces "peer blocked." Unblock → `pending` (must re-handshake to re-trust).

Every transition is also written to an **append-only audit log**:

```prisma
model FederatedPeerEvent {
  id        BigInt   @id @default(autoincrement())
  domain    String   @db.VarChar(63)   // NO FK → FederatedPeer (decoupled: history survives any peer-row change)
  type      String   @db.VarChar(15)   // discovered | trusted | demoted | blocked | unblocked
  reason    String?  @db.VarChar(255)  // demoted: failure msg; blocked: optional admin note
  createdAt DateTime @default(now())
  @@index([domain, createdAt])
}
```

This current-state cache (`FederatedPeer`) + append-only history (`FederatedPeerEvent`) split is the standard pattern when you must show a *process*, not just a snapshot: columns alone collapse repeated trust↔demote cycles into the latest. The admin Federation page renders the per-peer timeline from these events (newest-first) — "let the admin see trust → connection-loss end to end."

---

## 6. Delivery

> **Friend ops = synchronous** (Step 1, unchanged). Friend-op payloads are signed + POSTed **inline** in the request path (`FederationService.send*`, 10 s `callTimeoutSec`). There is **no outbox, no worker, no retry queue** — a peer that's down makes the action fail, and the user retries (the receiver dedupes via `S2SFriendOpSeen`, so a retry is safe). **Step 2 messages do NOT use an outbox** — they use light-notify + active pull (§6.2 ⚠️); the durable outbox + retry worker below (§6.2, §6.3) remains an **unbuilt** design, retained as reference.

### 6.1 The S2S POST (sync, Step 1)

Sender-responsible push, mirroring email SMTP delivery — but synchronous:

```
POST https://<recipient-domain>/api/v1/s2s/friend-request
Content-Type: application/json
Content-Digest: sha-256=<base64 sha256 of body>
Date: <RFC 7231>
Signature-Input: sig1=("@method" "@path" "@authority" "date" "content-digest");keyid="<origin>/key-1";alg="ed25519";created=<unix-ts>
Signature: sig1=:<base64 ed25519 signature>:

Body: <payload>
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

### 6.2 Retry budget — unbuilt (design reference; Step 2 uses pull, not a queue)

> **Not built.** Step 2 chose light-notify + active-pull instead of an outbox (see ⚠️ below), so this schedule was never implemented. Retained as the design for a future tier that needs transactional delivery guarantees.
>
> ⚠️ **Step 2 was DECIDED as light-notify + active-pull — NO outbox/worker/dead-letter.** The sender's
> `Message` table is the source of truth; a tiny best-effort `message.notify` hints the peer, which
> **pulls** by cursor; a lost notify is caught by pull-on-thread-open + a slow poll. The retry budget
> below applies only to the (best-effort, 10s-timeout) notify, not to a queue. Authoritative design:
> `docs/federation-step2-design.md`. An outbox revives only if a future tier needs transactional
> delivery guarantees — and it would layer ON TOP of the pull model, not replace it.

Backoff schedule: **30s → 1m → 5m → 30m → 2h → 24h**, then **dead-letter** for operator inspection. Single-worker per `(thread, recipient-domain)` to preserve `origin_seq` order; parallelism across threads/domains is fine.

### 6.3 Outbound target & address selection

When the S2S client delivers a friend-op payload (the sync `FederationService` today; the outbox worker if it revives in Step 2), it selects where to connect in three layers. All three live in our own client code — we do **not** rely on Node's Happy Eyeballs (see "Why explicit racing" below).

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

## 7. Ordering & consistency (Step 2 — built)

> **Built (Step 2).** The rules below govern cross-server message ordering. Step 3 §5 refined the display rule: the **arrival time** (the receiver's local `now()` when a pulled message is stored) is what the chatbox shows and what orders the conversation list; `originSeq` (per-sender) is the cursor/dedup authority — never a global order. See `docs/federation-step3-design.md` §5.

- **Within a thread:** sort by `(ts, origin_seq)`. `ts` is the origin's clock; `origin_seq` (per-thread, monotonic on origin) breaks ties.
- **`origin_seq`:** allocated by a per-thread counter on the origin server. No cross-thread coordination.
- **Reply threading:** `prev` is display-only, not a DAG edge.
- **Edits/deletes:** last-writer-wins by `ts`; an edit is a new message with `edit_of` referencing the original. No merge semantics.
- **Clock skew:** tolerated at second granularity; ordering glitches are an accepted trade-off.
- **Roster authority:** the origin server holds the canonical participant list; each server tracks its own local users' membership locally.
- **No global ordering, ever.**

---

## 8. History backfill (Step 2/3 — built)

> **Built (Step 2/3).** Backfill is the SAME endpoint as incremental pull — `GET /api/v1/s2s/messages?after=0` is a full backfill; `after=<cursor>` is incremental. The ⚠️ below carries the authoritative path/param convention.
>
> ⚠️ **Step 2 makes backfill the SAME endpoint as incremental pull** — `GET /api/v1/s2s/messages?after=0`
> is a full backfill; `after=<cursor>` is incremental. No separate `/threads/:id/messages` route. See
> `docs/federation-step2-design.md` §3.2. The shape below (membership-gated, origin-served) still
> applies; only the path/param convention changed.

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

### 9.1 Cross-server friendship → each server's own 1:1 thread

```
Alice@soms.io wants to chat with Bob@other.com.

0. (first contact only) soms.io POST /api/v1/s2s/init → other.com: mutual trust established (§D7).
1. Alice's client → soms.io: "add friend bob@other.com"      (existing friend-request flow)
2. soms.io resolves {account:"bob", domain:"other.com"} (GET /api/v1/s2s/users/:account → stub on soms.io), then
   soms.io → other.com POST /api/v1/s2s/friend-request:
     { id, origin:"soms.io", from:{account:"alice",domain:"soms.io"}, to:[{account:"bob",domain:"other.com"}], ts, message, profile:{...} }
3. other.com verifies Bob exists; surfaces friend request to Bob (existing FRIEND_REQUEST SSE).
4. Bob approves.
5. other.com → soms.io POST /api/v1/s2s/friend-approve:
     { id, origin:"other.com", from:{account:"bob",domain:"other.com"}, to:[{account:"alice",domain:"soms.io"}], ts }
6. BOTH servers materialize the friend edge (Friendship APPROVED, Alice↔Bob stub) locally.
7. EACH server creates its OWN local 1:1 MessageThread for the pair on approve, and pushes
   NEW_THREAD to its own user. There is NO thread.invite and NO shared federated thread id.
```

**No `thread.invite` exists in Step 1.** Each server owns its own thread; a Step 2 message from Alice routes on `soms.io` by `fromAccount`/`toAccount` → `Friendship` → the local thread, and is delivered to `other.com` where it routes the same way to Bob's local thread. A shared federated thread id returns only for federated **groups** (Step 3).

### 9.2 Send a message (Step 2 — built; see step2-design)

> **Built (Step 2).** The ⚠️ SUPERSEDED note below carries the authoritative flow (light-notify + active-pull, NO `S2SOutbox`). The push flow retained below is the rejected alternative, kept as rationale.
>
> ⚠️ **SUPERSEDED — see `docs/federation-step2-design.md` for the authoritative Step 2 flow
> (light-notify + active-pull, NO `S2SOutbox`).** The actual flow: sender stores locally + allocates
> `originSeq` → best-effort `message.notify {latestSeq}` to the peer → the peer **pulls** the sender's
> side by cursor (`GET /api/v1/s2s/messages`) → stores + SSE to its user. The push flow below is the
> rejected alternative, retained as rationale for why pull was chosen.

```
1. Alice's client → soms.io: send message (existing HTTP write)
2. soms.io: store Message, assign ULID id + origin_seq
3. soms.io: push to local participants via existing SSE NEW_MESSAGE      (unchanged)
4. soms.io FederationService: identify remote participants; write S2SOutbox rows
5. soms.io → each remote /api/s2s/inbox: { type: "message", ... }
6. remote: dedupe by (origin, id), verify membership, store, push via its own SSE
```

Federation is purely additive — appended after the existing local push.

### 9.3 Cross-server group invite (Step 3 — built)

Group invites remain friend-gated: **the inviter and invitee must already be friends across servers** (consistent with local SOMS, where groups invite friends). A `thread.invite` addressed to the new participant triggers backfill (§8) on their server so they see prior history. Once a member, their access grant is thread membership — pairwise friendship with every other member is **not** required (matches local group semantics).

> **Group identity is bound to its origin domain for life, and ownership cannot cross domains.** A
> federated group's canonical roster + message authority is its **origin** server (the owner's home
> server) for the group's entire lifetime — there is **no operation to move the canonical thread to
> another server** (no re-homing; `originDomain` is invariant). Owner (admin) transfer is
> **local-only**: the owner may hand ownership only to another user on the **same origin server**;
> transferring ownership to a member on a *different* domain is **forbidden** (rejected by the backend,
> hidden in the UI), so the origin domain never changes. Authoritative detail in
> [`docs/federation-step3-design.md`](./federation-step3-design.md) §2 (Decision 2) and §7.6.

### 9.4 Unfriend

```
Alice removes Bob.
1. soms.io marks the friend edge deleted locally (soft-leaves both P2P participants, status → DELETED).
   NO S2S notification is sent — there is no friend.delete endpoint in this protocol.
2. other.com still believes the edge is alive — until it tries to use it. The next time Bob pulls
   messages from Alice, soms.io's /messages endpoint rejects it at the membership gate ("not friends"),
   which is Bob's signal that Alice unfriended him. other.com then tears down its local edge lazily.
```

Deletion is **local-only** by design: unfriending never fans out. This avoids a dedicated `friend.delete`
endpoint (and the reliability/retry burden of guaranteeing its delivery — a lost unfriend notice would
leave a dangling one-way edge forever). The cost is a one-message latency before the peer learns, which is
acceptable for a human-timescale, low-stakes signal. (1:1 thread history is retained read-only per existing
SOMS semantics; only new delivery is blocked.)

---

## 10. Schema (Prisma)

```prisma
// A remote user is a local User stub: domain = <peer-domain> (local users carry the "local" sentinel,
// never exposed — display uses the real config.domain). The compound unique key enforces BOTH local
// uniqueness and stub uniqueness (a local "bob" does not block "bob@bbb.com").
model User {
  // ... existing fields
  domain       String   @default("local") @db.VarChar(63)   // "local" | <peer-domain>
  @@unique([account, domain])
}

// MessageThread — Step 3 adds the federated GROUP identity: a `groupUser` (a `!`-sigil User — the
// group's own `!account`, @unique, one local mirror per federated group) carrying the account + the
// origin server's domain (groupUser.domain). NULL groupUserId for purely-local threads (all P2P,
// local-only groups); 1:1 threads still have no shared id.
// Message gains originServerTime (Step 2/3 — the sender clock, stored not shown; createdAt = arrival,
// displayed). See docs/federation-step3-design.md §3.

// Friendship: one normalized row per pair (userAId=min, userBId=max) + requesterId for direction.
// reqMessage is the ≤255-char friend-request note (local + federated). threadId is the P2P
// MessageThread, created on APPROVED — each server creates its OWN local thread.
model Friendship {
  // ... userAId, userBId, requesterId, status
  reqMessage  String   @default("") @db.VarChar(255)
  threadId    Int?
  @@unique([userAId, userBId])
}

// Trusted-domain registry + lifecycle state (Gate 1). Keys are NOT stored here — fetched from
// each peer's /.well-known/soms and cached in S2SKeyCache. See §5.2 for the state machine.
model FederatedPeer {
  domain        String   @id @db.VarChar(63)
  trustLevel    String   @default("pending") @db.VarChar(15)  // pending | trusted | demoted | blocked
  addedBy       String?  @db.VarChar(31)
  createdAt     DateTime @default(now())
  trustedAt     DateTime?
  lastSuccessAt DateTime?
  demotedAt     DateTime?
  demoteReason  String?  @db.VarChar(255)
  demotionCount Int      @default(0)
  blockedAt     DateTime?
  @@index([trustLevel])
  @@index([lastSuccessAt])
}

// Append-only audit log of every trust transition (NO FK → FederatedPeer; decoupled). The admin
// Federation page renders the per-peer timeline from this. See §5.2.
model FederatedPeerEvent {
  id        BigInt   @id @default(autoincrement())
  domain    String   @db.VarChar(63)
  type      String   @db.VarChar(15)   // discovered | trusted | demoted | blocked | unblocked
  reason    String?  @db.VarChar(255)
  createdAt DateTime @default(now())
  @@index([domain, createdAt])
  @@index([createdAt])
}

// Cached peer signing keys (fetched from /.well-known/soms, TTL'd; JWKS-style; multiple rows per
// domain during rotation).
model S2SKeyCache {
  domain     String   @db.VarChar(63)
  keyId      String   @db.VarChar(127)
  publicKey  String   @db.VarChar(127)
  fetchedAt  DateTime @default(now())
  @@id([domain, keyId])
  @@index([domain])
}

// Inbound dedup: at-least-once delivery, idempotent apply. Step 1 sync delivery still benefits —
// a user retry of a friend op re-POSTs the same payload and is absorbed here.
model S2SFriendOpSeen {
  origin      String   @db.VarChar(63)
  opId        String   @db.VarChar(127)
  receivedAt  DateTime @default(now())
  @@id([origin, opId])
}

// NOTE: there is NO S2SOutbox in Step 1 (sync delivery). It revives in Step 2 if durable
// cross-server message retry is needed — see §6.2 for the planned shape.
```

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/s2s/init` | Trust-establishment bootstrap (auto-accept; NOT allow-list-gated — §D7) |
| `POST` | `/api/v1/s2s/invite` | **Unified** invite (friend OR group, `kind`-discriminated) from a trusted peer (allow-list-gated) |
| `POST` | `/api/v1/s2s/invite-accept` | The peer accepted an invite (friend→P2P thread; group→origin records the join) |
| `GET` | `/api/v1/s2s/group/:account/roster` | The origin serves the canonical roster (lazy meta-pull on chat-open) |
| `GET` | `/api/v1/s2s/users/:account` | A local user's public profile (avatar inline as base64 — §10.1). A group is a `!`-User, so this also serves a group's identity |
| `GET` | `/api/v1/s2s/users/:account/revision` | Lightweight profile-revision probe (staleness check, no avatar). For a group `!`-User this is the meta revision |
| `GET` | `/.well-known/soms` | Publish server keys + endpoints |

> The earlier `/s2s/friend-request` + `/s2s/friend-approve` + `/s2s/thread/invite` + `/s2s/thread/member`
> are removed (unified into `/s2s/invite` + `/s2s/invite-accept`; roster propagation is lazy pull, not
> push fanout). See `docs/federation-s2s-api.md`.

### Services (NestJS)

- `FederationService` — owns **all** peer-lifecycle state transitions AND the sync outbound path: builds + signs + POSTs payloads inline (`postSigned`/`getSigned`), advances `lastSuccessAt` on success, demotes on failure. Step 3 Phase A: the unified invite handlers (`handleInvite`/`handleInviteAccept` — friend + group) + the lazy roster meta-pull (`syncGroupMetaIfStale` + `serveGroupRoster`) live here. Admin reads (`listPeers`/`peerEvents`) + the consumer pre-flight (`isPeerTrusted`) too.
- `S2sVerifyService` — shared keyId-parse + `.well-known` key fetch + RFC 9421 signature verify (used by both the init endpoint and the S2S guard).
- `S2sSignatureGuard` — the S2S allow-list gate: rejects `trustLevel !== 'trusted'`, then verifies the signature (fetches key on `keyId`-miss, §5.1).
- *(The standalone `FriendOpHandler` was folded into `FederationService.handleInvite`/`handleInviteAccept` when the S2S surface was unified.)*
- `SignatureService` — Ed25519 sign/verify; RFC 9421 `Signature-Input`/`Signature` construction (DKIM-model, §5.1).
- `DiscoveryService` — SRV + `.well-known/soms` resolution + caching.

### 10.1 Avatar federation (implemented, v0.1)

A user's avatar crosses servers **inline as base64**, never by cross-origin URL (CSP blocks the receiving client from fetching the peer's `/uploads/*`, and a URL would leak the peer's media-token path). The wire shape is `{ b64, w, h }` — base64 of the source image bytes plus the source pixel dimensions (the receiver does **not** assume square). It rides in two places:

- the S2S profile response `GET /api/v1/s2s/users/:account` (the resolve endpoint), and
- the `profile` slot on the friend-request payload (§4.1), so the receiver creates/refreshes the stub localized, with no second round-trip and no nested S2S call inside the handler. (`friend-approve` carries no profile — §4.1.)

**Recommended transmission size is 512×512 webp** (~40 KB → ~55 KB base64) — the largest size a local upload stores. The receiver runs the bytes back through the standard avatar pipeline (`saveAvatars` center-crops to the 32/64/128/256/512 set), so a federated avatar is byte-identical on disk to a locally-uploaded one and is served **same-origin** via the existing `/uploads/*` path + media-token cookie. Non-square sources are center-cropped to the largest square; smaller than 512 risks upscaling blur; larger wastes wire for a low-frequency, idempotent fetch. The declared `w`/`h` get a cheap pre-validation, but `sharp`'s own metadata read is the authoritative pixel-bomb check (a compromised peer can't lie past it). The global Fastify `bodyLimit` (1 MiB) accommodates the payload with headroom.

**Staleness** — the receiver stores the profile's `updatedAt` as the stub's `remoteUpdatedAt`. On chat-open, a lightweight probe `GET /api/v1/s2s/users/:account/revision` returns just `{ updatedAt }` (no avatar transfer); if newer than `remoteUpdatedAt`, the server re-pulls the full profile + re-localizes (best-effort — a transient peer outage keeps the cached profile). `localizeForeignProfile` is idempotent and gated on the revision, so re-delivered payloads and no-change re-pulls do no work; a corrupt/oversized avatar is isolated (name/bio/remoteUpdatedAt still advance, the existing avatar is kept) so a broken avatar can't break friend-flow. Local users are always fresh locally (no probe).

**No approve-time refresh** — `friend.approve` carries no profile and triggers no re-pull on either side. The requester's stub of the approver was created at resolve time; any profile drift (across the request→approve window or later) is caught uniformly by the chat-open probe. This keeps `approve` a pure state-confirmation and avoids a redundant avatar transfer + a nested S2S call inside the handler.

Avatars are the **only media that federates in v0.1** — message-image federation (album/file photos **in chat**) is a separate, larger step (see Deferred below + `docs/federation-quotas.md`).

### Deferred (explicit non-goals for v0.1)

- **E2EE** — `content` reserved; crypto is a separate effort.
- **Presence / typing** — ephemeral, v0.2 (lossy, carry no `id`, never retried).
- **Read receipts across federation** — `receipt` type reserved; logic v0.2.
- **Message media federation** — album/file images in chat are NOT replicated in v0.1; deferred to a later media step (avatars in §10.1 are the exception). Per-peer **quotas** for that future step are designed (daily message/image/file limits + size caps, admin-adjustable) but also deferred — see `docs/federation-quotas.md`.
- **Open federation / anti-spam** — allow-list only.
- **Bridges to Matrix / XMPP / ActivityPub** — separate adapter services.
- **Identity portability** — `user@domain` is bound to its server in v0.1.
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

Your federation identity is `<your-account>@<your-domain>` (email form — no leading `@`; `<your-account>` is your SOMS `account`). The domain in every address below is the domain whose DNS zone you control.

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

TXT is **not** for service location. Its legitimate role here is **domain ownership verification**, should you add a DNS-based proof step to peer approval later (optional; v0.1 trust = the auto-accepting init handshake §D7, keys fetched over HTTPS per §5.1, OOB fingerprint as optional hardening). Do not encode port/version in TXT.

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

1. **SOMS races address families explicitly** in its S2S client (§6.3) — it does **not** depend on Node's Happy Eyeballs, which is incomplete and has known `ETIMEDOUT` failure modes. Node 22+ remains the runtime baseline. (So the "~250ms" row in the table above is what SOMS achieves by its own implementation, not by trusting Node's HE.)
2. **At the DDNS layer, publish AAAA only if v6 is genuinely reachable end-to-end.** Your DDNS updater should probe v6 reachability before publishing AAAA. If in doubt, **publish only A** and skip v6 entirely — simplest and bulletproof.

### Inbound (server side)

Bind SOMS to all interfaces and both families so peers reach you on whichever IP DNS returns. In Node, bind `::` with `ipv6Only: false` (one socket covers v4 + v6 and every network interface/IP on the host), or bind `0.0.0.0` for v4-only-all-interfaces. The same dual-stack listener also covers **multi-IP hosts** — multiple v4 addresses, multiple AAAA, or multiple NICs — accepting connections on all of them with no extra config. Ensure your firewall allows inbound on the SRV port for every family/IP you publish.

## D7. Adding a federation peer — the init handshake

Trust between two SOMS servers is established by an **explicit server-to-server init handshake BEFORE any
friend-op traffic**, not by a manual admin allow-list step. It is **user-triggered and auto-accepting** in v0.1:

1. **A's user** searches `bob@other.com` (an address on a domain A doesn't yet trust).
2. **A** fetches `other.com/.well-known/soms` over HTTPS (SRV/HTTPS discovery; TLS-protected + CA-validated, so the published `keys` are trustworthy as-is).
3. **A** sends a signed `POST /api/v1/s2s/init` to `other.com`. The signature (over the request's content-digest) + keyId is what proves A controls its domain — `other.com` fetches **A's** `.well-known` to verify (no inline key; `.well-known` is authoritative so A can't lie).
4. **`other.com` auto-accepts**: it verifies A's signature (§5.1 key fetch) and upserts A into its `FederatedPeer` `trusted`. A does the symmetric upsert for `other.com`. Mutual trust now exists.
5. The resolve + `friend.request` proceed (both Gate 1 allow-lists pass).

`POST /api/v1/s2s/init` is the one endpoint **not** behind the allow-list gate (`S2sSignatureGuard`) — it IS
the trust-establishment step, so gating it would be circular. It verifies via `S2sVerifyService` directly
(the same keyId-parse + `.well-known` key fetch + signature verify the friend-op guard uses, minus the
allow-list check). The "accept" step is a single swappable site for future admin-approval / deny-list /
reputation gating (reserved hook; v0.1 = `auto`).

**v0.1 = AUTO-ACCEPT.** Any SOMS peer whose init signature verifies is trusted. The real abuse barrier is
the **friend gate (Gate 2)** — a connected peer can only send friend REQUESTS the local user must approve;
there is no message read access without an approved friend edge, so server-level auto-accept is contained.
The reverse direction (their user searches one of ours) is covered by our `/init` endpoint auto-accepting
them; a re-init (e.g. after a genuinely broken key, not normal rotation) just re-runs the handshake.

Only after both sides are `trusted` does any friend op flow — in Step 1 that's `friend-request` / `friend-approve`; `message`
(Step 2) and `thread.invite` (Step 3) follow the same gate when they ship. **Key rotation does not
require re-init** — it's handled silently by `.well-known` republishing + the proactive key-refresh
worker (§5.1).

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
[ ] Ed25519 S2S signing key persisted + backed up (loss = full re-init)
[ ] Peer trust = automatic via the init handshake (§D7); no manual allow-list step needed
[ ] dig SRV _soms._tcp.<domain> +short returns expected record
```

Once two nodes complete this checklist, `friend.request` between their users creates the first cross-server friendship, and the durable channel carries messages from there.
