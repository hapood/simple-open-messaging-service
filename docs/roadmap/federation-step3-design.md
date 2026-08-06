# SOMS Federation — Step 3 Design (cross-server groups)

> **文档分类：Historical design。** 本文解释 Step 3 的设计与实施过程，不具现行规范效力。
> 当前入口与实现基线见 [`docs/federation/README.md`](../federation/README.md)。

> **Status:** **Phase A BUILT** (2026-07-09): the unified S2S invite (`/s2s/invite` +
> `/s2s/invite-accept`, friend + group share one endpoint — see `docs/api/federation-s2s-api.md`),
> cross-server group **invite + join** (origin records the joiner), and the lazy **roster meta-pull**
> (chat-open probe, reusing the Step-2 profile-sync path + `GET /s2s/group/:account/roster`). **Phase B BUILT**
> (2026-07-10): cross-server group **messaging** via the **origin-hub** (the origin is the single
> authority for roster AND message history — a member signals the origin, the origin pulls + aggregates +
> re-signals, members pull the whole thread from the origin), the **group-invite chat card** (written
> into the inviter's P2P mirror → flows to the invitee via Step-2 pull; resolved by the group `!account`),
> and **leave** (pull-reject: a mirror's `group/leave` nudges the origin with a per-author hint; the origin
> pulls the leaver's messages, the mirror answers HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT) → the origin
> dissolves the member from its canonical roster + bumps the group meta). Loop-safety is one rule:
> `signalOutbound` excludes the fetch-source domain. The GROUP invite carries `sinceSeq` (origin curSeq
> at invite time) so a new member seeds `pullUntil` and starts from invite-time, not full history.
> **Deferred:** a durable active-liveness leave backstop (the pull-reject hint is volatile), the frontend
> card/account-resolution
> adaptation. Builds directly on Step 2 (`docs/roadmap/federation-step2-design.md`), whose 1:1 transport is
> reused verbatim.
>
> **Scope:** cross-server **GROUP** threads — a group whose owner lives on server A and whose members
> span servers A, B, C … . Owner is created on A (the **origin**); members on other servers hold local
> **mirror** threads that pull history **from the origin** (the single message authority).
>
> **Out of scope (deferred):** group rename/avatar sync propagation, origin death / re-homing. Per-peer
> quota enforcement is now **BUILT** (unified local + peers — see `docs/roadmap/federation-quotas.md`). Delete
> propagation is a **non-goal** (Step 2 §9: the origin cannot mutate receiver-local data once delivered).

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

2. **Roster authority = the origin; a group never crosses its origin-domain boundary.** Only the
   origin server emits roster ops (`join`/`leave`/`kick`/`role`) for its group. Two consequences, both
   deliberate and both **domain boundaries the group never crosses**:
   - **No re-homing — the group is bound to its origin domain for life.** The canonical roster +
     message authority is the origin server for the group's entire lifetime. There is **no operation to
     move the canonical thread to another server**; `originDomain` is invariant, which removes the
     re-homing problem entirely.
   - **Ownership does not cross domains — owner transfer is local-only.** The owner (admin) may
     transfer only to another user on the **same origin server**; transferring ownership to a member on
     a *different* domain is **forbidden** (backend rejects, UI hides the option). This is what keeps
     `originDomain` invariant — there is no wire op that could move ownership across servers.

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

```sql
-- delta on "MessageThread"; ...existing columns omitted...
-- The federated GROUP identity is a `groupUser` — a `!`-sigil User row whose `account` IS the group's
-- OWN `!account` (a `!`-prefixed ULID minted on group create, globally unique). The SAME `!account` on
-- the origin and every mirror, so it doubles as the on-wire group address (`toAccount` / `group`), never
-- the DB thread id. The groupUser's `domain` is the origin server's config.domain ("local" on the
-- origin, <peer-domain> on a mirror) — denormalized for fast "is this mine / who owns it" queries + the
-- roster-op signer check (§8). `groupUserId` is NULL for purely-local threads (all P2P, local-only
-- groups). UNIQUE enforces ONE local mirror per federated group — a second cross-server invite to a
-- different local user reuses the same mirror. (Earlier iterations carried `fedGroupAccount` +
-- `originDomain` as two scalar columns; both folded into this one relation.)
ALTER TABLE "MessageThread"
    ADD COLUMN    "groupUserId" INTEGER,
    ADD CONSTRAINT "MessageThread_groupUserId_key"  UNIQUE ("groupUserId"),
    ADD CONSTRAINT "MessageThread_groupUserId_fkey"
        FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE;

-- delta on "Message"; ...existing columns (id, originSeq, createdAt, clientMessageId, ...) omitted...
-- The SENDER server's allocation timestamp, copied verbatim from the pulled payload's `ts`.
-- NULL for locally-authored messages that never federate and for legacy rows. Stored for future use;
-- NEVER displayed (the chatbox shows createdAt — the local arrival time). See §5.
ALTER TABLE "Message" ADD COLUMN "originServerTime" TIMESTAMP(3);
```

Nothing else changes structurally:

- `ThreadParticipant` is reused unchanged for mirror threads — `role` carries `OWNER`/`ADMIN`/`MEMBER`,
  `leftAt` is the soft-leave, the roster of a mirror is just its `ThreadParticipant` rows. The owner
  of a mirror is recorded as the foreign owner's **stub** `User` (stubs are local `User` rows with
  `domain = <peer-domain>`, so the `Group.ownerId → User.id` FK holds without change).
- `Message.originSeq` and its `@@unique([threadId, creator, originSeq])` / `@@index([threadId,
  creator, originSeq])` are **untouched** — group pull reuses them exactly. A group with members on
  three servers is merely three distinct `creator` values; the per-sender cursor falls out for free.

**Migration.** A nullable, unique `groupUserId` plus the `groupUser` relation (the `!`-User carries
the `!account` + the origin domain). No backfill: all existing rows stay `NULL` (they are local P2P /
local-only groups). Apply through the project's SQL migration workflow: update
`src/database/schema.ts`, add the corresponding SQL migration, run `npm run db:migrate`, and verify
with `npm run db:status`.

---

## 4. What Step 2 gives us for free

| Concern | Step 2 (1:1) | Step 3 (group) — change |
| --- | --- | --- |
| Per-sender cursor | `MAX(originSeq) WHERE thread=T AND creator=sender` | **None.** `creator` is already per-sender. |
| Pull query | `WHERE threadId AND creator AND originSeq > after` | **None.** |
| Pull dedup | Unique `(threadId, creator, originSeq)` conflicts are absorbed | **None.** |
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

- **`GET /api/v1/s2s/messages`** serves a group two ways, both roster-gated (§8) and keyed by the group
  `!account` as `toAccount` (the `groupUser.account`, never the DB thread id). For 1:1, behavior is
  unchanged (`fromAccount` + `toAccount` identify the local P2P thread; membership = APPROVED friendship).
  - **Whole-thread** (mirror ← origin): `toAccount=<groupAccount>` + `toDomain` + `afterSeq` + `take`.
    Returns EVERY sender's messages with thread `seq > afterSeq`, ascending, each carrying its thread
    `seq` (the mirror's `pullUntil` cursor, advanced page-by-page to the last stored message) + the
    author's wire address + the copied `originSeq` (the dedup key). The origin serves any roster member
    the whole stream.
  - **Per-author** (origin ← mirror, the hub aggregation leg): `toAccount=<groupAccount>` +
    `fromAccount=<author>` + `fromDomain=<authorDomain>` + `toDomain` + `afterSeq` (originSeq space). The
    origin pulls each member-server's NEW messages this way to aggregate them; its cursor for a member
    is derived `MAX(originSeq)` per author.
  **Serving is role-dependent (the hub topology):** the **origin** holds every sender's messages (it
  pulled them in) and serves any sender's stream to any roster member — it **relays**. A **member-server**
  holds its own locals' sends plus what it pulled from the origin, but is only ever pulled *by the origin*
  (for its own locals) — it never serves a foreign sender's messages.

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

- **`POST /api/v1/s2s/invite`** with `kind: "GROUP"` — the **unified** invite endpoint (friend + group
  share it; see `docs/api/federation-s2s-api.md`). Friend-gated. From the origin (or any member server
  relaying a local user's invite up to origin first — see §7.2) to the invitee's server:
  ```json
  { "id":"<op-ulid>", "origin":"soms.io", "kind":"GROUP", "ts":1750000000000,
    "from":{"account":"alice","domain":"soms.io"}, "to":{"account":"bob","domain":"other.com"},
    "group":"!01H8X3K…", "groupName":"Design",
    "groupAvatar":{"b64":"<inline per federation avatar v0.1>","w":512,"h":512},
    "groupRevision":1750000000000, "owner":{"account":"alice","domain":"soms.io"},
    "sinceSeq":42 }
  ```
  Receiver: resolves/mints the local mirror thread (idempotent on the group `!account` =
  `groupUser.account`), seeds its `pullUntil` from `sinceSeq`, ensures the owner stub, and records the inbound `GROUP_INVITE` (the
  visible chat card is the inviter's responsibility — written into the inviter's P2P mirror, delivered
  to the invitee via the Step-2 message pull). The invitee accepts/declines via the **existing local**
  path — but the join must then register at the origin (§7.2).

- **Roster delta (SHIPPED = lazy pull, NOT a push endpoint).** The original proposal was a push
  `POST /s2s/thread/member` (origin-emitted, applied to every mirror). **That is NOT built.** The
  shipped design records joins/leaves at the origin and mirrors reconcile via the lazy **roster
  meta-pull** on chat-open (`GET /s2s/group/:account/roster`, §6.1) — the roster is pulled like a profile, not
  pushed. The push shape below is retained only as the original-proposal reference:
  ```json
  { "id":"<op-ulid>", "origin":"soms.io", "group":"!01H8X3K…",
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
2. soms.io: the group's `!account` (e.g. "!01H8X3K…") is its groupUser's account; create origin
   MessageThread(type=GROUP) + its groupUser `!`-User(account="!01H8X3K…", domain="local") + Group +
   ThreadParticipant{alice, OWNER}.
3. Carol (local): existing GROUP_INVITE-in-P2P-thread path — unchanged.
4. Bob (cross-server): soms.io → other.com  POST /s2s/invite  (kind=GROUP, §6.2). Friend gate:
   alice↔bob must be APPROVED friends (else 403, same gate as friend-request).
5. other.com: idempotent — find-or-create mirror MessageThread + its groupUser
   `!`-User(account="!01H8X3K…", domain="soms.io") + mirror Group{name,owner=alice-stub,avatar}; write GROUP_INVITE card into
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

### 7.5 Leave propagation (pull-reject, mirror → origin)

A member's `group/leave` is applied **locally first** (soft-leave — `ThreadParticipant.leftAt` set on the
server where the leave happened). Propagating it to the roster authority (the **origin**) reuses the
existing message-pull channel rather than a dedicated leave wire-op:

1. The mirror's `group/leave` handler calls `notifyGroupLeave`, which writes a NORMAL per-author hint for
   the leaver to its outbound buffer (`markDirty(originDomain, leaver, !group, latestSeq)`) and schedules a
   flush. `latestSeq` is set to `MAX(leaver's originSeq over Message ∪ PendingMedia) + 1` so it always
   exceeds the origin's per-author cursor — the origin's hub-leg pull is never short-circuited. No-op when
   the leaver's server IS the origin (its own leave is already on the canonical roster; mirrors catch up via
   the lazy roster meta-pull).
2. The origin drains the hint into `pullGroupFromAuthor` and `GET /s2s/messages?toAccount=!group&fromAccount=leaver…`.
3. The mirror's per-author gate (`serveOutboundMessagesGroupFrom`) finds the leaver no longer active
   (`leftAt` set) and answers **HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT)** — a resource response, not 403. This is the
   crux: 410 is not a peer failure (only 401/403/5xx are), so `getSigned` does **not demote** the peer
   (a 403 would demote + break trust).
4. The origin recognizes the 410 (S2sResponseError) → `softLeaveMember` on its canonical roster + bumps the group-meta
   revision. Other mirrors then reconcile (drop the leaver) on their next chat-open roster meta-pull.

A left member's future sends are rejected at their own server's roster check before signaling; the origin
stops fanning to their server. The hint is volatile — a lost leave leaves the origin's roster stale until a
future event retriggers a pull for that author; a durable active-liveness backstop is the deferred fix.

**Kick / role change** remain origin-initiated and are not yet federated (a cross-server kick needs the
kicked member's server to learn of a removal it did not initiate — a `removed:true` hint or an admin op;
deferred).

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
     signer == thread.groupUser.domain
     AND fromAccount resolves to a LOCAL user of the serving server   // "pull all msgs but self"
     OR
     // origin → member leg (the origin serves any sender it holds to a roster member):
     thread.groupUser.domain == <serving server's domain>             // serving server IS the origin
     AND ∃ ThreadParticipant{ leftAt:null } on the mirror for a user whose domain == signer
   )
```

So the **origin** (serving) authorizes any roster member to pull any sender's stream (it holds all
senders — local + foreign stubs it aggregated). A **member-server** (serving) only ever answers the
origin, and only for its own local senders. For 1:1 threads the friend-edge gate is unchanged. The two
coexist: `groupUserId IS NULL` → friend gate; a groupUser (a group) → roster gate. `get_file` gains the
identical branch (the origin serves any member's media; a member serves its own locals to the origin).

---

## 9. Security summary

- **Roster ops (`thread/invite`, `thread/member`)** are signed (RFC9421), `origin === signer`-checked,
  and accepted only when `signer == thread.groupUser.domain` — the origin is the sole authority for its
  own group's roster. A peer cannot forge membership in another server's group.
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

## 10. Implementation status

**Phase A — BUILT (2026-07-09):**
1. **Schema** ✅ — the group identity (`groupUser` relation via `groupUserId @unique`) +
   `Message.originServerTime` already exist (added during Step 2). No new columns for Phase A.
2. **Unified S2S invite** ✅ — `/s2s/friend-request` + `/s2s/friend-approve` + `/s2s/thread/invite`
   collapsed into ONE `/s2s/invite` (deliver, `kind` FRIEND|GROUP) + `/s2s/invite-accept`
   (FRIEND→P2P thread accept-wins; GROUP→origin records the joiner). `friend-op.handler.ts` deleted;
   handlers folded into `FederationService.handleInvite`/`handleInviteAccept`.
3. **Origin create (lazy)** ✅ — `ensureOriginFederatedId` mints the group's `!`-User (groupUser:
   account = the `!account`, domain = "local") at the first cross-server invite (the local group becomes the origin).
4. **Group invite + mirror lifecycle** ✅ — `writeInvites` branches on `isForeigner` → `sendInvite(
   GROUP)`; `handleGroupInvite` (receiver) creates the mirror + an incoming Invite + stores the OWNER,
   revision-gated avatar, NO card (the chat card is Phase B visibility).
5. **Roster meta-pull (lazy, NOT push fanout)** ✅ — `GroupService.bumpGroupMeta` bumps the group
   `!-User.updatedAt` (the meta revision) on every roster mutation + on accept-join; `GET /s2s/thread/
   roster` serves the origin roster; `syncGroupMetaIfStale` (the `group/sync-meta` chat-open hook)
   probes the revision and, if stale, re-pulls identity (**reuses the Step-2 profile-sync path:
   `fetchRemoteUser` + `localizeForeignProfile`**) + the roster, reconciles foreign members via the raw
   mutators (`upsertMember`/`softLeaveMember`), + fans `GROUP_UPDATED` SSE. (The earlier push
   `thread/member` fanout was built then removed as the wrong design.)
6. **Origin-authority invariant** ✅ — `transferOwnership` rejects a cross-server target (owner stays on
   the origin). Mirror-side kick/role are not explicitly guarded — the roster reconcile reverts any
   mirror-local mutation to match the origin, so a guard is redundant.

**Phase B — BUILT (2026-07-10, origin-hub):** the origin is the single authority for roster AND message
history. A member stores locally + signals the origin; the origin pulls per-author + aggregates + re-signals
the other member-servers; members pull the whole thread from the origin via a thread-level `pullUntil`
cursor (`MessageThread.pullUntil`, seeded by the invite's `sinceSeq`). Loop-safety is one rule at the
hint-write layer: `signalOutbound` excludes the domain the message was fetched from.
7. **Timing/identity refactor** — DONE in Step 2 (verified): `storePulledMessage` stores `originServerTime`
   but displays/sorts by arrival `createdAt`; `clientMessageId` is not on the served payload.
8. **Generalize `messages` / `new-msg-map` / `get_file`** — DONE: `to` is the group `!account` (all-senders
   or per-author), `fromDomain` required; roster gate via `resolveGroupThreadAccess`. The 1:1 path is
   bit-identical (to = user account).
9. **Send + signal loop (hub)** — DONE: `signalOutbound` routes origin→all foreign member-domains,
   mirror→origin-only, minus the fetch-source. The origin re-signals after `storePulledMessage`.
10. **Cursor on join** — DONE (partial): `pullUntil` defaults to `-1` (full history) until seeded by
    `sinceSeq`; the "latest = no history" option (seed from the invite's `sinceSeq`) is the deferred tail.
11. **Group-invite chat card visibility** — DONE: `writeInvites` writes the account-based card
    `{from, group}` into the inviter's P2P mirror → delivered via Step-2 pull; the invitee resolves by
    the group `!account` (`InviteService.resolveInviteId`). Frontend card-rendering adaptation is the
    remaining consumer-side work.
12. **Leave (mirror → origin)** — DONE: pull-reject — `group/leave` on a mirror nudges the origin with a
    per-author hint; the origin pulls the leaver's messages; the mirror answers HTTP 410 GONE
    (FEDERATION_GROUP_AUTHOR_LEFT); the origin `softLeaveMember`s the leaver on its canonical roster +
    bumps the group meta (mirrors reconcile lazily). 410 is a resource response, so it does NOT demote the peer. A durable
    active-liveness backstop is deferred.
13. **e2e** — DONE (core): two-server harness — create group on `aaa` with a `bbb` member, accept by group
    account, origin records the joiner, alice's message reaches bob's mirror via the hub + SSE. Full
    coverage (3-app re-signal, backfill, leave, media transit) is the remaining tail.

---

## 11. Deferred (explicit non-goals for Step 3 v0.1)

- **Group rename / avatar / description sync.** The mirror copies these at invite time; a later origin
  rename does not yet propagate. A `thread.meta` op (same shape as `thread.member`, origin-only) covers
  it later without a new trust path.
- **Delete propagation — non-goal.** Step 2 §9 establishes the origin cannot mutate receiver-
  local data once delivered, so there is nothing for groups to inherit; a local delete stays local.
- **Origin death / re-homing.** With owner-transfer-to-foreign forbidden (Decision 2), the origin is
  fixed; if it dies the group goes read-only (members retain whatever they have pulled) until it
  returns. Re-homing to another server is explicitly out of scope — it would require a trust transfer
  the protocol deliberately does not offer.
- **Per-peer quota enforcement.** Hooks designed in `docs/roadmap/federation-quotas.md`; group traffic
  (origin fan-out to N members, single-origin backfill) is the main reason the quota layer matters and
  is enforced when that lands.
- **Read receipts / typing / presence.** v0.2, deferred (presence+typing best-effort ephemeral; read
  receipts a separate item); groups need them most but they are not in this step.
