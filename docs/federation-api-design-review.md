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
- [ ] **A2 — message item has no `kind` discriminator.** Item is flat
  `{ originSeq, contentType, content, ts }` (+ optional `creator`). Deferred edit/delete/receipts
  will force a breaking shape change. **Add `kind: 'message'` now** (+ a versioned envelope) — cheap
  forward-compat insurance.
- [x] **A3 — leave signal — DONE (implemented the documented `{code:50010}` path).** The leave signal
  now lives ONLY on the per-author pull RESPONSE (`{code: FEDERATION_GROUP_AUTHOR_LEFT}`, HTTP 200 — not
  403, so `getSigned` does not demote), NOT in the hint map. `notifyGroupLeave` writes a NORMAL
  per-author hint (latestSeq = cursor+1); the origin's `pullGroupFromAuthor` pulls → mirror's
  `serveOutboundMessagesGroupFrom` returns `{code:50010}` for a soft-left author (via
  `resolveGroupAuthorOrLeave`) → origin `softLeaveMemberAndBump`. The `left` flag is GONE from
  `NewMsgMapEntry`/`DirtyEntry` + `markDirty`/`scopeKey` + every service read + `pullHint`; the
  `handleLeaveHint` dead path is deleted. `/messages` per-author (forward + backward) carries the
  50010; media + all-senders do not. Unit specs green; e2e leave test asserts exactly this flow.

## 4. Other audit items (not yet discussed in detail)

- **B1** — `GET /thread/roster` path contradicts "no internal ids on the wire / address group by
  `!account`". Legacy name → `/group/:account/roster`.
- **B2** — revision probes modeled inconsistently: `/users/:account/revision`→`profileRev` vs
  `/group/:account/roster-revision`→`rosterRev` (different roots, different keys, parallel concerns).
- **B3 — RESOLVED (extended, not removed).** `/messages/before` was P2P-only + dead (SOMS forward-only).
  Decision: keep + extend to groups for full A1 symmetry. Now 3 shapes (P2P + group all-senders +
  group per-author w/ the {code:50010} leave signal), mirroring `/messages`. SOMS still has no internal
  backward caller, so the group legs are symmetric-by-construction but not e2e-exercised.
- **C1** — GET requests have hidden state side-effects: every successful signed read advances the
  peer liveness watermark via `markContactSuccess` inside `getSigned`; `/ping`'s server handler also
  mutates it. Liveness should be driven by an explicit signal, not implicit in reads.
- **C2** — dual error model: `BusinessException`→real HTTP 4xx (404/400/401) vs the bespoke
  `200 + business code` (leave signal). One S2S client can't parse uniformly.
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
- **E2** — doc row #6 mis-describes `/users/:account/revision` for groups ("the meta revision
  (updatedAt) the mirror compares on chat-open"). Actually returns `profileRev`; the roster
  comparison the mirror does on chat-open goes through the separate (undocumented) roster-revision
  endpoint. Doc folds two different probes into one.
- **E4** — `docs/federation-step2-design.md` says reconnect sweep "NOT YET WIRED" — it IS wired now
  (`FederationReconnectService.onModuleInit`, 60s `setInterval` + slow poll). Stale.
- **E5** — `docs/federation-quotas.md` header "deferred until Step 2 is designed" — Step 2 is built;
  rationale stale (quotas themselves still genuinely deferred).

## 6. E2E status (was the BLOCKER)

- The federation e2e was RED (10 failed | 13 passed). Root: the in-flight refactor folding
  `MessageThread.fedGroupAccount`→`groupUser.account` + `originDomain`→`groupUser.domain`, and
  `User.remoteUpdatedAt`→`remoteProfileRev` — the e2e selected the removed fields.
- **Rename now applied to the e2e spec** (`fedGroupAccount`→`groupUser.account`, `originDomain`→
  `groupUser.domain`, `remoteUpdatedAt`→`remoteProfileRev`; `findUnique(by fedGroupAccount)`→
  `findFirst(by groupUser.account)`). A separate agent is fixing the remaining cascade failures
  (the leave/Step-3 tests share outer-scope vars; the first failure starves the rest).
- `src/` typechecks clean; unit specs green (19/19). e2e green = the verification gate for any
  further wire/schema change (cursor unification §3).

---

## Resume checklist

1. **E2E green first** — the rename (fedGroupAccount→groupUser.account, originDomain→groupUser.domain,
   remoteUpdatedAt→remoteProfileRev, `left`→50010) is applied to the spec; a separate agent is fixing
   the remaining cascade failures. Do NOT start more message-API code until this is green (verification
   baseline + avoid racing the agent). [§6]
2. ~~Cursor unification~~ — RETRACTED (non-issue; two spaces intentional, one advancement strategy).
3. ~~Param rename + `toDomain`~~ — DONE. ~~A3 leave signal~~ — DONE (50010). ~~B3 /messages/before~~ —
   DONE (extended to groups). A1 symmetry complete (forward + backward, 3 shapes each).
4. Add `kind` discriminator (§3 A2) — cheap, do regardless (after e2e green).
5. Doc-only: clarify the response `latestSeq` per-shape contract — per-author = the author's max
   `originSeq` in-thread; all-senders = batch's highest thread `seq` (per-thread, not global); unused by
   SOMS receivers.
6. Work through the remaining §4 items (B1 roster-path rename, B2 revision-probe consistency, C1 GET
   liveness side-effects, C2 dual error model — now salient via 50010, C3 inline avatars) + §5 doc defects.
