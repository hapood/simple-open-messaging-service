# E2E Test Improvement Proposals

Status: **PROPOSED — awaiting evaluation.** Nothing in this document changes
the canonical plan, progress logs, or handoff docs until an item is accepted;
accepted scenario items graduate into `browser-e2e-test-plan.md` (or
`android-e2e-test-plan.md`), and accepted orchestration items land in the
plan's rules or the tooling guide. This document can be deleted once all items
are either adopted or rejected.

Background: proposals come from the 2026-09-26 review that ran the full backend
suite (unit 1588/1588 at HEAD; e2e 561/564 with one deterministic federation
regression found and traced to commit `6396d260`) and reorganized the
browser/Android documentation split.

## Part 1 — Scenario gaps

Priority-ordered. Each row states the current evidence, so acceptance can be
judged against the progress dashboard rather than memory.

| # | Scenario | Current state (evidence) | Proposed plan change | Priority |
| - | -------- | ------------------------ | -------------------- | -------- |
| S1 | Login/session lifecycle error paths | `Web entry, account setup, OTP` is PARTIAL; QR login and self-registration are explicitly skipped in the current sweep; error paths have no PASS records | New cases: OTP expiry and repeated-wrong-code lockout presentation, disabled-account login attempt, admin force-logout while the user is mid-action (in-flight send), self-registration happy/denied path, QR login round trip | High |
| S2 | Same-account multi-tab | The 2.x matrix lists multi-tab-in-one-account checks, but no PASS evidence exists anywhere in the progress log | Formalize as its own small matrix: cross-tab SSE delivery, unread/mark-read sync across tabs, two tabs editing profile/preferences concurrently, tab closed during send | High |
| S3 | Send failure and recovery | Scattered across 9.1 (retry) and 6.x; Android hit a failed-upload placeholder defect; Web hardened send/upload recovery in commit `16530f44` | New chapter section: offline send → pending placeholder → recovery (auto-resend/manual retry/discard), large-file upload interruption with resumable continuation, UI state across SSE loss and restore | High |
| S4 | Quota circuit-breaker client UX | Backend quota e2e is complete (`quota.e2e-spec.ts`, `quota-transaction.e2e-spec.ts`); the client-side presentation of a quota-rejected send is untested; the Admin banner copy exists (`配额熔断已触发`) | Cases: send rejected at quota limit shows the defined error, state recovers after reset/top-up, thread history stays consistent | Medium |
| S5 | Long-thread virtual scroll | 7.14e investigated fractional-height drift; the CSS integer-pixel height rule exists because the virtual-scroll model is sensitive | A scale case: 500+ message thread with images — fast scroll during lazy image loading, reload with scroll-position restore, search jump deep into history, no height drift or duplicate rows | Medium |
| S6 | Concurrent writes (UI-reachable) | 5.12a covered kick-vs-demote only; group alias concurrent writes and announcement concurrent live edits are open in the dashboard | Same-account two devices mark-read simultaneously; two managers edit the announcement while both online; concurrent alias/pin writes | Medium |
| S7 | English-locale sweep | All plan assertions use zh-CN UI copy; en locale exists in `web/src/app/i18n/` | One sweep of chapters 0, 2, and 6 under the en locale (language-switch persistence included) | Low |
| S8 | Third-node (Charlie) federation groups | Open in the dashboard since the matrix was defined; Diana (Charlie) exists in the fixture matrix | Run the 5.1-5.8 core flow once with Charlie as the third member; no new case text needed, just execution | Low |

## Part 1b — Backend-delegation audit (2026-09-26)

The browser plan and progress log hand several variants to "the backend e2e
specs". Each claim was checked against actual backend test content, not just
file existence. Result: two claims fully verified, one partially verified, two
genuine gaps. After this audit, the plan's scope-revision notes were reworded
to state browser scope only; this section preserves the original delegation
claims and their verification.

| Claim (source) | Delegated variants | Verdict | Evidence |
| --- | --- | --- | --- |
| A: 5.10 scope revision — invitation expiry, decision races | invitation expiry; accept/reject races; simultaneous-manager decisions | **VERIFIED** | `user-intent-decision`, `group-join-decision`, `remote-member-membership-intent`: expired-request rejection, crossed-request collapse, concurrent duplicate acceptance activating exactly once, two approvals serialized without duplicate membership |
| A: 5.10 scope revision — disabled account | invite/approval when the invitee is disabled | **GAP** | No backend test covers a disabled user inside invitation/application/intent flows. Only auth-method disabling (`LOGIN_METHOD_DISABLED`) and admin session invalidation exist. Propose S9 |
| A: 5.10 scope revision — remote node unavailable | invitation/approval staged while the peer node is down | **PARTIAL** | Node-restart recovery exists for media download and delayed-state unfriend/re-add convergence, but no direct invite-while-peer-down → recovery convergence case. Propose S10 (low) |
| B: 6.3 scope revision — OS desktop-notification firing | browser Notification firing | **MIS-DELEGATED** | Backend push e2e (`push-probe`, `push-registration`) covers registration generations, token rotation, and probe receipts — the FCM dispatch pipe. No backend test can fire a browser Notification. The browser side skipped it because the driver lacks a permission-grant action, yet the call chapters already use `context.grantPermissions` for mic/cam. Fix: add a driver permission-grant action and take 6.3 notification firing back into browser scope, or re-word the handover honestly (Web desktop notifications accepted only via the Android FCM chain, 11.5a). Propose S11 |
| C: 6.12b — tombstone/moderation variants | receipt-timing; origin-retraction refusal; coordinate-collision; tombstone-before-message | **VERIFIED** | Named files deliver exactly the claimed variants: moderation-by-receipt and first-deletion-type precedence; P2P moderation of a remote author never published and retained-author receipts ignored; per-thread deletion coordinates without gaps under concurrent retries; later-arriving message stays deleted when the tombstone committed first |
| D: I.2c.3/4/5 — resolution isolation and staged timing | revision/namespace isolation; delayed completion across session switches; disconnect during pending resolution | **PARTIAL** | I.2c.3 verified (exact-revision no-fallback and viewer isolation in e2e; Meta-fact revision rejection in unit). I.2c.4 covered at mechanism level (in-flight listener capture, per-evidence independent notification) but no session-switch scenario test. I.2c.5 (disconnect during pending resolution) has no direct test. Propose S12 (low) |

New proposals arising from this audit:

- **S9 (high)**: disabled-account membership flow — e2e cases: approval of a
  pending invite/application whose invitee is disabled, decision attempt by a
  disabled account, and behavior after re-enable.
- **S10 (low)**: invitation/approval staged while the peer node is down,
  converging after the node returns (mirrors the existing media-restart
  recovery pattern).
- **S11 (medium)**: resolve the 6.3 notification ownership — preferred: driver
  `grantPermissions` support (notifications), case returns to browser scope;
  alternative: honest re-wording delegating to Android 11.5a only.
- **S12 (low)**: disconnect-during-pending-resolution backend case for profile
  resolution (I.2c.5).

## Part 2 — Orchestration improvements

Structural observation driving all six items: the only deterministic browser
gate today is `entry-smoke.spec.ts` (three pages render). Everything else is
AI-assisted exploration with hand-maintained Markdown evidence, so PASS results
are not replayable and regressions depend on manual re-execution. The backend
side already demonstrates the value of the opposite approach: this review's
deterministic federation e2e caught a regression (commit `6396d260`) that the
updated unit suite — also green — missed.

| # | Improvement | Concrete change | Cost | Payoff |
| - | ----------- | --------------- | ---- | ------ |
| O1 | Golden-path regression suite | Promote 20-30 deterministic cases from already-PASS matrices into `test/browser-e2e/*.spec.ts`: one happy path per chapter (login → friend → P2P text/read/withdraw → group → mention → forward → media → call invite) plus the highest-risk historical regressions (depth-4 refusal 30004, badge arithmetic, projection-status enum cast, avatar-save cap). Runs via `npm run test:browser` after every lab reset and backend deploy. The AI runner only explores new scope and never re-verifies promoted cases | Medium (one-time authoring + fixture helpers) | PASS history becomes replayable; regressions caught without manual re-runs |
| O2 | Case → execution-vehicle annotation | Mark every numbered case in the plan with `manual`, `ai`, or `spec:<file>`. Dashboard rows then record spec-gated scope as "covered by spec" instead of narrative, removing manual RETEST bookkeeping | Low | Prevents the evidence-rot this year's dashboard compression had to repair |
| O3 | Fixture lifecycle automation | Script the chapter-0 provisioning (admin API batch user creation + OTP injection) as a fixture layer; cases declare required roles; harness builds/destroys by run prefix | Medium | Eliminates the retained-fixture bookkeeping that dominates the handoff docs; removes cross-run fixture contamination |
| O4 | Machine-readable results | The adaptive runner already writes `result.json` but under disposable `/tmp`. Persist per-run JSON results under `test-results/` (gitignored) with run ID, build identity, case IDs, outcomes | Low | "Which case last passed on which build" becomes queryable instead of prose archaeology |
| O5 | Tiered CI gates | PR: backend unit + e2e; Web build + `test:browser:unit` + entry-smoke. Lab boot/deploy: golden-path suite (O1). Nightly: `federation:test` workload with convergence diagnostics (already exists and is mature) | Medium | Deterministic regression signal on every change; lab stays the acceptance environment |
| O6 | Closed-loop rule for new features | Codify the existing priority order (identity isolation → auth → send/receive → profile resolution → recovery → media → layout) as: plan case created → AI exploration → defect fixed → happy path promoted to a spec (O1) → dashboard updated. All five steps or the feature is not "tested done" | Low | Turns the evidence rules into an enforceable workflow |

## Suggested adoption order

1. **O2 + O4** (cheap, immediately improves bookkeeping).
2. **O1** golden-path suite, seeded from the highest-risk regressions first —
   ideally right after the current `6396d260` regression and the in-progress
   profile-resolution refactor are fixed and the suite is green again.
3. **O3**, because O1's specs need stable fixtures anyway.
4. **O5 + O6** once O1 exists.
5. Scenario items S1-S3 before S4-S8; S8 needs no plan change, only execution.
6. From the delegation audit: S11 (notification ownership) and S9
   (disabled-account flow) are the two real coverage holes — S11's wording fix
   can land immediately; S9's backend spec can be written once the current
   profile-resolution refactor compiles again. S10 and S12 are opportunistic.

## Evaluation checklist

For each item, decide: adopt / reject / defer, and for scenario items whether
the case text lands in the web plan, the Android plan, or both. Rejected items
should be recorded here (one line) before this document is deleted.
