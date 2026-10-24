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

On startup, an existing shared configuration offers **Use saved configuration**
or **Modify saved configuration**. Using it skips all address/account/password
entry. On first setup, or when modifying settings:

1. Choose **1 Full acceptance** (exactly three nodes) or **2 Main workflows**
   (exactly two nodes).
2. Enter each node's external SOMS URL, optional internal Admin URL, and optional
   Admin username (leave empty for `admin`). An empty internal URL uses the external
   origin's `/admin/`; an internal origin without a path also gains `/admin/`.
   API routes use the external origin. The driver reads the real federation identity
   from authenticated Admin `/api/v1/admin/me` (`somsDomain`), never from the Web
   hostname. Missing, changed or duplicate identities pause the run. URLs must not
   contain credentials, query strings or fragments.
3. Confirm authorization for dedicated test users, relationships, groups and
   synthetic uploads on those deployments. Do not select production deployments
   casually; acceptance mutates authorized fixture data.
4. Enter each node's password in the masked terminal dialog. Escape cancels.
   Passwords never become model prompts, command arguments or run documents.
   They are saved in the shared local configuration below and transferred from
   extension memory to the driver through a private inherited pipe.
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
- `/webtest-resume RUN_ID`: reload that run using the shared local configuration.
  The saved endpoints/account must match the restored run; credentials are never
  silently sent to changed targets. Deployment versions, identities, profiles and
  fixtures must still be revalidated. A non-test-error pause requires an explicit retry decision;
  resuming does not authorize source edits.

## Shared machine-local configuration

```text
test/browser-e2e/.local/config.json
```

This is the single source of saved mode, node addresses, Admin usernames and
passwords for all sessions/runs. The directory is Git-ignored and mode 0700;
the file is mode 0600 and written using atomic replacement. Passwords are plaintext
on local disk: use test-only credentials. Delete this file to forget the settings,
or choose **Modify saved configuration** to replace them. No credentials are
stored in per-run directories or Pi session entries. Do not print, attach or
commit this file, and do not ask the model to read it.

The Pi session entry (`webtest-run`) retains only the progress run ID so `/reload`
can find unfinished work. Startup offers use/modify for the shared settings, then
restores progress and displays any pending decision. A brand-new Pi session uses
the same shared settings but starts a new run; `/webtest-resume RUN_ID` explicitly
selects earlier progress. Run artifacts remain separate from reusable configuration.

Every failed browser command immediately pauses further browser mutations and
writes an unclassified issue. Safe diagnostics and clean context closure remain
available. After safe diagnosis, an invocation mistake or agent-authored temporary
step mistake can be recovered without a dialog: `webtest_run recover` requires the
current issue ID, scope (`arguments` or `temporary-step`), diagnostic evidence and,
for a step, its absolute `.mjs` path under `/tmp/soms-browser-e2e/steps/`. It retains
the original failure and diagnosis with an `agent-retry` audit marker, resumes the
run, and authorizes no shared-harness or product changes. The failed assertion
must be rerun. Progress-tool parameter errors that leave the run running can be
corrected directly without a pause. Ambiguous failures, product/environment
faults, unsupported driver capabilities and shared-code repairs are not eligible.
For these the agent records PRODUCT_BUG, DRIVER_MISMATCH or ENVIRONMENT with
reproduction, expected/actual and evidence, then asks the operator to retry,
skip, stop, or authorize **only a specific proposed repair**. Escape leaves the
run paused. A repair remains paused until focused checks pass and the operator
approves retry. Earlier approval never authorizes a later mismatch.

Run authorization covers routine non-destructive local checks, fixture preparation,
and creation/editing of temporary `.mjs` steps under `/tmp/soms-browser-e2e/steps/`;
these do not prompt per operation. Source changes need one specific repair approval,
not another confirmation for every edit or verification command within that proposal.
Paused runs block local execution/writers until an operator decision or eligible
routine test-error recovery; safe read/browser
diagnostics remain available. Never use a shell or step to change source without
approval, perform an unauthorized destructive operation, or bypass a pause with
another browser client. This is an agent workflow
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
