---
name: web-testing
description: Run project-specific browser E2E exploration, execute numbered acceptance cases, reproduce UI defects, or create and maintain Playwright browser tests for the three-node federation lab. Use only for Web/Admin browser automation and browser test planning or progress updates.
---

# Project Web testing

Use the repository's existing browser harness and documentation as the source of truth. Do not create a parallel test plan, progress tracker, browser driver, or fixture convention under this skill directory.

## Read only what the task needs

Start with these short routing reads. Browser and Android each have a plan,
progress log, and handoff; route to the platform the task targets.

1. Read `docs/development/browser-e2e-progress.md` (or
   `android-e2e-progress.md`) from the beginning through **Next Unfinished
   Work** to learn current status. Read dated evidence only when the selected
   case needs it.
2. Read the **Resume here**, **Running environment**, and **Retained fixtures
   and driver** sections of `docs/development/browser-e2e-handoff.md` (or
   `android-e2e-handoff.md`) before continuing retained work.
3. Read the selected numbered section and the applicable cross-cutting rules in
   `docs/development/browser-e2e-test-plan.md` (or
   `android-e2e-test-plan.md`). Do not load the entire plan when one section is
   enough.
4. Read `docs/development/browser-e2e-tools.md` before controlling the
   persistent driver; its Android lab preflight applies to Android runs.

Use `rg -n '^## |^### |<case id>|<feature term>'` to locate relevant sections before reading large documents.

## Source ownership

- Reusable executable browser infrastructure belongs in `test/browser-e2e/`.
- Deterministic regression specs belong in `test/browser-e2e/*.spec.ts` and run through `npm run test:browser`.
- The canonical acceptance inventory belongs in `docs/development/browser-e2e-test-plan.md`.
- Current coverage and concise evidence belong in `docs/development/browser-e2e-progress.md`.
- Resume-only operational state belongs in `docs/development/browser-e2e-handoff.md`.
- Android acceptance, progress, and resume state live in
  `android-e2e-test-plan.md`, `android-e2e-progress.md`, and
  `android-e2e-handoff.md`; Android defect records use the
  `android-e2e-bug-*.md` prefix.
- A reproducible open product defect or a fix awaiting required platform regression belongs in a focused `docs/development/browser-e2e-bug-*.md` record linked from progress. After durable regression coverage and the required browser regression pass, summarize the current outcome in progress and delete the bug record; Git history retains its investigation.
- Do not duplicate those facts in this skill. Update the owning source instead.

## Temporary browser steps

Put scenario-specific Playwright step modules under:

```text
/tmp/soms-browser-e2e/steps/
```

Create the directory when needed. Use descriptive, safe filenames ending in `.mjs`. `/tmp` is disposable and may be cleared on reboot or by system cleanup, so never treat it as durable evidence.

A temporary step exports one async default function:

```js
export default async ({ page, expect, pageOf, shot, nodes }) => {
  await expect(page.locator('app-icon-rail .icon-rail')).toBeVisible();
  return { ready: true };
};
```

Promote a temporary method into `test/browser-e2e/` only when it is generally reusable. For local user and friendship setup through visible controls, reuse `test/browser-e2e/steps/ui-fixtures.mjs`: `createLocalUser(adminPage, { account, displayName })`, `requestLocalFriend(senderPage, { account, displayName })`, and `acceptLocalFriend(recipientPage, { displayName })`. These helpers do not call APIs or write the database; login remains the browser driver's separate OTP setup. Keep reusable step source and comments in English and use structural/semantic selectors instead of localized labels. Promote a scenario into a committed `*.spec.ts` when it should become a deterministic regression gate. Do not preserve one-off fixture IDs, credentials, OTPs, cookies, or session state in source.

## Android network preflight

For Android/Appium validation, follow the Android lab network preflight in
`docs/development/browser-e2e-tools.md` before configuring the app or recording a
native verdict. When validating Android FCM in a restricted network, remember
that the backend Firebase Admin SDK uses the process/system `HTTPS_PROXY` or
`https_proxy` environment variable for FCM credential and send requests; do not
record or paste proxy URLs in evidence.

## Browser-driver workflow

Browser E2E is HMR-only. Start `npm run dev:be` and `npm run dev:fe`; never use `dev:fe:built` for browser acceptance. Before changing or testing code, use `browser_driver` action `frontendStatus` to inspect the current Web and Admin HMR build. Do not issue a long-running `frontendWait` call without progress visibility. If waiting is needed, poll with short bounded waits (normally 10-20 seconds each), and between attempts report the current `frontendStatus`, relevant HMR status-file contents, or recent frontend logs. A failure or stale status is an environment/build failure, not a product PASS.

The `browser_driver` tool wraps `test/browser-e2e/driver.mjs` and keeps isolated persistent Chromium profiles. Call state-dependent commands sequentially.

1. Check running services and processes without restarting or resetting them automatically.
2. Call `status`, then reopen only the required named profiles.
3. Use `inspect` for the current URL and accessibility snapshot.
4. Use `adminLogin`, `issueOtp`, and `userLogin` only when login is actually required. Never return or persist an OTP or password. For parallel sessions, pass a private admin profile via `user` (e.g. `admin-parallel-1`) to `adminLogin`/`issueOtp` instead of sharing `admin-<node>`; keep `/dev/shm/soms-admin-pw` in sync with `.env` after a lab reset.
5. Write scenario-specific actions to the temporary step directory and invoke them with `eval`.
6. Use semantic locators and Playwright web-first assertions. Do not use fixed sleeps as the success condition.
7. On failure, collect `shot`, `errors`, and an explicit trace when useful. Distinguish harness, environment, and product failures.
8. Close contexts cleanly when they should not remain available. Do not reset profiles or databases merely to resume work.

Navigation is restricted to the Alpha, Bravo, and Charlie local lab edges on ports 3101-3103. Never point the tool at production or an arbitrary URL. `npm run test:browser` also refuses to start unless both HMR status files report a current successful build.

## Result discipline

- Playwright assertions and command exit status determine test success, not visual intuition or the model's narrative.
- State a single explicit verdict in the user-facing result: **PASS** for the exact assertion-backed scope, **BUG** for a reproduced UI-reachable defect, or **BLOCKED/NOT VERIFIED** when the setup or evidence cannot decide. Do not leave the verdict implicit in caveats. A PASS records only the exact tested scope; do not infer another platform, node combination, role, viewport, or local/federated variant.
- Before marking BUG, reproduce the expected/actual difference with a scoped assertion and rule out a stale locator, mixed browser context, unavailable environment, or pending documented convergence. For time-dependent behavior, verify both server and browser-projection timestamps/clock before asserting expiry; changing DB timestamps alone does not age an already-synced browser projection. Record the clock/setup scope with the verdict.
- A browser BUG must be reachable through the exposed UI workflow under test. Direct API calls, database mutations, or injected browser requests may be used for lab setup, deterministic expiry/concurrency preparation, backend diagnostics, and supplementary server assertions, but they do not by themselves establish a browser UI BUG. If direct API behavior differs from the UI's disabled or hidden controls, record it only as supplemental backend behavior unless the acceptance case explicitly covers that API contract.
- Preserve existing user changes. Inspect `git status` before editing and never bulk-stage temporary scripts or unrelated documents.
- Do not reset the federation lab unless the user explicitly authorizes that destructive shared-state operation.

## Updating project knowledge

After a completed case:

- Add a terse, explicitly labeled PASS/BUG/BLOCKED/NOT VERIFIED result to the
  current dashboard/evidence section in the platform's progress log
  (`browser-e2e-progress.md` or `android-e2e-progress.md`); when a later run
  supersedes a contradictory claim, correct that claim rather than leaving both
  as current PASS evidence.
- Update the corresponding unfinished checkbox only when its complete declared scope is covered.
- Update `browser-e2e-handoff.md` (or `android-e2e-handoff.md`) only with state
  needed by the next session: build identity, running services, reusable
  profiles/fixtures, dirty cleanup, stop point, and exact next action.
- Add or update a bug record for a real open defect; link it from progress. Delete it after the documented closure conditions pass, and never let historical defect evidence override a newer verified result.
- Replace superseded progress evidence instead of appending a dated session diary.
- Update the canonical test plan only when acceptance scope or rules change, not for ordinary run results.

Before reporting completion, run the relevant deterministic command when a regression spec exists, normally `npm run test:browser` or a narrowed Playwright invocation.
