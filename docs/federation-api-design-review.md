# Federation S2S API — Design Review (in progress)

> Working note. Session was paused mid-review of the **federation S2S API + interaction-flow
> design** (local/consumer API and e2e are explicitly out of scope here). Resume from this file.
>
> Scope rule: only **design flaws** in the federation surface — not implementation bugs, not the
> consumer API, not e2e health (see BLOCKER at the bottom — that is unrelated).

---

## 1. Confirmed decisions (don't re-litigate)

- **group/P2P symmetry is intentional.** A group is a `!`-User; the whole API addresses it the same
  way as a peer user (`to` = account). Keeping `/messages?to=` unified for both is the *consistent*
  choice — do NOT split into `/group/messages`. (Item A1 "three shapes = overload" was retracted on
  this basis.)
- **Unified exclusion invariant:** every `/messages` pull serves the conversation **excluding the
  requester's own server's authors** (`toDomain` / signer = self). Single-chat is per-author so it
  never returns self; group all-senders must also exclude self (see §2). This is the part of "统一"
  that is achievable and is now done.
- **Param model the user wants (requester-perspective):**
  `fromAccount` = author whose messages to pull · `toAccount` = the requester's user ·
  `toDomain` = the requester's domain (== self, == signature signer; **must be validated** —
  `toDomain === signerDomain` else `FEDERATION_BINDING_VIOLATION`, same pattern as
  `POST /new-msg-map`'s `origin === signer` check).
  - **Wrinkle:** the group **per-author** hub leg ALSO needs `fromDomain` (the author's domain) to
    resolve a foreign author stub on the origin. The 3-param model is incomplete for that one shape;
    keep `fromDomain`. So group-per-author carries 4 identity params, not 3.

## 2. DONE this session (in working tree)

- **All-senders self-exclusion fix** — `serveOutboundMessagesGroup` now adds
  `creatorItem: { domain: { not: signerDomain } }` to the query, so a mirror no longer pulls back its
  own members' messages. Symmetric with the P2P leg's documented invariant "never serve the
  requester's own authored messages". Cursor-safe (self's interleaved `seq`s are skipped by the `>`
  cursor; the mirror holds them locally). Strictly better than before (same DB scan, no wire/dedup
  waste, no pagination starvation under self-heavy bursts). Typechecks; unit-spec failures are
  pre-existing and unrelated.
  - Files: `src/federation/federation.service.ts` (serveOutboundMessagesGroup + doc comment),
    `docs/federation-s2s-api.md` (two lines noting all-senders excludes self).

## 3. DEFERRED — message API (the remaining "乱")

- [x] **Cursor "unification" — RETRACTED (non-issue, misframed).** Originally flagged "two number
  spaces (thread-seq vs originSeq) + two pagination strategies (PAGE vs JUMP) on one endpoint." Both
  halves were wrong on examination:
  - **Two spaces is intentional + inherent.** `originSeq` = per-`(thread,sender)`, sender-allocated
    cross-server dedup key; `seq` = receiver-local per-thread arrival order. The receiver trusts its
    OWN stored copy in every path (`after = res.messages[last].seq/originSeq` — the code comment says
    "NOT res.latestSeq"). Each shape rides the space meaningful to it: per-author shapes use originSeq
    (single author); all-senders uses thread-seq (multi-author has no cross-author originSeq meaning).
  - **"Two pagination strategies" did not exist.** The receiver advances page-by-page to the last
    STORED message in ALL shapes (P2P derives `MAX(originSeq)`; all-senders stores `pullUntil` = last
    stored seq). There is ONE advancement strategy. The "JUMP vs PAGE" was a misread of the RESPONSE
    `latestSeq` field — which SOMS receivers do NOT use for the cursor at all.
  - **No wire/schema change wanted.** The opaque-cursor / `pullUntil Int→String` idea is dropped.
  - **Only residue (doc-level):** the response `latestSeq` field has shape-dependent, thread-scoped
    semantics and is unused by SOMS — per-author = the author's max `originSeq` **within this thread**;
    all-senders = the batch's highest thread `seq` (note: `seq` is per-thread, not global — it was moved
    from a global counter to per-thread `MessageThread.curSeq` in an earlier change). Document the
    per-shape contract (or decide whether to keep `latestSeq` at all for external impls).
- [x] **Param rename + explicit `toDomain` — DONE** (`from→fromAccount`, `to→toAccount`, new validated
  `toDomain`; `fromDomain` kept). Applied across controller query params + the `POST /new-msg-map` body
  shape, the `NewMsgMapEntry`/`DirtyEntry` types (+ `scopeKey`/`markDirty`/`toWire`), every service
  entry-field read (`e.from`/`e.to` → `e.fromAccount`/`e.toAccount`) and every client URL builder (P2P,
  group all-senders, group per-author, `get_file`, roster) — each pull URL now carries
  `&toDomain=<ourDomain>`. `toDomain` is binding-checked (`toDomain === signer` → else
  `FEDERATION_BINDING_VIOLATION`) via `S2sController.requireBinding` on `/messages`, `/messages/before`,
  `/get_file` (NOT roster — different, trusted-peer gate). Docs (`docs/federation-s2s-api.md`) updated.
  `S2SAddress` objects (`S2SInvite.from/to`, `accepter`/`by`/`owner`) deliberately NOT renamed. Typechecks
  clean (`src/` 0 errors); unit specs green (19/19).
- [~] **A2 — message item `kind` discriminator — RETRACTED (YAGNI under the immutability principle).**
  The forward-compat rationale (future edit/delete/receipt item kinds) does not hold: edit/delete are a
  **NON-GOAL** — the origin has no authority to mutate receiver-local data once delivered (step2-design
  §9), so those kinds will never appear on the wire. Receipts are the only plausible future item kind,
  and they are append-only metadata (compatible with immutability) but v0.2 + undecided channel, with
  the `receipt` type already reserved in `federation-protocol.md` §10 — the discriminator lands with the
  first receipt, not now. A tag with no second union member today is speculative generality; add nothing.
- [x] **A3 — leave signal — DONE (implemented the documented `{code:50010}` path).** The leave signal
  now lives ONLY on the per-author pull RESPONSE (`{code: FEDERATION_GROUP_AUTHOR_LEFT}`, HTTP 200 — not
  403, so `getSigned` does not demote), NOT in the hint map. `notifyGroupLeave` writes a NORMAL
  per-author hint (latestSeq = cursor+1); the origin's `pullGroupFromAuthor` pulls → mirror's
  `serveOutboundMessagesGroupFrom` returns `{code:50010}` for a soft-left author (via
  `resolveGroupAuthorOrLeave`) → origin `softLeaveMemberAndBump`. The `left` flag is GONE from
  `NewMsgMapEntry`/`DirtyEntry` + `markDirty`/`scopeKey` + every service read + `pullHint`; the
  `handleLeaveHint` dead path is deleted. `/messages` per-author (forward + backward) carries the
  50010; media + all-senders do not. Unit specs green; e2e leave test asserts exactly this flow.
  **Update (C2):** the leave signal's *transport* changed — it is now **HTTP 410 GONE** (a resource
  response), not `200 + {code:50010}`. `getSigned` is status-aware (4xx no longer demotes), so the 410
  needs no "200-to-dodge-demote" trick. The semantics above (leave on the per-author RESPONSE, not the
  hint map; `softLeaveMemberAndBump`) are unchanged.

## 4. Other audit items (not yet discussed in detail)

- **B1 — RESOLVED.** `GET /s2s/thread/roster` → `GET /s2s/group/:account/roster`. The `thread/` root
  leaked an internal concept onto the wire, and the group `!account` was a query param while its sibling
  `/group/:account/roster-revision` (#6b) used a path param. Now both roster endpoints are siblings under
  `group/:account/` with the same path-param style. Controller (`@Get('group/:account/roster')`,
  `@Param('account')`, dropped the now-redundant missing-param guard — path routing supplies the segment
  + service null→404, mirroring `getGroupRosterRevision`), client URL in `pullGroupRoster`, and all 7 doc
  references renamed. Symmetric wire change (client + server same repo) → no compat alias needed.
- **B2 — RETRACTED (non-issue, same family as the cursor retraction).** The two revision probes look
  asymmetric but every axis of asymmetry is faithful to the data model, not accidental:
  - **Roots differ (`/users/` vs `/group/`)** because the owning table differs: identity is
    `User.profileRev` and a group IS a `!`-User, so `/users/:account/revision` uniformly serves peers
    **and** groups (one handle for any identity). Roster is `Group.rosterRev`, group-exclusive — a plain
    user has no roster, so `/users/` would be wrong. The root reflects the table.
  - **Response keys differ (`profileRev` vs `rosterRev`)** because they are different columns;
    generic `{ revision }` would lose self-documentation and force the consumer to track which probe.
  - **Leaf names differ (`/revision` vs `/roster-revision`)** by cardinality: a User has one
    mirror-relevant revision (bare `/revision` is unambiguous); a Group has two (identity via `/users/`
    + roster via `/group/`), so the roster leaf disambiguates explicitly. Load-bearing, not cosmetic.
  - **Considered + rejected:** fold both group revs into one `GET /group/:account/revision` →
    `{ profileRev, rosterRev }` to cut group chat-open from 2 probe RTTs to 1. Rejected — it makes
    `profileRev` reachable at two endpoints (redundant source of truth) for a marginal saving on a
    non-hot path (chat-open catch-up tolerates the extra probe).
  - No wire/schema change. The asymmetry models a real difference; forcing symmetry adds redundancy.
- **B3 — RESOLVED (extended, not removed).** `/messages/before` was P2P-only + dead (SOMS forward-only).
  Decision: keep + extend to groups for full A1 symmetry. Now 3 shapes (P2P + group all-senders +
  group per-author w/ the HTTP 410 leave signal), mirroring `/messages`. SOMS still has no internal
  backward caller, so the group legs are symmetric-by-construction but not e2e-exercised.
- **C1 — RETRACTED (investigation overturned the premise; same family as B2).** The "implicit
  liveness write in reads" is benign bookkeeping on an **observability-only** field, and the explicit
  signal C1 asks for already exists.
  - **`lastSuccessAt` drives no state machine.** Demotion is *failure-driven* (`markDemoted` on a failed
    signed op only — `getSigned` L548/L557, POST L514/L526, `get_file` L2638/L2652/L2671); a
    quiet-but-healthy peer is never demoted. The sweep + slowPoll select targets by `trustLevel`
    (`listRecoverablePeerDomains` / `listTrustedPeerDomains`, L1509/L1519) — **neither references the
    watermark**. Consumers are admin display + the watermark's own write-throttle.
  - **The explicit signal already exists.** `GET /s2s/ping` (L345) is the dedicated liveness probe; the
    sweep's `recover()` pings (reconnect L88); `ensurePeerTrusted` + repeat `/init` stamp `lastSuccessAt`
    on trust refresh. The organic-op success advance (`getSigned` L562, POST L523, `get_file` L2560) is a
    higher-fidelity *supplement* over that explicit floor — not what keeps peers alive.
  - **The success-advance is the matched complement of failure-demote.** `getSigned` couples both
    outcomes (failure→`markDemoted`, success→`markContactSuccess`). The failure half must stay inline
    (immediate demotion can't wait for a scheduler); removing only the success half is the incoherent
    "learn from failure, ignore success" split.
  - **Explicit-only is strictly worse.** No scheduled *outbound* `/ping` to healthy trusted peers exists
    (sweep pings only pending/demoted), so `/ping`-only would stale-out `lastSuccessAt` for
    quiet-but-healthy peers — degrading the observability it exists for — or require redundant ping
    traffic to peers with organic contact.
  - **REST-safety moot:** throttled (≤1/domain/3min), client-invisible, no S2S caching proxies, alters no
    read resource — access-counter-style bookkeeping safe methods permit.
  - **Residue (noted, not fixed):** minor inbound asymmetry — inbound GET/POST don't mark the signer
    alive (only `/ping` does), so a pull-only peer's liveness is under-reported on the pullee side.
    Observability-only, no functional impact; "fixing" it (guard writes on every inbound op) would ADD
    implicit writes, against the C1 spirit.
  - **Doc action:** state `lastSuccessAt`'s observability-only role explicitly so it isn't re-flagged.
- **C2 — RESOLVED (unified to one error channel: HTTP status).** The root cause was `getSigned` conflating
  *every* non-2xx with peer-failure (`!res.ok → markDemoted`); the leave signal's `200 + {code:50010}`
  bypass existed only to dodge that conflation (its own comment said so). Fixes:
  - **`getSigned` is status-aware:** demote only on `401/403/>=500` + network/timeout (genuine peer/trust
    failure); `400/404/410/…` (resource responses) throw a new typed `S2sResponseError{status,code}`
    WITHOUT demoting. This also fixes a **latent bug**: a legitimate 404 ("peer doesn't have that user")
    used to demote the entire healthy peer.
  - **Leave signal → HTTP 410 Gone.** `resolveGroupAuthorOrLeave` throws
    `BusinessException(FEDERATION_GROUP_AUTHOR_LEFT, HttpStatus.GONE)`; the global filter emits **410 +
    body `{code:50010}`** — one channel (HTTP status), code retained for diagnostics. 410 is semantically
    exact ("author-as-a-source is gone, permanent → stop pulling") and, as a resource response, does NOT
    demote. The two `serveOutboundMessagesGroup*` methods dropped their `'code' in author` return branch.
  - **Client `pullGroupFromAuthor`** catches `S2sResponseError{status:410}` → `softLeaveMemberAndBump`
    (replaces the `res.code === 50010` body-probe); re-throws everything else.
  - **Audited all getSigned callers:** every one already caught throws → skip/return-false/best-effort
    (`pullP2P`, `pullGroup`, `pullGroupRoster`, both `sync*IfStale`). The throw behavior is unchanged; the
    only delta is 4xx no longer demotes — the intended bug fix, no caller depended on it.
  - **Step 9 (bundled): POST acks RESTified.** `invite`/`invite-accept`/`init`/`new-msg-map` →
    **202 Accepted** (was `200 + {code:0,message,data}`). `sendSignedPost` never read the ack body (status
    only) and already accepted 202. (204 No Content was the precise choice for the sync legs but
    Nest+Fastify in this stack mishandles a 204 from an interceptor-returned `undefined` — 204 is used
    nowhere else in the codebase; every endpoint is `HttpStatus.OK` — so 202 is the consistent body-optional
    success for all federation POSTs.) Net: `code` now appears ONLY in error bodies; success responses are
    status-only. One coherent model.
  - Files: `federation.service.ts` (`S2sResponseError`, `getSigned`, `resolveGroupAuthorOrLeave`, both
    serve methods, `pullGroupFromAuthor`, `sendSignedPost`), `s2s.controller.ts` (POST handlers + leave
    via thrown 410), `test/federation.e2e-spec.ts` (leave-flow comments; assertions unchanged — DB
    outcomes + not-demoted guard still hold under 410). e2e 23/23 green.
- **C3** — avatars ferried inline as base64 `{b64,w,h}` in `/invite` + `/users/:account`, unbounded
  at the API layer. Reference by digest + reuse `/get_file`.
- **D1** — origin-hub group messaging: O(N member-servers) round-trips per message, all through the
  origin; origin down = group read-only; no read-path failover. (Structural; documented.)
- **D2** — loop-safety rests on one implicit rule ("exclude the domain just pulled from") at
  hint-write; `originSeq` dedup is the backstop. No hop-count / authoritative origin-field.
- **D3** — group roster is lazily convergent with no push and no freshness bound; a member who never
  opens the chat never sees joins/leaves; a lost leave hint stays undetected.
- **D4** — `/init` trust is one-directional per call; mutual trust reconciled lazily via
  `ensurePeerTrusted`.

## 5. Doc defects (cross-check)

- **E1** — `GET /group/:account/roster-revision` is built + live (server `getLocalGroupRosterRevision`
  → `Group.rosterRev`; client `fetchRemoteRosterRevision`; used by `syncGroupMetaIfStale`) but
  **absent from the API doc table** (12 listed, 13 built; grep in docs/ = zero hits).
- **E2 — RESOLVED.** Row #6 now states it returns `profileRev` (group IDENTITY revision); the roster
  comparison is the separate #6b probe. The two probes are no longer folded into one row.
- **E4 — RESOLVED.** Both stale "NOT YET WIRED" markers in `docs/federation-step2-design.md` corrected:
  §4.3 marker → BUILT (the 60 s sweep + one-directional pull + cert-rotation safety are all live in
  `FederationReconnectService`); §4.4 marker → PARTIAL (the 5 min slow poll is built and is the restart
  floor; pull-on-thread-open for messages remains open). §8 items 10/11 re-tagged `[BUILT]`/`[PARTIAL]` to
  match.
- **E5 — RESOLVED.** `docs/federation-quotas.md` header + §1 no longer say "deferred until Step 2 is
  designed" / "nothing to count" — Step 2+3 are built and the traffic is live; deferral is now framed as
  priority (not precondition), quotas still genuinely unbuilt.

## 6. E2E status — GREEN (verification gate cleared)

- Federation e2e is **23 passed (23)** (verified `npm run test:e2e -- test/federation.e2e-spec.ts`,
- ~46 s, exit 0). The rename (`fedGroupAccount`→`groupUser.account`, `originDomain`→`groupUser.domain`,
  `remoteUpdatedAt`→`remoteProfileRev`, `left`→50010) landed in commit `98502df` ("all tests green");
  the cascade failures (shared outer-scope vars across the leave/Step-3 tests) are resolved.
- `src/` typechecks clean; unit specs green (19/19). **The gate is cleared** — any further wire/schema
  change now has a green baseline to regress against.

---

## Resume checklist

1. ~~E2E green~~ — DONE (23/23, commit `98502df`). Gate cleared.
2. ~~Cursor unification~~ — RETRACTED (non-issue; two spaces intentional, one advancement strategy).
3. ~~Param rename + `toDomain`~~ — DONE. ~~A3 leave signal~~ — DONE (50010). ~~B3 /messages/before~~ —
   DONE (extended to groups). A1 symmetry complete (forward + backward, 3 shapes each).
4. ~~Doc defects E1/E2/E4/E5~~ — RESOLVED this session (§5). E1 was already resolved (#6b row); E2/E4/E5
   fixed + §6 + this checklist updated.
5. ~~A2 `kind` discriminator~~ — **RETRACTED** (§3). Under the immutability principle (origin can't
   mutate receiver-local data → edit/delete non-goal; receipts v0.2 + undecided, `receipt` type reserved),
   a tag with no second union member today is YAGNI. See the `federation-origin-cannot-mutate-local` memory.
6. Doc-only: clarify the response `latestSeq` per-shape contract — per-author = the author's max
   `originSeq` in-thread; all-senders = batch's highest thread `seq` (per-thread, not global); unused by
   SOMS receivers.
7. Remaining §4 audit items: ~~B1 (roster-path rename)~~ — DONE. ~~B2 (revision-probe consistency)~~
   — RETRACTED. ~~C1 (GET liveness side-effects)~~ — RETRACTED (lastSuccessAt is observability-only;
   drives no state machine; explicit `/ping` signal already exists; success-advance is failure-demote's
   matched complement). ~~C2 (dual error model)~~ — DONE (one error channel: `getSigned` status-aware
   + leave → HTTP 410 GONE; + Step 9 POST acks → 202/204). C3 (inline avatars → digest + `/get_file`).
