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

- [ ] **Cursor unification — the real mess.** `afterSeq` / `latestSeq` carry two different number
  spaces on the same endpoint: **thread-seq** (group all-senders) vs **originSeq** (single +
  per-author); and two pagination strategies: **PAGE** (group all-senders, batch-by-batch) vs
  **JUMP** (single/per-author, `latestSeq = author global MAX`). The JUMP/PAGE split is *justified*
  by use-case (single steady-state vs group catch-up); the space split is inherent (multi-author has
  no single originSeq). Options:
  - **(a) Opaque cursor** — `?after=<token>`, response `nextCursor`; server encodes `{space, seq}`.
    Hides both. **Needs a schema change**: `MessageThread.pullUntil` Int → String (store the opaque
    token). **Defer until the e2e blocker (§5) is green** so a wire+schema change is verifiable.
  - **(b) Named cursors** — `afterThreadSeq` (group all-senders) vs `afterOriginSeq` (single/per-author).
    No schema; explicit + debuggable; less "unified" surface. Reasonable no-schema interim.
  - **(c) Status quo + clearer docs** — lowest value.
  - **Lean:** (a) once e2e is green; (b) as an interim if we want progress before then.
- [x] **Param rename + explicit `toDomain` — DONE** (`from→fromAccount`, `to→toAccount`, new validated
  `toDomain`; `fromDomain` kept). Applied across controller query params + the `POST /new-msg-map` body
  shape, the `NewMsgMapEntry`/`DirtyEntry` types (+ `scopeKey`/`markDirty`/`toWire`), every service
  entry-field read (`e.from`/`e.to` → `e.fromAccount`/`e.toAccount`) and every client URL builder (P2P,
  group all-senders, group per-author, `get_file`, roster) — each pull URL now carries
  `&toDomain=<ourDomain>`. `toDomain` is binding-checked (`toDomain === signer` → else
  `FEDERATION_BINDING_VIOLATION`) via `S2sController.requireBinding` on `/messages`, `/messages/before`,
  `/get_file` (NOT roster — different, trusted-peer gate). Docs (`docs/federation-s2s-api.md`) updated.
  `S2SAddress` objects (`S2SInvite.from/to`, `accepter`/`by`/`owner`) deliberately NOT renamed. Typechecks
  clean (`src/` 0 errors); buffer spec green; 6 service-spec failures are the pre-existing baseline.
- [ ] **A2 — message item has no `kind` discriminator.** Item is flat
  `{ originSeq, contentType, content, ts }` (+ optional `creator`). Deferred edit/delete/receipts
  will force a breaking shape change. **Add `kind: 'message'` now** (+ a versioned envelope) — cheap
  forward-compat insurance.
- [ ] **A3 — leave signal `HTTP 200 { code: 50010 }`** makes `/messages` return two structurally
  incompatible 200 bodies, purely to dodge the demote-on-403 path. Couples leave-detection to
  message-flow (a leaver who never sent is only caught by the lazy meta-pull). Move roster-state out
  of the message body — a dedicated membership-state probe or a roster-revision delta.

## 4. Other audit items (not yet discussed in detail)

- **B1** — `GET /thread/roster` path contradicts "no internal ids on the wire / address group by
  `!account`". Legacy name → `/group/:account/roster`.
- **B2** — revision probes modeled inconsistently: `/users/:account/revision`→`profileRev` vs
  `/group/:account/roster-revision`→`rosterRev` (different roots, different keys, parallel concerns).
- **B3** — `GET /messages/before` is built + guarded + maintained but **never called by SOMS**
  (forward-only). Dead surface / attack surface.
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

## 6. BLOCKER (unrelated to this review — do not confuse)

- **Federation e2e is RED (10 failed | 13 passed of 23).** Cause: an in-flight refactor that **folds
  `MessageThread.fedGroupAccount` into `groupUser.account`** (the schema field was removed; migration
  `20260710140000_rename_fed_group_account` renamed `federatedThreadId→fedGroupAccount`, then a later
  edit dropped the column in favor of `groupUser.account`). `test/federation.e2e-spec.ts` still
  selects the removed field (e.g. line ~930: `select: { fedGroupAccount: true }`) → runtime
  `Unknown field fedGroupAccount`. Fix = update test (+ any code) refs to read via `groupUser.account`.
  - **Not caused by the message-API work.** Must be resolved before any schema-changing API change
    (opaque cursor §3) can be verified.
- Note: `migrate deploy` itself is clean on a fresh DB (all 7 migrations apply). The failure is a
  stale test/code reference to a removed field, plus the base `soms_test` DB had drifted from
  migration history (reset: drop+create `soms_test` + `migrate deploy`).

---

## Resume checklist

1. Decide cursor approach (§3): opaque (needs §6 green first) vs named-cursor interim vs docs-only.
2. ~~Apply param rename + `toDomain` validation (§3)~~ — DONE.
3. Add `kind` discriminator (§3 A2) — cheap, do regardless.
4. Work through §4 + §5 doc defects.
