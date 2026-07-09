# SOMS Federation — Step 3 Design (cross-server groups)

> **Status:** designed, **not built.** Builds directly on Step 2 (`docs/federation-step2-design.md`),
> whose cross-server 1:1 message transport (per-sender `originSeq` cursor + light-notify push +
> active pull + per-object media authz) is reused **verbatim**. This doc supersedes the 3-line sketch
> at `federation-protocol.md` §9.3.
>
> **Scope:** cross-server **GROUP** threads — a group whose owner lives on server A and whose members
> span servers A, B, C … . Owner is created on A (the **origin**); members on other servers hold local
> **mirror** threads that pull history **from the origin** (the single message authority).
>
> **Out of scope (deferred):** group rename/avatar sync propagation, edit/delete (still Step 2's
> deferred item), origin death / re-homing, per-peer quota enforcement (`docs/federation-quotas.md`).

---

## 1. The model in one paragraph

A federated group is created on its **origin** server — the owner's home server — which is the
canonical authority for the **roster** *and* the single message store. The origin **aggregates** every
message: when a member sends, their server stores the message, allocates the per-`(thread, sender)`
`originSeq`, and signals the **origin** (not every peer); the origin **pulls** that sender's new
messages by cursor and stores them, becoming the single source. Every other member then pulls from the
**origin** — never from each other — so a new member backfills from the origin alone (`after=0`, per
sender). The per-`(thread, sender)` `originSeq` and the signal+pull transport are **identical to Step
2**; the only change is *topology* — the origin is a hub, not a mesh. The origin therefore **relays**
(it serves messages authored by foreign senders that it pulled in); a member-server serves only its own
locals back to the origin ("pull all msgs but self"). No server trusts another's clock — the displayed
timestamp is the **local arrival** time, not the origin's send time.

---

## 2. Decisions locked

1. **Cross-server invite = a dedicated S2S op.** `POST /api/v1/s2s/thread/invite`, friend-gated
   (inviter ↔ invitee must already be federated friends, matching local SOMS where groups invite
   friends). Chosen over reusing the federated P2P message channel to carry a `GROUP_INVITE` card:
   roster state deserves its own typed, signed, idempotent, membership-gated path, consistent with how
   `friend-request` / `friend-approve` are dedicated split endpoints (`federation-protocol.md` §4.1).

2. **Roster authority = the origin; owner transfer is local-only.** Only the origin server emits
   roster ops (`join`/`leave`/`kick`/`role`) for its group. Owner transfer is **forbidden to a
   federated member** — the owner may transfer only to another local user on the origin server.
   Consequence: **the origin domain is invariant for a group's lifetime**, which removes the re-homing
   problem entirely (there is no "move the canonical thread to another server" operation).

3. **Message transport = identical to Step 2 P2P, origin-hub topology.** Push signal (`new-msg-map`)
   + active pull (`GET /messages`), per-sender `originSeq`. The topology is a **hub, not a mesh**: a
   sending member signals the **origin**; the origin pulls the sender's new messages and stores them;
   the origin then signals the other members, who pull from the origin. The send-side signal loop
   (`notifyOnSend`) is already written group-aware (`federation-buffer.service.ts:44-46`: "a group
   thread (Step 3) could have several"). No new persisted cursor/outbox tables; the per-sender cursor is
   still `MAX(originSeq) WHERE threadId = T AND creator = <sender>`. The origin is the single pull
   source for every member; the origin relays foreign senders' messages (a member never pulls from
   another member).

4. **Timing: arrival time is displayed; origin server time is stored, not shown.** Every federated
   message (1:1 **and** group) carries two timestamps. The **arrival time** (receiver's local `now()`
   when the pulled message is stored) is what the chatbox shows and what orders the conversation list.
   The **origin server time** (the sender server's allocation timestamp, carried in the payload as
   `ts`) is persisted in a new `Message.originServerTime` column for future use (quota day-bucketing,
   audit, optional origin-faithful ordering) and is **never displayed**.

5. **Message identity: `originSeq` is the federated id; no UUID in the payload.** The cross-server
   identity of a federated message is the `(creator, originSeq)` pair, persisted locally as
   `Message.originSeq` and enforced idempotent by the existing `@@unique([threadId, creator,
   originSeq])`. The per-server `Message.id` (BigInt auto-increment) is **local-only** — used for
   pagination, the read watermark, and optimistic-send dedup; it never crosses servers. The served
   `/messages` payload therefore **drops `clientMessageId`** (currently sent at
   `federation.service.ts:732-736`): it is a *client → server* send-idempotency UUID with no
   federation role, and `originSeq` already dedups the pull. The payload becomes
   `{ originSeq, contentType, content, ts }`.

---

## 3. Data model (deltas only)

```prisma
model MessageThread {
  // ...existing columns...
  // The cross-server canonical id of a federated GROUP, minted at the origin on create:
  //   "thr_<rand>@<origin-domain>"   (origin-domain == the owner's config.domain)
  // NULL for purely-local threads (all P2P, local-only groups). @unique enforces ONE local mirror per
  // federated thread — a second cross-server invite to a different local user reuses the same mirror.
  federatedThreadId String? @unique
  // The origin server's domain, denormalized from the id's @suffix for fast "is this mine / who owns
  // it" queries and the roster-op signer check (§8). NULL iff federatedThreadId is NULL.
  originDomain      String? @db.VarChar(255)
}

model Message {
  // ...existing columns (id, originSeq, createdAt, clientMessageId, ...)...
  // The SENDER server's allocation timestamp, copied verbatim from the pulled payload's `ts`.
  // NULL for locally-authored messages that never federate and for legacy rows. Stored for future use;
  // NEVER displayed (the chatbox shows createdAt — the local arrival time). See §5.
  originServerTime  DateTime?
}
```

Nothing else changes structurally:

- `ThreadParticipant` is reused unchanged for mirror threads — `role` carries `OWNER`/`ADMIN`/`MEMBER`,
  `leftAt` is the soft-leave, the roster of a mirror is just its `ThreadParticipant` rows. The owner
  of a mirror is recorded as the foreign owner's **stub** `User` (stubs are local `User` rows with
  `domain = <peer-domain>`, so the `Group.ownerId → User.id` FK holds without change).
- `Message.originSeq` and its `@@unique([threadId, creator, originSeq])` / `@@index([threadId,
  creator, originSeq])` are **untouched** — group pull reuses them exactly. A group with members on
  three servers is merely three distinct `creator` values; the per-sender cursor falls out for free.

**Migration.** Two nullable columns + the `federatedThreadId @unique` index. No backfill: all existing
rows stay `NULL` (they are local P2P / local-only groups). Apply per the project's manual migration
discipline (`prisma migrate dev` writes SQL only → `db execute --file` → `migrate resolve --applied`
→ `prisma generate`).

---

## 4. What Step 2 gives us for free

| Concern | Step 2 (1:1) | Step 3 (group) — change |
| --- | --- | --- |
| Per-sender cursor | `MAX(originSeq) WHERE thread=T AND creator=sender` | **None.** `creator` is already per-sender. |
| Pull query | `WHERE threadId AND creator AND originSeq > after` | **None.** |
| Pull dedup | `@@unique([threadId, creator, originSeq])` → P2002 absorbed | **None.** |
| Send-side signal | `notifyOnSend` loops participants, marks dirty per foreign peer | **None** (already group-aware). |
| Media authz | `get_file` 3-check gate keys off `ThreadParticipant` | **None** — roster gate (§8) makes group media work unchanged. |
| Backfill endpoint | `GET /messages?after=0` | **None** — same endpoint, called per-sender. |
| Trust / signing | RFC9421 signed S2S, `withTrustedPeer` pre-flight | **None.** |

The net-new surface is narrow: the **shared federated thread id** + mirror lifecycle, the **invite**
and **roster** ops, and the **generalized identification** of conversations (from an address pair to a
thread id) at three endpoints.

---

## 5. Timing & identity model (applies to 1:1 and group)

**Two timestamps, one identity, per federated message:**

```
payload (sender → receiver)   =  { originSeq, contentType, content, ts }
                                   ────────  cross-server id  ────────   ─ origin clock ─
```

- `originSeq` — the federated identity. Copied verbatim into the receiver's `Message.originSeq`;
  dedup via the compound unique index. No UUID field is sent or stored for federation.
- `ts` — the sender server's allocation clock. Stored in the receiver's new `Message.originServerTime`
  (nullable; null for local-only). **Not displayed.**
- **arrival** — the receiver stamps `createdAt = new Date()` (local `now()`) when it stores the pulled
  message. This **is** the displayed timestamp and the conversation-list order. Today
  `storePulledMessage` (`federation.service.ts:999`) wrongly copies `new Date(m.ts)`; Step 3 corrects
  this for 1:1 too, and the denormalized last-message cache (`:1013,1018`) switches to the arrival
  `createdAt` so the conversation list orders by what the user sees.

> **Why arrival, not origin time, for display.** Cross-server clocks cannot be trusted and the
> protocol commits to "no global ordering, ever" (`federation-protocol.md:386`). Arrival time is
> locally monotonic and immune to peer clock skew. The cost: messages from a sender whose server is
> behind, pulled in the same window as another sender's, may display slightly out of true conversation
> order — but within a single sender's stream `originSeq` is monotonic and the pull is per-sender, so
> each sender's own messages always display in order. `originSeq` remains the cursor/dedup authority;
> arrival time is purely the display/ordering authority.

> **Why drop `clientMessageId` from the payload.** It exists for *client → server* send idempotency (a
> retried HTTP send with the same UUID returns the original `Message`). Federation dedup is already
> fully covered by `originSeq`; the receiver of a pulled message assigns no `clientMessageId` (it is a
> server-to-server copy). Sending it is dead weight, and the user's rule "uuid don't set in payload"
> removes it. `Message.clientMessageId` stays nullable; pulled-message rows simply leave it `NULL`.

---

## 6. Endpoints

### 6.1 Reused / generalized (identification moves from address-pair → thread)

- **`GET /api/v1/s2s/messages`** gains an optional `thread` query param. For 1:1, behavior is
  unchanged (`from` + `to` identify the local P2P thread; membership = APPROVED friendship). For a
  group, the puller passes `thread=<federatedThreadId>` + `from=<senderAccount>` (+ `after`, `take`);
  `to` is omitted. The server resolves `thread` to the **local mirror**, authorizes via the **roster**
  (§8), resolves `from` to the matching user row it holds (a local user OR, at the origin, a foreign
  sender's stub), and returns:
  ```
  { thread, from, messages: [{ originSeq, contentType, content, ts }], latestSeq, hasMore }
  ```
  filtered `creator = <from> AND threadId = <mirror> AND originSeq > after`. **Serving is role-dependent
  (the hub topology):** the **origin** holds every sender's messages (it pulled them in) and serves any
  sender's stream to any roster member — it **relays**. A **member-server** holds its own locals' sends
  plus what it pulled from the origin, but is only ever pulled *by the origin* (for its own locals) — it
  never serves a foreign sender's messages. "Pull all msgs but self" is the member→origin leg: the
  origin pulls a member's own locals, skipping what isn't that member's.

- **`GET` / `POST /api/v1/s2s/new-msg-map`** — the hint entry is keyed per **(sender, conversation)**.
  For 1:1 the conversation key is `toUser` (unchanged); for a group it is the `thread` id. The buffer's
  leaf key generalizes to `toUser || thread`; `DirtyEntry` carries an optional `thread`. The push/
  snapshot payloads carry `thread` when present, and the puller, on a thread-keyed entry, issues the
  per-(thread, sender) pull above. The existing debounce/coalesce/sweep machinery is unchanged.

- **`GET /api/v1/s2s/get_file`** gains an optional `thread` param (alongside `digest` + `from`). For a
  group, membership is checked via the roster instead of the `from`/`to` friendship; the 3-check
  per-object authz (`MediaMessage` index → `ThreadParticipant`) is otherwise unchanged, so group media
  needs no new authz code.

### 6.2 New — roster lifecycle (origin only)

- **`POST /api/v1/s2s/thread/invite`** (Decision 1). Friend-gated. From the origin (or any member
  server relaying a local user's invite up to origin first — see §7.2) to the invitee's server:
  ```json
  { "id":"<op-ulid>", "origin":"soms.io",
    "thread":"thr_8x3k@soms.io", "name":"Design", "owner":{"account":"alice","domain":"soms.io"},
    "avatar":"<b64 inline per federation avatar v0.1>", "by":{"account":"alice","domain":"soms.io"},
    "to":{"account":"bob","domain":"other.com"}, "ts":1750000000000 }
  ```
  Receiver: resolves/mints the local mirror thread (idempotent on `federatedThreadId`), ensures the
  owner stub, writes a `GROUP_INVITE` card into the invitee's P2P thread with the inviter (the existing
  local affordance), and surfaces it via the existing `FRIEND_REQUEST`-style SSE / nav stream. The
  invitee accepts or declines via the **existing local** `group/join` / decline path — but the join
  must then register at the origin (§7.2).

- **`POST /api/v1/s2s/thread/member`** — authoritative roster delta, **emitted only by the origin**.
  Idempotent by `id` (op-ulid); applied to every member-server's local mirror. Shapes:
  ```json
  { "id":"<op-ulid>", "origin":"soms.io", "thread":"thr_8x3k@soms.io",
    "op":"join|leave|kick|role", "user":{"account":"bob","domain":"other.com"},
    "role":"MEMBER",              // for join/role
    "by":{"account":"alice","domain":"soms.io"}, "ts":... }
  ```
  - `join` — add/revive `ThreadParticipant` (role MEMBER by default).
  - `leave` / `kick` — set `leftAt`.
  - `role` — set ADMIN/MEMBER.
  - **No `owner` op targets a federated user** (Decision 2). Owner transfer is a local-only operation
    on the origin and does not appear on the wire as a cross-server op.

### 6.3 Unchanged

`friend-request`, `friend-approve`, `users/:account`, `revision`, `ping`, `init` — all reused as-is.

---

## 7. Flows

### 7.1 Create + cross-server invite

```
Alice@soms.io creates group "Design" with local friend Carol and cross-server friend Bob@other.com.

1. Alice's client → soms.io: group/create (existing local flow).
2. soms.io: mint federatedThreadId "thr_8x3k@soms.io"; create origin MessageThread(type=GROUP,
   federatedThreadId, originDomain="soms.io") + Group + ThreadParticipant{alice, OWNER}.
3. Carol (local): existing GROUP_INVITE-in-P2P-thread path — unchanged.
4. Bob (cross-server): soms.io → other.com  POST /s2s/thread/invite  (§6.2). Friend gate: alice↔bob
   must be APPROVED friends (else 403, same gate as friend-request).
5. other.com: idempotent — find-or-create mirror MessageThread(federatedThreadId="thr_8x3k@soms.io",
   originDomain="soms.io") + mirror Group{name,owner=alice-stub,avatar}; write GROUP_INVITE card into
   bob's P2P thread with alice; SSE/nav-stream to bob. Bob has NOT joined yet (no ThreadParticipant
   for bob, or a leftAt/invited marker).
```

### 7.2 Accept → register at origin → fan-out

```
Bob accepts the invite (local group/join on other.com).

1. other.com: create/revive ThreadParticipant{bob, MEMBER} on the mirror thread locally; show bob the
   group immediately (optimistic).
2. other.com → soms.io: signal that bob joined. Because the roster authority is the origin, the join
   is registered there: soms.io adds bob-stub to the origin roster (ThreadParticipant{bob-stub,
   MEMBER} on the ORIGIN thread) and fans out:
3. soms.io → every server hosting a member (incl. other.com): POST /s2s/thread/member
   { op:"join", user:bob, role:MEMBER, by:alice }. Each mirror's roster gains bob.
4. other.com (back to itself, via the fan-out) + others: roster now consistent everywhere.
```

> The round-trip through the origin is what keeps a single roster authority. The accept is optimistic
> locally; the fan-out is the durable consistency step. A lost fan-out is healed on the next
> roster-resync pull (§7.6) — origin remains the source of truth.

### 7.3 Send (origin-hub, signal + pull) — "sent msg wait federal server to pull"

```
Bob@other.com sends "hi" to the group (origin = soms.io; members on soms.io, other.com, ccc.com).

1. Bob's client → other.com: send message (existing HTTP write).
2. other.com: store Message on the MIRROR thread, allocate originSeq = MAX+1 for (thread=bob). Local
   SSE to other.com's local members (bob).
3. other.com notifyOnSend: signal the ORIGIN (soms.io) ONLY — mark the (thread, bob) hint dirty →
   debounced new-msg-map push to soms.io. Not every peer: the origin is the hub.
4. soms.io (origin) receives the hint; pulls GET /messages?thread=T&from=bob&after=<cursor> from
   other.com. other.com serves bob's own messages > cursor ("pull all msgs but self" — member→origin).
5. soms.io: storePulledMessage — createdAt = local now() (arrival, displayed), originServerTime = ts
   (stored, not shown), originSeq copied (dedup). The origin now holds bob's message. SSE NEW_MESSAGE
   to soms.io's local members (alice, carol).
6. soms.io (origin) notifyOnSend: the origin now holds a new message from bob → signal every OTHER
   member-server (ccc.com) with the (thread, bob) hint.
7. ccc.com pulls GET /messages?thread=T&from=bob&after=<cursor> from the ORIGIN (soms.io). soms.io
   serves bob's message — the origin RELAYS a foreign sender's message. ccc.com stores it; SSE to its
   local members.
```

The sender does **nothing** but store + allocate + signal the origin; it **waits** for the origin to
pull (Step 2's model, unchanged). The origin then becomes the source for everyone else: it re-signals
the other members, who pull from the origin. The origin relays foreign senders' messages; a member
never pulls from another member.

### 7.4 Backfill on join (single source = the origin)

```
When Bob first joins (on other.com), he has no group history.

1. other.com knows the full roster (from §7.2 fan-out) → the set of senders in the group.
2. For each sender S in the roster whose domain ≠ other.com (every foreign sender — skip own, "pull
   all msgs but self"): GET /messages?thread=T&from=S&after=0  FROM THE ORIGIN. The origin serves S's
   full history (it aggregated everyone's). Store (arrival-time display, originServerTime kept).
3. other.com now holds the full group history; future sends arrive via §7.3.
```

**Single pull source (the origin), N per-sender cursors** (one per foreign sender). This *aligns* with
`federation-protocol.md` §8's "only the origin serves canonical history" — the origin IS the canonical
store because it aggregates every sender's messages. (If the origin is unreachable at join time, the
history is fetched lazily on the next pull/sweep once reachable — the Step 2 resilience floor.)

### 7.5 Leave / kick / role

Initiated at the origin (a member's `group/leave` or an admin's `kick`/`role` is relayed to the origin
if the actor is remote, then the origin fans `thread.member`). Each mirror applies it (set `leftAt` /
change `role`), idempotently by op-id. A left member's future sends are rejected at their server's own
roster check before signaling; the origin stops fanning to their server.

### 7.6 Owner transfer — local only (origin invariant)

```
Alice (origin owner) transfers ownership to a successor.
- If the successor is LOCAL to soms.io: existing local owner-transfer flow (Group.ownerId +
  ThreadParticipant.role updated on the origin thread). No cross-server op. Origin domain unchanged. ✓
- If the successor is a FEDERATED member: REJECTED (Decision 2). The UI hides the option; the backend
  enforces it. There is no wire op that could move ownership across servers.
```

Consequence: `originDomain` is invariant; the canonical-roster server for a group never changes. This
is what removes the re-homing problem — there is nothing to re-home.

### 7.7 Roster resync (heal lost fan-outs) — origin is source of truth

A lightweight backstop mirroring Step 2's pull-on-open: when a server opens/contacts the origin for a
group, it can `GET` the origin's authoritative roster for `thread` and reconcile its mirror (add
members it missed, mark leavers). This is the roster analogue of the message pull — same trust model
(origin-signed), same "derive local state from authoritative data" pattern.

---

## 8. Membership gate generalization (friend-edge → roster, hub-aware)

The single substantive authz change. Today:

- `serveOutboundMessages` / `resolveMediaFile` gate on `findApprovedFriendship(from, to)` — the friend
  edge **is** the 1:1 membership (`federation-protocol.md:89`).

For a group thread, membership is the **local roster**, and the gate is **direction-aware** because the
origin relays:

```
// A server may pull thread T's `from`-stream from the serving server when:
authorized(signer, thread, fromAccount) :=
   the local mirror thread for `thread` exists
   AND (
     // member → origin leg (a member's own locals pulled BY the origin):
     signer == thread.originDomain
     AND fromAccount resolves to a LOCAL user of the serving server   // "pull all msgs but self"
     OR
     // origin → member leg (the origin serves any sender it holds to a roster member):
     thread.originDomain == <serving server's domain>                 // serving server IS the origin
     AND ∃ ThreadParticipant{ leftAt:null } on the mirror for a user whose domain == signer
   )
```

So the **origin** (serving) authorizes any roster member to pull any sender's stream (it holds all
senders — local + foreign stubs it aggregated). A **member-server** (serving) only ever answers the
origin, and only for its own local senders. For 1:1 threads the friend-edge gate is unchanged. The two
coexist: `federatedThreadId IS NULL` → friend gate; a federated id → roster gate. `get_file` gains the
identical branch (the origin serves any member's media; a member serves its own locals to the origin).

---

## 9. Security summary

- **Roster ops (`thread/invite`, `thread/member`)** are signed (RFC9421), `origin === signer`-checked,
  and accepted only when `signer == thread.originDomain` — the origin is the sole authority for its own
  group's roster. A peer cannot forge membership in another server's group.
- **Invite is friend-gated** exactly like `friend-request`: inviter ↔ invitee must be APPROVED friends,
  preventing arbitrary cross-server spam (the same abuse barrier Step 1 relies on).
- **Message pull is roster-gated** (§8): a server may pull a group's messages only if it has a live
  local member (member→origin leg) or **is** the origin (origin→member leg). The origin alone serves
  foreign senders' messages (it relays what it aggregated); a member serves only its own locals. No
  history harvesting from trusted-but-unrelated peers.
- **Media** inherits the roster gate via the unchanged 3-check `ThreadParticipant` authz — group media
  is member-only by construction.
- **Timing is untrusted by design** (§5): origin `ts` is never used for display or cross-server
  ordering, so a malicious/skewed peer cannot reorder a user's conversation; `originSeq` (per-sender,
  server-allocated) remains the only ordering the receiver trusts, and only within a single sender.

---

## 10. Implementation plan (ordered, verifiable)

1. **Schema + migration.** Add `MessageThread.federatedThreadId @unique`, `MessageThread.originDomain`,
   `Message.originServerTime` (all nullable). Apply per manual discipline; `prisma generate`.
2. **Timing/identity refactor (touches Step 2 too).** `storePulledMessage`: `createdAt = new Date()`
   (arrival), `originServerTime = new Date(m.ts)`; last-message cache uses arrival. Drop
   `clientMessageId` from `serveOutboundMessages` payload. Verify 1:1 e2e still green + a pulled
   message now displays receiver-local time.
3. **Origin create.** `group/create` on the origin mints `federatedThreadId`, sets `originDomain`,
   stores it on its own thread. Local invites unchanged.
4. **`thread/invite` + mirror lifecycle.** Endpoint + receiver: idempotent mirror find-or-create,
   owner stub, `GROUP_INVITE` card. Unit test: invite twice → one mirror thread.
5. **`thread/member` roster ops + origin authority.** Endpoint, op-id idempotency, `signer ==
   originDomain` gate, fan-out to member-servers. Local `group/join`/`leave`/`kick`/`role` relay to
   origin then fan. Owner-transfer-to-foreign rejected.
6. **Generalize `messages` / `new-msg-map` / `get_file`** to the `thread` param + roster gate (§6.1,
   §8). Keep 1:1 path bit-identical behind the `federatedThreadId IS NULL` branch.
7. **Send + signal loop (hub).** `notifyOnSend` signals the **origin** on a member send (member→origin
   pull); the origin re-signals the other members after it stores the message (origin→member pull).
   Per-(thread, sender) pull on both legs.
8. **Backfill on join.** Per-sender `after=0` pull **from the origin** (§7.4) — single source.
9. **Roster resync backstop** (§7.7) — origin-served roster reconcile on open.
10. **e2e (two-server federation harness, per the `aaa`/`bbb.local` pattern).** Create group on `aaa`
    with owner + a `bbb` member; send both directions; backfill on a third member's join; leave/kick;
    verify arrival-time display, `originServerTime` stored not shown, `clientMessageId` absent from the
    wire, no UUID column, origin invariant under local owner transfer.

---

## 11. Deferred (explicit non-goals for Step 3 v0.1)

- **Group rename / avatar / description sync.** The mirror copies these at invite time; a later origin
  rename does not yet propagate. A `thread.meta` op (same shape as `thread.member`, origin-only) covers
  it later without a new trust path.
- **Edit / delete propagation.** Still Step 2's deferred item (a `tombstone`/`editOf` shape on the same
  pull endpoint); groups inherit it whenever it ships.
- **Origin death / re-homing.** With owner-transfer-to-foreign forbidden (Decision 2), the origin is
  fixed; if it dies the group goes read-only (members retain whatever they have pulled) until it
  returns. Re-homing to another server is explicitly out of scope — it would require a trust transfer
  the protocol deliberately does not offer.
- **Per-peer quota enforcement.** Hooks designed in `docs/federation-quotas.md`; group traffic
  (origin fan-out to N members, single-origin backfill) is the main reason the quota layer matters and
  is enforced when that lands.
- **Read receipts / typing / presence.** v0.2 ephemeral channel (`federation-protocol.md` §6.3);
  groups need them most but they are not in this step.
