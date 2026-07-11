# SOMS Federation — S2S API Reference

> Living reference for the federation server-to-server API. **Built:** Step 1 (trust + friend), Step 2
> (1:1 messages + media), **Step 3 Phase A** (unified invite — friend + group share `/s2s/invite`;
> cross-server group invite/join + lazy roster meta-pull), **Step 3 Phase B** (cross-server group
> **messaging** via the origin-hub; group-invite chat card visibility; leave). The GROUP invite carries
> `sinceSeq` (origin curSeq at invite time) so a new member seeds `pullUntil` and starts from invite-time,
> not full history. **Deferred:** a durable active-liveness leave backstop, group rename/avatar push, the
> frontend card/account-resolution adaptation. See `docs/federation-step3-design.md`.
>
> **Global prefix:** every path is `/api/v1/s2s/...` (`bootstrap.ts`). **Auth:** all endpoints are
> RFC9421 signature-guarded + trusted-peer-gated by `S2sSignatureGuard` **except `init`** (which *is*
> the trust step). **Address:** a user is always `{ account, domain }` — never an `@`-joined string on
> the wire (the `@` is a UI input aid only, split client-side). **No internal ids on the wire:** the
> account params are always bare accounts — `fromAccount` (the author), `toAccount` (the requester's
> user, or the group `!account`). A group is addressed by its `!account` (the `fedGroupAccount`, stored
> verbatim — never the DB thread id). `fromDomain` is the author's domain (the author may be foreign);
> `toDomain` is the requester's domain and is **binding-checked against the RFC9421 signer** on the
> message + media endpoints (`toDomain === signer`, else `FEDERATION_BINDING_VIOLATION`) — the signature
> proves only the signer domain, so the requester explicitly asserts which domain `toAccount` lives on.
>
> **`seq` convention:** `originSeq` is a per-`(thread, sender)` monotonic **int32**, **0-indexed** — the
> first message in a (thread, sender) is seq 0, then 1, 2, …; `-1` means "empty / before seq 0". It is
> sender-allocated (`(MAX(originSeq) ?? -1) + 1`), max 2³¹−1 (≪ 2⁵³, so it crosses the wire as a JSON
> **number**, never a string). Forward cursor = `afterSeq` (`seq > afterSeq`, default `-1` = from seq 0);
> backward cursor = `beforeSeq` (`seq < beforeSeq`, default `-1` = no upper bound → from latest), on the
> `/messages/before` twin. Display/order on each server uses its OWN local seq+arrival-time; `originSeq`
> (+ `originServerTime`) are kept only for federation dedup/cursor.
>
> **Cursor model (Phase B):** a member's catch-up cursor is the thread-level `MessageThread.pullUntil`
> (the remote server's thread seq pulled up to), seeded by the invite's `sinceSeq` at join and advanced to
> the response `latestSeq` after each pull. A GROUP mirror pulls the WHOLE thread (all senders, keyed by
> the origin's thread `seq`) via `pullUntil`; the ORIGIN pulls each member per-author (`fromAccount=author`,
> `originSeq` cursor — the one place derivation remains, since the origin aggregates N authors). `pullUntil`
> defaults to `-1` (full history) until seeded.

---

## 1. Current endpoints (built)

| # | Method · Path | Params / Body | Extra gate | Purpose |
|---|---|---|---|---|
| 1 | `POST /s2s/init` | headers only (signature) | verify via requester `.well-known` | Bootstrap mutual trust; auto-accept trusted |
| 2 | `POST /s2s/invite` | body `S2SInvite` (`kind` FRIEND\|GROUP) | friend gate (`from`↔`to`) | **Unified** deliver: a friend-add OR group-invite. FRIEND carries the sender `profile` (stub localization); GROUP carries the group identity + a revision (`groupRevision`) so the receiver's mirror update is revision-gated. Idempotent by `(origin, id)` + the Invite partial-unique indexes |
| 3 | `POST /s2s/invite-accept` | body `S2SInviteAccept` (`kind`) | — | The recipient accepted. FRIEND → the inviter's server creates the P2P thread (accept-wins); GROUP → the group **origin** records the joiner on its canonical roster (+ bumps the group meta revision) |
| 4 | `GET /s2s/thread/roster` | query `toAccount` (group `!account`) | trusted peer | The ORIGIN serves the canonical roster (active members, wire addresses + roles) — pulled by a mirror's lazy meta-pull on chat-open |
| 5 | `GET /s2s/users/:account` | path `account` | — | A local user's full profile (avatar inline base64). A group is a `!`-User, so this also serves a group's identity |
| 6 | `GET /s2s/users/:account/revision` | path `account` | — | Lightweight profile-revision probe (no avatar). For a group `!`-User this is the **meta revision** (`updatedAt`) the mirror compares on chat-open |
| 7 | `GET /s2s/new-msg-map` | query `cursor`(int,def0), `take`(int,cap1000) | — | Peer pulls OUR outbound hint snapshot |
| 8 | `POST /s2s/new-msg-map` | body `{origin, entries:[{fromAccount,fromDomain,toAccount,latestSeq}]}` | `origin==signer` | Peer pushes ITS outbound hints (ACK fast) |
| 9 | `GET /s2s/messages` | query `fromAccount`,`fromDomain`,`toAccount`,`toDomain`,`afterSeq`(originSeq,def -1=from start),`take`(cap50) | active P2P thread | Forward pull: the SENDER's 1:1 messages with `seq > afterSeq` |
| 10 | `GET /s2s/messages/before` | query `fromAccount`,`toAccount`,`toDomain`,`beforeSeq`(def -1=from latest),`take`(cap50) | active P2P thread | Backward twin of #9: `seq < beforeSeq`, oldest-first (reserved for external impls; SOMS is forward-only) |
| 11 | `GET /s2s/ping` | — | — | Signed liveness probe (advances watermark) |
| 12 | `GET /s2s/get_file` | query `digest`,`fromAccount`,`fromDomain`,`toAccount`,`toDomain` (HTTP Range) | 3-check media authz | Stream a chat-media asset by sha256 |

### Body / response shapes

```ts
S2SAddress = { account: string; domain: string }

// POST /s2s/invite — the `kind` discriminates; the receiver dispatches.
S2SInvite  = { id: string; origin: string; ts: number; kind: 'FRIEND' | 'GROUP';
               from: S2SAddress; to: S2SAddress; note?: string;                 // ≤255
               profile?: S2SProfile;                                            // FRIEND only
               group?: string; groupName?: string;                              // GROUP: the group `!account` (== fedGroupAccount)
               groupAvatar?: { b64: string; w: number; h: number } | null;
               groupRevision?: number; owner?: S2SAddress }                     // GROUP: origin !-User.updatedAt; owner

// POST /s2s/invite-accept
S2SInviteAccept = { id: string; origin: string; ts: number; kind: 'FRIEND' | 'GROUP';
                    accepter: S2SAddress; inviteOriginId?: string;
                    by?: S2SAddress;                                            // FRIEND: original inviter
                    group?: string }                                            // GROUP: the group `!account`

// POST /s2s/new-msg-map entries (and GET /s2s/new-msg-map snapshot) — `toAccount` is a peer user account
// (P2P) or the group `!account` (group). `fromDomain` is always present (the author may be foreign).
NewMsgMapEntry = { fromAccount: string; fromDomain: string; toAccount: string; latestSeq: number }

// GET /s2s/thread/roster?toAccount=<groupAccount> →
{ members: Array<{ account: string; domain: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }> }

// GET /s2s/messages — three shapes (P2P per-author; group all-senders; group per-author hub leg).
// `toDomain` (== the signer) is required on every shape + binding-checked:
//  ?fromAccount=A&fromDomain=D&toAccount=B&toDomain=R&afterSeq&take        → P2P: A's messages for B (originSeq space)
//  ?toAccount=!group&toDomain=R&afterSeq&take                              → group ALL-SENDERS EXCEPT the requester's own authors (mirror←origin, thread-seq space, pullUntil)
//  ?toAccount=!group&fromAccount=A&fromDomain=D&toDomain=R&afterSeq&take   → group PER-AUTHOR (origin←mirror hub leg, originSeq space)
// All-senders response carries each message's creator (multiple authors in one stream):
{ messages: Array<{ originSeq: number; creator: { account; domain }; contentType: string; content: string; ts: number }>;
  latestSeq: number; hasMore: boolean }
// Per-author / P2P response (creator implicit = from):
{ messages: Array<{ originSeq: number; contentType: string; content: string; ts: number }>;
  latestSeq: number; hasMore: boolean }
// Per-author group pull — leave signal: if the author is no longer an active member on the serving server
// (it soft-left), the response is HTTP 200 with a business code instead of a payload (NOT 403 — a 200 is a
// business outcome so getSigned does NOT demote the peer). The origin reads this as "member left" →
// softLeaveMember on its canonical roster + bump the group meta:
{ code: 50010 /* FEDERATION_GROUP_AUTHOR_LEFT */ }
```

> **Federation invite unification:** add-friend and add-group share one endpoint (`/s2s/invite`) +
> one accept (`/s2s/invite-accept`), mirroring the unified local `Invite` table. The earlier
> `/s2s/friend-request` + `/s2s/friend-approve` + `/s2s/thread/invite` + `/s2s/thread/member` are
> **removed**. Roster propagation is **lazy pull** (the chat-open meta-pull reuses the profile-sync
> path + `/s2s/thread/roster`), NOT a push fanout.

---

## 2. Phase B — cross-server group MESSAGING (BUILT, origin-hub)

Phase A delivered invite/join + roster consistency; Phase B makes a federated group carry messages. The
origin is the single authority for roster **and** message history (the hub). No new endpoints — the
existing ones are generalized to be group-aware, all account-based (`toAccount` = the group `!account`,
never a thread id):

### 2.1 Generalized endpoints (BUILT)

| # | Endpoint | Group-mode shape | Group gate |
|---|---|---|---|
| 9 | `GET /s2s/messages` | `?toAccount=!group&toDomain=R&afterSeq&take` (ALL-SENDERS **except the requester's own authors**, mirror←origin, thread-seq space) **or** `?toAccount=!group&fromAccount=A&fromDomain=D&toDomain=R&afterSeq&take` (PER-AUTHOR, origin←mirror hub leg, originSeq space). P2P unchanged: `?fromAccount=A&fromDomain=D&toAccount=B&toDomain=R`. | roster: signer has an active local member of the group; per-author also gates the author — an INACTIVE author returns HTTP 200 `{code: 50010}` (leave signal), not 403 |
| 7/8 | `GET`/`POST /s2s/new-msg-map` | entry `{fromAccount, fromDomain, toAccount, latestSeq}` — `toAccount` is a peer (P2P) or the group `!account` (group). | `origin==signer` (POST) |
| 12 | `GET /s2s/get_file` | `?digest&fromAccount=A&fromDomain=D&toAccount=!group&toDomain=R` (group) or `?digest&fromAccount=A&toAccount=B&toDomain=R` (P2P) | roster gate (group) / friendship gate (P2P) + digest-in-thread |
| 4 | `GET /s2s/thread/roster` | `?toAccount=<groupAccount>` | trusted peer |

### 2.2 Topology + loop-safety (BUILT)

A remote member's send stores locally, signals the **origin** via `POST /new-msg-map`; the **origin
pulls** it per-author (`GET /messages?toAccount=!group&fromAccount&after`), aggregates, then re-signals
the other member-servers, who pull the whole thread (`GET /messages?toAccount=!group&afterSeq=pullUntil`)
from the origin.
Loop-safety is one rule at the hint-write layer: `signalOutbound` excludes the domain the message was
just fetched from — a mirror's only destination is the origin it pulled from (excluded → signals
nothing), and the origin re-signals every foreign domain except the source. `originSeq` dedup is the
backstop.

### 2.3 Leave (BUILT — pull-reject)

A member leaving a mirror (`group/leave`) is soft-left locally, then `notifyGroupLeave` writes a NORMAL
per-author hint for the leaver (`fromAccount`=leaver, `toAccount`=`!group`, `latestSeq`=`MAX(leaver originSeq)+1`)
to the origin. The origin drains it into the per-author hub leg and `GET /s2s/messages?toAccount=!group&fromAccount=leaver…`;
the mirror's per-author gate sees the leaver is no longer active and answers **HTTP 200
`{ code: 50010 FEDERATION_GROUP_AUTHOR_LEFT }`** (not 403). The origin `softLeaveMember`s the leaver on its
canonical roster + bumps the group-meta revision (mirrors reconcile on the next chat-open meta-pull). The
200 is a business outcome → `getSigned` marks contact success and the peer is **not demoted**.

The hint is volatile — a lost leave leaves the origin's roster stale until a future pull retriggers for that
author. A durable active-liveness backstop is deferred.

### 2.4 Group-invite chat card (BUILT)

`writeInvites` writes the `GROUP_INVITE` card into the inviter's P2P thread for EVERY target (local:
shared thread; federated: the inviter's P2P mirror → flows to the invitee via the Step-2 pull). The card
is `{type:'GROUP_INVITE', from: <inviterAccount>, group: <groupAccount>}` — accounts only, no internal
ids. The invitee resolves their pending invite by the group `!account` (`/invite/detail` +
`/invite/accept` accept a group account via `InviteService.resolveInviteId`). Frontend card-rendering
adaptation (resolve by account) is the remaining consumer-side work.

---

## 3. Open / deferred design points

- **`sinceSeq` "no history" join option** — `MessageThread.pullUntil` exists and is seeded by the invite's
  `sinceSeq`; currently new members default to `-1` (full history). Wiring the inviter to send `sinceSeq`
  and the receiver to seed `pullUntil` from it (for the "latest = no history" choice) is deferred.
- **Active member-liveness detection** — a durable backstop beyond the volatile pull-reject leave hint
  (a leave whose hint-push was lost stays undetected until a future pull retriggers for that author).
- **Frontend** — the invite-row card + invite-detail dialog still read the legacy `{fromUserId, groupUserId,
  inviteId}` shape; adapt them to the account-based `{from, group}` card.
- **Group rename/avatar/description push** — the lazy meta-pull already covers identity; a push is optional.
- **Quota hooks** (`docs/federation-quotas.md`) on the group message backfill.
