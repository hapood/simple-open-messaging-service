---
name: web-testing
description: Execute two-node main-workflow or three-node full SOMS Web/Admin browser acceptance using the Pi setup wizard, persistent Playwright driver, local progress records, and explicit operator gates for bugs and driver changes. Also supports targeted local playground and federation regression work.
---

# Project Web testing

## Start and select scope

`npm run pi:webtest` opens the interactive setup wizard. `/webtest` opens it again.
It collects quick (two nodes) or full (three nodes), each node's external SOMS URL,
optional internal Admin URL, and optional Admin username (default `admin`). API
routes and the default `/admin/` entrance are derived from the external URL.
An internal Admin origin without a path gains `/admin/`. Passwords are entered
through masked TUI dialogs. The extension alone saves reusable configuration in
`test/browser-e2e/.local/config.json` (Git-ignored, private plaintext test credentials)
and transfers passwords to the driver through a private pipe. Startup offers use
or modify for saved settings instead of collecting them per session. Never ask
for a password in chat, read `.env` or the local config into model context, or put
credentials/OTPs in tool parameters, other files, command arguments, evidence,
screenshots, or traces.

The wizard authorizes dedicated test fixtures on the confirmed deployments,
routine non-destructive local checks and temporary test-step creation/editing.
Do not request repeated approval for these normal test operations. This includes
checking Git state, reading/searching code, creating temporary directories and
synthetic files, and writing/editing scenario `.mjs` files under the step directory.
It does not authorize editing source, resetting databases/profiles, changing
credentials, restarting services or mutating pre-existing business data.

Read `docs/development/browser-testing.md`, then the selected plan:

- Quick: `docs/development/browser-e2e-quick-test-plan.md` (two nodes).
- Full: `docs/development/browser-e2e-test-plan.md` (three nodes, including
  cross-cutting and viewport matrices). Browser runs never include Android 11.x.

Use `rg -n '^## |^### |<case id>|<feature>'` to locate relevant detailed rules.
Do not load an unrelated Android plan or obsolete shared progress/handoff files.
Source and documentation comments remain English; communicate with the user in
their language.

## Run state and progress

`webtest_run status` returns the active run and its local directory:
`test-results/browser-e2e/acceptance/<run-id>/`.

- `run.json` is authoritative. `progress.md`, `handoff.md`, and `bugs/` are
  tool-generated projections; do not edit them with shell/file tools.
- Before business mutations, expand every selected matrix into stable,
  assertion-sized case IDs with `webtest_run register`, using `cases: [{id, title}]`
  in batches of up to 200. Registration creates only `NOT RUN` cases, preserves
  existing results and evidence, and rejects duplicate IDs or changed existing
  titles atomically. Use `record` for individual verdicts. Both actions return
  compact summaries; use `status` when the full run state is needed.
  Initial chapter placeholders are NOT coverage. Complete a chapter only after
  every required child item has a recorded verdict.
- Record each completed item immediately using `record`: ID, scope/title,
  outcome and concrete evidence. Use `checkpoint` with `next` for fixture,
  cleanup, profile mappings, build identities, next action and unresolved gaps.
- Keep evidence concise and non-secret. Include participant/node/role, viewport,
  UI actions, assertions, expected/actual, observation deadline and artifact paths.
- `finish` refuses unfinished items. Execution completion is not a PASS when
  BUG, BLOCKED, SKIPPED or NOT VERIFIED gaps remain.
- `/webtest-status` shows progress. `/webtest-resume RUN_ID` reloads an existing
  run with the shared local configuration, provided its mode/endpoints/account
  match. Startup offers use/modify; selecting use skips credential entry. `/reload`
  restores the session's progress run ID, not a session-specific credential copy.
  New sessions share settings but need an explicit run ID to resume earlier work.
  Delete the shared config to forget credentials; never print/read it into model
  context. Verify deployment versions, identity and fixtures; historical PASS
  does not verify a new build.

## Preflight and browser operation

1. Inspect `git status` as a routine check without another confirmation; preserve all
   unrelated changes. Do not automatically start/restart/reset services.
2. Call `browser_driver preflight` to check Web/Admin reachability and edge/backend
   compatibility contracts. Record exact returned server/API versions. Reject
   wrong nodes, invalid certificates, redirects to unapproved origins or
   unavailable services as setup blocks, not product bugs.
3. Call `status`. Open isolated profiles with explicit `target: "federation"`
   and the selected node key (`alpha`, `bravo`, optionally `charlie`). These are
   aliases for the user-confirmed deployment, not inferred hostnames.
4. Use `adminLogin`, `issueOtp`, then `userLogin` sequentially. Every call to
   these three helpers must include the explicit selected `node` (`alpha`,
   `bravo`, or `charlie`), even when `user` identifies an existing profile.
   Never infer the node from a profile name. Verify the actual
   federation domain before mutations: `adminLogin` reads authenticated Admin
   `/api/v1/admin/me` (`somsDomain`) and persists it in the run. Log into every
   selected node's Admin before creating fixtures. Missing, changed or duplicate
   identities pause the run; never guess from hostnames or ask for a manual domain
   just to bypass discovery. Verify visible account identity in each user context.
   Unsupported MFA/login/UI contracts are a pause, not permission to bypass them.
5. Use one profile per account/session, a dedicated fixture prefix for this run,
   and only authorized test data. OTPs are node/account scoped and memory-only.
6. Temporary trusted `.mjs` steps belong in `/tmp/soms-browser-e2e/steps/`.
   Export `default async ({ page, expect, pageOf, shot, nodes }) => { ... }`.
   Use `browser_driver eval`; do not launch an alternate browser client.
   Reuse `test/browser-e2e/steps/ui-fixtures.mjs` for UI fixture creation.
7. Perform business actions through visible controls. APIs may prepare fixtures
   or supplement assertions, but API-only behavior cannot establish a UI PASS/BUG.
   Prefer semantic/structural selectors and Playwright web-first assertions;
   fixed sleeps and visual intuition are not success conditions.
8. Capture relevant screenshots, errors and bounded traces only after login.
   Never trace authentication/OTP issuance or screenshot authentication surfaces.
   Artifacts may still contain session data: keep local, private and uncommitted.
9. State-dependent actions remain sequential. Close contexts cleanly; never
   delete profile locks or reset a profile merely to resume.

Configured deployments use HTTP/UI preflight, NOT local HMR status files.
Never invent a successful local build for a remote deployment. Local lab and
playground regression remain separate workflows in `browser-testing.md` and
`browser-e2e-tools.md`; local lab federation still requires current successful
Web/Admin HMR builds. Arbitrary URLs are not allowed: the driver restricts
navigation to confirmed Web/Admin origins. Trusted step modules are not sandboxed.

## Mandatory pause and confirmation

On a browser-command failure, the extension automatically pauses acceptance and
writes an unclassified issue. Do not continue mutations or call an alternate
client before diagnosis. Read-only diagnostics (`status`, `inspect`, `errors`,
`shot`, `traceStop`) and clean context closure remain available when safe.

Invocation mistakes and agent-authored temporary-step mistakes do NOT require
operator confirmation. After safe diagnosis, call `webtest_run recover` with the
current issue `id`, `scope: "arguments"` or `"temporary-step"`, and `evidence`
explaining the observed contract, cause and exact correction. Temporary-step
recovery also requires the absolute `path` of the `.mjs` file under
`/tmp/soms-browser-e2e/steps/`. Recovery retains the failure and diagnosis, marks
an agent retry (not an operator approval), and resumes the run without a dialog.
Correct and locally check the arguments/temporary script, then rerun the failed
assertion. For progress-tool parameter validation errors that leave the run
running, simply correct the parameters and retry; `record` requires `id`,
`title`, `outcome` and concrete `evidence`. Do not create an operator pause for
these routine mistakes.

This exception never authorizes driver, committed/shared helper, harness,
configuration, credential, or product changes, destructive operations or resets.
Do not use a temporary script to conceal or work around a product defect,
unsupported driver capability or environment fault. Ambiguous failures and all
other failures still require classification and an operator decision:

- **PRODUCT_BUG**: reproducible UI-reachable expected/actual mismatch supported
  by assertions. First rule out stale locators, wrong profiles, environment
  problems and documented convergence behavior.
- **DRIVER_MISMATCH**: unsupported deployed contract, stale selector, missing
  capability or protocol mismatch. Never silently edit the driver, helpers,
  timeouts, credentials or implementation to make a test pass.
- **ENVIRONMENT**: unreachable service, incompatible build, TLS, permissions or
  unavailable fixture. Do not automatically reset/restart anything.

For failures outside the routine test-error exception, call `webtest_run pause`
with kind, title, evidence, optional case ID, and a
concrete `proposal` describing exact files/behavior and required verification
when a repair is appropriate. This persists an issue BEFORE showing the operator
choices: retry, skip, stop, or authorize that proposed repair. Cancellation leaves
the run paused. `webtest_run decision` reopens the decision dialog.

For driver/shared-harness or product repairs, authorization applies ONLY to that issue/proposal. Once approved, perform
its scoped edits and verification commands without asking again for each operation.
Request new approval if scope expands. Do not use shell commands to evade source
edit approval or perform unauthorized destructive operations. Browser mutations
stay paused during repair. Run the focused harness checks, then request a new operator retry decision;
re-run the failed case before assigning a verdict. A later driver mismatch needs
new authorization; earlier approval never becomes blanket permission. A shell
command or temporary step must not be used to evade these gates.

## Result discipline and reusable knowledge

Report one explicit verdict for the exact scope: PASS, BUG, or BLOCKED/NOT VERIFIED.
A quick PASS means two-node main workflows only, never full acceptance or Android.
SKIPPED requires a reason and is a coverage gap. Do not overwrite reproduced bug
evidence merely because the operator chose to continue. Distinguish fresh-server
recovery, retained cache, live sync and offline catch-up.

Canonical plans own stable scope; local run artifacts own results and resume state.
Reusable infrastructure belongs in `test/browser-e2e/`; deterministic regressions
belong in committed `*.spec.ts`. Do not commit secrets, browser profiles, temporary
steps or one-off fixture IDs. Propose reusable driver fixes and regression tests
only through the operator-approved repair workflow. Run relevant deterministic
checks before claiming a harness or regression fix is verified.
