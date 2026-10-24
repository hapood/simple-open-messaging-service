---
name: web-testing
description: Execute two-node main-workflow or three-node full SOMS Web/Admin browser acceptance using the Pi setup wizard, persistent Playwright driver, local progress records, and explicit operator gates for bugs and driver changes. Also supports targeted local playground and federation regression work.
---

# Project Web testing

## Start and select scope

`npm run pi:webtest` opens the interactive setup wizard. `/webtest` opens it again.
It collects quick (two nodes) or full (three nodes), each node's Web, backend and
Admin URLs, actual federation identity domain, and Admin username (default
`admin`). Passwords are entered through masked TUI dialogs and transferred to
the driver through a private pipe. Never ask for a password in chat, read `.env`
for a configured deployment, or put credentials/OTPs in tool parameters, files,
command arguments, evidence, screenshots, or traces.

The wizard authorizes only dedicated test fixtures on the confirmed deployments.
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
  assertion-sized case IDs with `webtest_run record`, outcome `NOT RUN`.
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
  run, re-enters credentials and pauses for revalidation. Verify deployment
  versions, identity and fixture state; historical PASS does not verify a new build.

## Preflight and browser operation

1. Inspect `git status` only through an authorized local command; preserve all
   unrelated changes. Do not automatically start/restart/reset services.
2. Call `browser_driver preflight` to check Web/Admin reachability and edge/backend
   compatibility contracts. Record exact returned server/API versions. Reject
   wrong nodes, invalid certificates, redirects to unapproved origins or
   unavailable services as setup blocks, not product bugs.
3. Call `status`. Open isolated profiles with explicit `target: "federation"`
   and the selected node key (`alpha`, `bravo`, optionally `charlie`). These are
   aliases for the user-confirmed deployment, not inferred hostnames.
4. Use `adminLogin`, `issueOtp`, then `userLogin` sequentially. Verify the actual
   federation domain in Admin and visible account identity in each user context
   before mutations; do not infer identity domain from the Web hostname.
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

On a command failure, the extension automatically pauses acceptance and writes
an unclassified issue. Do not continue mutations or call an alternate client.
Read-only diagnostics (`status`, `inspect`, `errors`, `shot`, `traceStop`) and
clean context closure remain available when safe. Classify the failure:

- **PRODUCT_BUG**: reproducible UI-reachable expected/actual mismatch supported
  by assertions. First rule out stale locators, wrong profiles, environment
  problems and documented convergence behavior.
- **DRIVER_MISMATCH**: unsupported deployed contract, stale selector, missing
  capability or protocol mismatch. Never silently edit the driver, helpers,
  timeouts, credentials or implementation to make a test pass.
- **ENVIRONMENT**: unreachable service, incompatible build, TLS, permissions or
  unavailable fixture. Do not automatically reset/restart anything.

Call `webtest_run pause` with kind, title, evidence, optional case ID, and a
concrete `proposal` describing exact files/behavior and required verification
when a repair is appropriate. This persists an issue BEFORE showing the operator
choices: retry, skip, stop, or authorize that proposed repair. Cancellation leaves
the run paused. `webtest_run decision` reopens the decision dialog.

Repair authorization applies ONLY to that issue/proposal. Source edits still
require visible per-operation approval. Browser mutations stay paused during
repair. Run the focused harness checks, then request a new operator retry decision;
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
