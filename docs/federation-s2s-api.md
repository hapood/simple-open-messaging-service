# SOMS Federation — S2S API Reference

> Living reference for the federation server-to-server API. **Built:** Step 1 (trust + friend), Step 2
> (1:1 messages + media), **Step 3 Phase A** (unified invite — friend + group share `/s2s/invite`;
> cross-server group invite/join + lazy roster meta-pull). **Planned (Phase B):** cross-server group
> **messaging** (generalize `messages`/`new-msg-map`/`get_file` with a `thread` param + roster gate),
> the group-invite chat card (visibility), and the **leave** flow. See `docs/federation-step3-design.md`.
>
> **Global prefix:** every path is `/api/v1/s2s/...` (`bootstrap.ts`). **Auth:** all endpoints are
> RFC9421 signature-guarded + trusted-peer-gated by `S2sSignatureGuard` **except `init`** (which *is*
> the trust step). **Address:** a user is always `{ account, domain }` — never an `@`-joined string on
> the wire (the `@` is a UI input aid only, split client-side).
>
> **`seq` convention:** `originSeq` is a per-`(thread, sender)` monotonic **int32**, **0-indexed** — the
> first message in a (thread, sender) is seq 0, then 1, 2, …; `-1` means "empty / before seq 0". It is
> sender-allocated (`(MAX(originSeq) ?? -1) + 1`), max 2³¹−1 (≪ 2⁵³, so it crosses the wire as a JSON
> **number**, never a string). Forward cursor = `afterSeq` (`seq > afterSeq`, default `-1` = from seq 0);
> backward cursor = `beforeSeq` (`seq < beforeSeq`, default `-1` = no upper bound → from latest), on the
> `/messages/before` twin. Display/order on each server uses its OWN local seq+arrival-time; `originSeq`
> (+ `originServerTime`) are kept only for federation dedup/cursor.

---

## 1. Current endpoints (built)

| # | Method · Path | Params / Body | Extra gate | Purpose |
|---|---|---|---|---|
| 1 | `POST /s2s/init` | headers only (signature) | verify via requester `.well-known` | Bootstrap mutual trust; auto-accept trusted |
| 2 | `POST /s2s/invite` | body `S2SInvite` (`kind` FRIEND\|GROUP) | friend gate (`from`↔`to`) | **Unified** deliver: a friend-add OR group-invite. FRIEND carries the sender `profile` (stub localization); GROUP carries the group identity + a revision (`groupRevision`) so the receiver's mirror update is revision-gated. Idempotent by `(origin, id)` + the Invite partial-unique indexes |
| 3 | `POST /s2s/invite-accept` | body `S2SInviteAccept` (`kind`) | — | The recipient accepted. FRIEND → the inviter's server creates the P2P thread (accept-wins); GROUP → the group **origin** records the joiner on its canonical roster (+ bumps the group meta revision) |
| 4 | `GET /s2s/thread/roster` | query `thread` (federatedThreadId) | trusted peer | The ORIGIN serves the canonical roster (active members, wire addresses + roles) — pulled by a mirror's lazy meta-pull on chat-open |
| 5 | `GET /s2s/users/:account` | path `account` | — | A local user's full profile (avatar inline base64). A group is a `!`-User, so this also serves a group's identity |
| 6 | `GET /s2s/users/:account/revision` | path `account` | — | Lightweight profile-revision probe (no avatar). For a group `!`-User this is the **meta revision** (`updatedAt`) the mirror compares on chat-open |
| 7 | `GET /s2s/new-msg-map` | query `cursor`(int,def0), `take`(int,cap1000) | — | Peer pulls OUR outbound hint snapshot |
| 8 | `POST /s2s/new-msg-map` | body `{origin, entries:[{from,to,latestSeq}]}` | `origin==signer` | Peer pushes ITS outbound hints (ACK fast) |
| 9 | `GET /s2s/messages` | query `from`,`to`,`afterSeq`(originSeq,def -1=from start),`take`(cap50) | active P2P thread | Forward pull: the SENDER's 1:1 messages with `seq > afterSeq` |
| 10 | `GET /s2s/messages/before` | query `from`,`to`,`beforeSeq`(def -1=from latest),`take`(cap50) | active P2P thread | Backward twin of #9: `seq < beforeSeq`, oldest-first (reserved for external impls; SOMS is forward-only) |
| 11 | `GET /s2s/ping` | — | — | Signed liveness probe (advances watermark) |
| 12 | `GET /s2s/get_file` | query `digest`,`from`,`to` (HTTP Range) | 3-check media authz | Stream a chat-media asset by sha256 |

### Body / response shapes

```ts
S2SAddress = { account: string; domain: string }

// POST /s2s/invite — the `kind` discriminates; the receiver dispatches.
S2SInvite  = { id: string; origin: string; ts: number; kind: 'FRIEND' | 'GROUP';
               from: S2SAddress; to: S2SAddress; note?: string;                 // ≤255
               profile?: S2SProfile;                                            // FRIEND only
               thread?: string; groupName?: string;                             // GROUP only
               groupAvatar?: { b64: string; w: number; h: number } | null;
               groupRevision?: number; owner?: S2SAddress }                     // GROUP: origin !-User.updatedAt; owner

// POST /s2s/invite-accept
S2SInviteAccept = { id: string; origin: string; ts: number; kind: 'FRIEND' | 'GROUP';
                    accepter: S2SAddress; inviteOriginId?: string;
                    by?: S2SAddress;                                            // FRIEND: original inviter
                    thread?: string }                                           // GROUP: federatedThreadId

// GET /s2s/thread/roster →
{ members: Array<{ account: string; domain: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }> }

// GET /s2s/messages (and /messages/before) →
{ messages: Array<{ originSeq: number; contentType: string; content: string; ts: number }>;
  latestSeq: number; hasMore: boolean }
```

> **Federation invite unification:** add-friend and add-group share one endpoint (`/s2s/invite`) +
> one accept (`/s2s/invite-accept`), mirroring the unified local `Invite` table. The earlier
> `/s2s/friend-request` + `/s2s/friend-approve` + `/s2s/thread/invite` + `/s2s/thread/member` are
> **removed**. Roster propagation is **lazy pull** (the chat-open meta-pull reuses the profile-sync
> path + `/s2s/thread/roster`), NOT a push fanout.

---

## 2. Planned endpoints (Step 3 Phase B — cross-server group MESSAGING)

Phase A delivers invite/join + roster consistency; Phase B makes a federated group fully functional
(visible chat card + cross-server messages + leave).

### 2.1 Generalize existing endpoints (add optional `thread` param + roster gate; 1:1 path unchanged when `thread` absent)

| # | Endpoint | Group-mode call | Group gate |
|---|---|---|---|
| 9′ | `GET /s2s/messages` | `?thread=<fedId>&from=<sender>&after&take` (`to` omitted) | roster: signer has a live local member of T |
| 7′/8′ | `GET` / `POST /s2s/new-msg-map` | hint entry gains optional `thread`: `{from, to?, thread?, latestSeq}` | (same as today) |
| 12′ | `GET /s2s/get_file` | `?digest&thread&from` (`to` omitted) | roster gate |

### 2.2 Leave (Phase B)

A member leaving a mirror signals via `new-msg-map`; the origin discovers it on its next message pull
(the leaver's server returns "not friends" → the origin dissolves the membership). No dedicated
leave endpoint.

### 2.3 No new "send message" endpoint

A remote member's send reuses the p2p pattern verbatim: member stores locally (allocates per-sender
`originSeq`), signals the **origin** via `POST /new-msg-map` (8′), the **origin pulls** via
`GET /messages?thread&from&after` (9′) and aggregates, then signals the other members, who pull from
the origin. Origin is the single authority for roster **and** message history. See
`docs/federation-step3-design.md`.

---

## 3. Open design points

- **Group rename/avatar/description propagation** — the lazy meta-pull already covers identity
  (name/avatar via the profile-sync path); a future origin-only `thread/meta` op is an alternative if a
  push is wanted.
- **Quota hooks** (`docs/federation-quotas.md`) on the group message backfill (N-source pull).
