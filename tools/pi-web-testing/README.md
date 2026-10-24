# Project-specific Pi browser testing

From the repository root:

```sh
npm run pi:webtest
```

This opt-in entry point loads the project browser extension and Skill, then opens
an interactive setup wizard. Normal `pi` sessions do not load these resources.
It requires Pi 1.4-compatible extension APIs, a working model configuration,
repository dependencies, and the shared Chromium:

```sh
npm run test:browser:install
```

## Guided acceptance

1. Choose **1 Full acceptance** (exactly three nodes) or **2 Main workflows**
   (exactly two nodes).
2. Enter each node's SOMS Web URL, backend service base URL, Admin URL, actual
   federation identity domain, and Admin username (default `admin`). Web/API
   hostnames do not necessarily identify the federation domain: confirm it in
   Admin settings. URLs must not contain credentials, query strings or fragments.
3. Confirm authorization for dedicated test users, relationships, groups and
   synthetic uploads on those deployments. Do not select production deployments
   casually; acceptance mutates authorized fixture data.
4. Enter each node's password in the masked terminal dialog. Escape cancels.
   Passwords never become model prompts, command arguments or run documents;
   they stay in extension/driver memory and cross a private inherited pipe.
5. The extension explicitly expands `/skill:web-testing` and starts the agent
   with the chosen run. HTTP/UI preflight replaces local HMR checks for configured
   deployments. No services are started, reset or restarted automatically.

Plans:

- [Two-node main-workflow plan](../../docs/development/browser-e2e-quick-test-plan.md)
- [Three-node full acceptance inventory](../../docs/development/browser-e2e-test-plan.md)

Quick mode covers local workflows on both nodes and bidirectional federation:
friendship, groups, settings/announcements, message/media/file types, personal and
group avatars, and recovery. It is not full acceptance or native Android evidence.
The agent expands plan matrices into individual assertion-backed cases before
business mutations. This is supervised agent execution, not a guarantee that an
arbitrary deployed UI version is supported without an approved driver update.

## Progress and pauses

The `webtest_run` tool owns state and writes:

```text
test-results/browser-e2e/acceptance/<run-id>/
  run.json
  progress.md
  handoff.md
  bugs/issue-*.md
  runs/<artifact-id>/
  profiles/
```

These files are local and ignored by Git. JSON is authoritative; Markdown is a
replaceable projection. Artifacts/profiles can contain private application and
session data. Keep them local, do not bulk-stage them, and delete them only when
no longer needed for evidence/resume. Temporary scenario modules belong in
`/tmp/soms-browser-e2e/steps/`, not the durable run records.

Commands:

- `/webtest`: configure a new run.
- `/webtest-status`: show active state and document path.
- `/webtest-resume RUN_ID`: reload that run and re-enter credentials. Deployment
  versions, identities, profiles and fixture state must be revalidated. A pause
  requires an explicit retry decision; resuming does not authorize source edits.

Every failed browser command immediately pauses further browser mutations and
writes an unclassified issue. Safe diagnostics and clean context closure remain
available. The agent records PRODUCT_BUG, DRIVER_MISMATCH or ENVIRONMENT with
reproduction, expected/actual and evidence, then asks the operator to retry,
skip, stop, or authorize **only a specific proposed repair**. Escape leaves the
run paused. A repair remains paused until focused checks pass and the operator
approves retry. Earlier approval never authorizes a later mismatch.

Source writers and shell operations require explicit approval during acceptance;
new temporary step files are allowed while running. Do not approve a shell or
step that bypasses a pause with another browser client. This is an agent workflow
gate, not an OS sandbox: trusted step modules and extensions have host permissions.
Driver navigation is separately restricted to confirmed Web/Admin origins.

## Local targeted exploration and regressions

To load only the browser resources **without** the setup wizard:

```sh
pi --extension ./tools/pi-web-testing/extension/index.ts \
  --skill ./tools/pi-web-testing/skill --tools +browser_driver,+webtest_run
```

Open profiles with explicit `target: "playground"` or `target: "federation"`.
Without configured acceptance, federation retains the existing three-node local
lab defaults and credential precedence; HMR preflight still applies. Playground
is separate and needs no federation credentials. See
[browser testing architecture](../../docs/development/browser-testing.md) and
[driver operations](../../docs/development/browser-e2e-tools.md).

The driver and regression suite share the lockfile-paired Chromium. Reusable
harness code belongs in `test/browser-e2e/`, not temporary steps. Run harness checks
with `npm run test:browser:unit`; deterministic product regression uses
`npm run test:browser` or the appropriate narrowed Playwright project.
