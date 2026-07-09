# SOMS Federation — S2S API Reference

> Living reference for the federation server-to-server API. **Current** endpoints are built (Step 1 +
> Step 2). **Planned** endpoints belong to Step 3 (cross-server groups, designed — see
> `docs/federation-step3-design.md`). Captured here for review before Step 3 implementation.
>
> **Global prefix:** every path is `/api/v1/s2s/...` (`bootstrap.ts`). **Auth:** all endpoints are
> RFC9421 signature-guarded + trusted-peer-gated by `S2sSignatureGuard` **except `init`** (which *is*
> the trust step). **Address:** a user is always `{ account, domain }` — never an `@`-joined string on
> the wire (the `@` is a UI input aid only, split client-side).
>
> **Field name:** the account handle is `account` (English) / `账户名` (Chinese) — distinct from the
> display `name`. There is one account namespace: a regular user and an admin cannot share an account
> (an admin is a linked profile on a `User`, not a separate login).
>
> **`seq` convention:** `originSeq` is a per-`(thread, sender)` monotonic **int32**, **0-indexed** — the
> first message in a (thread, sender) is seq 0, then 1, 2, …; `-1` means "empty / before seq 0". It is
> sender-allocated (`(MAX(originSeq) ?? -1) + 1`), max 2³¹−1 (≪ 2⁵³, so it crosses the wire as a JSON
> **number**, never a string). Forward cursor = `afterSeq` (`seq > afterSeq`, default `-1` = from seq 0);
> backward cursor = `beforeSeq` (`seq < beforeSeq`, default `-1` = no upper bound → from latest), on the
> `/messages/before` twin. Display/order on each server uses its OWN local seq+arrival-time (a pulled
> message gets a fresh local id + `createdAt`); `originSeq` (+ `originServerTime`) are kept only for
> federation dedup/cursor.

---

## 1. Current endpoints (built)

| # | Method · Path | Params / Body | Extra gate | Purpose |
|---|---|---|---|---|
| 1 | `POST /s2s/init` | headers only (signature) | verify via requester `.well-known` | Bootstrap mutual trust; auto-accept trusted |
| 2 | `POST /s2s/friend-request` | body `S2SFriendRequest` | friend gate | Receive a friend request |
| 3 | `POST /s2s/friend-approve` | body `S2SPayload` | friend gate | Receive a friend approval |
| 4 | `GET /s2s/users/:account` | path `account` | — | A local user's full profile (avatar inline base64) |
| 5 | `GET /s2s/users/:account/revision` | path `account` | — | Lightweight profile-revision probe (no avatar) |
| 6 | `GET /s2s/new-msg-map` | query `cursor`(int,def0), `take`(int,cap1000) | — | Peer pulls OUR outbound hint snapshot |
| 7 | `POST /s2s/new-msg-map` | body `{origin, entries:[{from,to,latestSeq}]}` | `origin==signer` | Peer pushes ITS outbound hints (ACK fast) |
| 8 | `GET /s2s/messages` | query `from`,`to`,`afterSeq`(originSeq,def -1=from start),`take`(cap50) | APPROVED friendship | Forward pull: the SENDER's messages with `seq > afterSeq` |
| 9 | `GET /s2s/ping` | — | — | Signed liveness probe (advances watermark) |
| 10 | `GET /s2s/get_file` | query `digest`,`from`,`to` (HTTP Range) | 3-check media authz | Stream a chat-media asset by sha256 |
| 11 | `GET /s2s/messages/before` | query `from`,`to`,`beforeSeq`(originSeq,def -1=from latest),`take`(cap50) | APPROVED friendship | Backward twin of #8: `seq < beforeSeq`, batch oldest-first (reserved for external federation impls; SOMS is forward-only) |

### Body / response shapes

```ts
S2SAddress        = { account: string; domain: string }
S2SPayload        = { id: string; origin: string; from: S2SAddress; to: S2SAddress[]; ts: number }
S2SFriendRequest  = S2SPayload & {
  message?: string;                                       // ≤255-char note
  profile: { account: string; domain: string; displayName: string;
             avatar: { b64: string; w: number; h: number } | null; bio: string; updatedAt: number };
}
// GET /s2s/messages (and /messages/before) →
{ messages: Array<{ originSeq: number; contentType: string; content: string; ts: number }>;
  latestSeq: number; hasMore: boolean }
```

> **Timing/identity (done):** the served `messages` payload carries no `clientMessageId` (federation
> dedup is `originSeq` alone). The receiver stamps its own `createdAt = now()` (arrival — displayed) and
> stores the sender's `ts` as `originServerTime` (kept for future use, never shown). See
> `docs/federation-step3-design.md` §5.

---

## 2. Planned endpoints (Step 3 — cross-server groups)

### 2.1 New endpoints

| # | Method · Path | Body | Gate | Purpose |
|---|---|---|---|---|
| 11 | `POST /s2s/thread/invite` | `{ id, origin, thread:"thr_<rand>@<origin>", name, owner:S2SAddress, avatar?:{b64,w,h}\|null, by:S2SAddress, to:S2SAddress, ts }` | friend gate (inviter↔invitee) | Cross-server group invite → idempotent mirror find-or-create + GROUP_INVITE card |
| 12 | `POST /s2s/thread/member` | `{ id, origin, thread, op:"join"\|"leave"\|"kick"\|"role", user:S2SAddress, role?:"OWNER"\|"ADMIN"\|"MEMBER", by:S2SAddress, ts }` | signer == thread.originDomain (origin-only emitter); idempotent by `id` | Authoritative roster delta, fanned to all member-servers. Owner-transfer-to-foreign forbidden |

### 2.2 Generalized existing endpoints (add optional `thread` param + roster gate; 1:1 path unchanged when `thread` absent)

| # | Endpoint | Group-mode call | Group gate |
|---|---|---|---|
| 8′ | `GET /s2s/messages` | `?thread=<fedId>&from=<sender>&after&take` (`to` omitted) | roster: signer has a live local member of T |
| 6′/7′ | `GET` / `POST /s2s/new-msg-map` | hint entry gains optional `thread`: `{from, to?, thread?, latestSeq}` | (same as today) |
| 10′ | `GET /s2s/get_file` | `?digest&thread&from` (`to` omitted) | roster gate |

### 2.3 No new "send message" endpoint

A remote member's send reuses the p2p pattern verbatim: member stores locally (allocates per-sender
`originSeq`), signals the **origin** via `POST /new-msg-map` (7′), the **origin pulls** via
`GET /messages?thread&from&after` (8′) and aggregates, then signals the other members, who pull from
the origin. Origin is the single authority for roster **and** message history (per-sender cursor
`MAX(originSeq) WHERE threadId=T AND creator=<sender>`, derived from the DB; the RAM hint is only a
doorbell). See `docs/federation-step3-design.md`.

---

## 3. Open design points (for later discussion)

- **`thread/member` fan-out granularity:** one op per change vs. batched roster snapshot.
- **Roster resync endpoint:** a `GET /s2s/thread/:id/roster` backstop to heal lost fan-outs (origin-
  served), mirroring the message pull's trust model.
- **Quota hooks** (`docs/federation-quotas.md`) on the group fan-out / N-source backfill.
- **Group rename/avatar/description propagation** — a future `thread/meta` op (origin-only).
