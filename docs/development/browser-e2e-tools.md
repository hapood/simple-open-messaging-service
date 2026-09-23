# Reusable Browser Validation Tools

## Purpose

Use `test/browser-e2e/driver.mjs` for exploratory browser validation across
independent conversations. It owns persistent Chromium profiles and accepts
JSON commands. Scenario steps stay in temporary modules; only generally useful
operations belong in the driver. The existing Playwright suite remains separate.

## Start and reconnect

From the repository root, with the federation lab already running:

```sh
node test/browser-e2e/driver.mjs
```

Keep stdin open (use `tty: true` with the command tool). Wait for the JSON
`ready` response, then send one JSON command per line. Commands execute serially;
match responses by `id` and check `ok`. Do not mistake terminal input echo for a
response. A failed command does not stop later queued commands, so wait for each
dependent result before submitting the next step.

A new conversation can start a new driver and reopen named profiles after the
old driver releases them. Tool session IDs are temporary; profile directories
persist. Never launch two drivers against the same profile at once. `status`
lists contexts opened by the current driver and `externalProfiles` detected
from Chrome's profile locks. An external lock is diagnostic only; close the
owning driver cleanly. Never delete a lock or reset a profile to work around it.

Defaults:

- Alpha/Bravo/Charlie edges: `http://localhost:3101/`, `3102/`, `3103/`.
- Profiles: `/tmp/soms-browser-e2e/profiles/`.
- Screenshots and explicit traces: `/tmp/soms-browser-e2e/`.
- Override roots with `BROWSER_PROFILE_DIR` and `BROWSER_ARTIFACT_DIR`.
- Override Chromium executable with `CHROME_PATH`.
- Admin credential precedence: `BROWSER_ADMIN_PASSWORD`, tmpfs file
  `/dev/shm/soms-admin-pw`, then `ADMIN_BOOTSTRAP_PASSWORD` in `.env`.
  A credential is needed only when logging into Admin.

If `/tmp` cleanup removes HMR status files while the dev servers remain
running, the frontend lab recreates its session marker and the observers mark
missing build records as `building`. Run a real rebuild and wait for fresh Web
and Admin success statuses before testing; an old build is never inferred from
HTTP 200. Check live processes before starting another `npm run dev:fe`.

## Commands

| Action       | Fields beyond `id` and `action`            | Behavior                                                                   |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| `status`     | none                                       | Current contexts, externally locked profiles, URLs, lab nodes, artifact directory |
| `open`       | `user`, optional `node`, `url`, `viewport` | Open/reuse a profile and navigate; viewport applies when creating it       |
| `inspect`    | `user`                                     | URL and accessible page snapshot                                           |
| `adminLogin` | `node`                                     | Open/reuse `admin-<node>` and log in if necessary                          |
| `issueOtp`   | `node`, `account`                          | Search Admin users, issue OTP, keep it in memory                           |
| `userLogin`  | `user`, `node`, `account`                  | Resume the profile or consume its account's in-memory OTP                  |
| `eval`       | `user`, `script`                           | Run a trusted local `.mjs` step against that profile                       |
| `shot`       | `user`, `name`                             | Save a screenshot                                                          |
| `errors`     | `user`, optional `clear: true`             | Return bounded console/page/request errors; optionally clear after reading |
| `traceStart` | `user`                                     | Begin an explicit business-flow trace                                      |
| `traceStop`  | `user`, `name`                             | Save the trace ZIP                                                         |
| `closeUser`  | `user`                                     | Release one profile, preserving login/cache                                |
| `resetUser`  | `user`                                     | Close and delete that profile, including login/cache                       |
| `close`      | none                                       | Close all contexts; retain profiles and keep driver available              |

Profile/artifact names accept letters, digits, underscores and hyphens. `user`
is a local browser profile name, not necessarily the application's account.
Use separate names for accounts and for independent sessions of the same account.

Example, submitting each command after its prerequisite succeeds:

```json
{"id":1,"action":"open","user":"alice-device-1","node":"alpha"}
{"id":2,"action":"inspect","user":"alice-device-1"}
{"id":3,"action":"eval","user":"alice-device-1","script":"/absolute/path/to/temporary-step.mjs"}
{"id":4,"action":"errors","user":"alice-device-1","clear":true}
{"id":5,"action":"closeUser","user":"alice-device-1"}
```

For fresh login, run `adminLogin`, `issueOtp`, and `userLogin` sequentially. OTPs
are consumed once; issue a new one for a second device. Driver selectors must
use form semantics, accessibility relationships, routes, or scoped structure;
do not locate controls by localized visible text. This helper is test setup, not
coverage of every authentication workflow.

## Temporary step contract

```js
export default async ({ page, expect, pageOf }) => {
  await expect(page.locator('app-icon-rail .icon-rail')).toBeVisible();
  // pageOf('alice-device-2') accesses another already-open context's page.
  return { ready: true };
};
```

Other helpers are `context`, `shot(user, name)`, `nodes`, and `sleep(ms)`.
A legacy `adminPassword` helper remains for existing local steps; never return
or log it. The driver imports a fresh module instance for each invocation.
Scripts must return JSON-serializable, non-secret summaries and throw on failed
assertions. Keep browser actions bounded: locator and navigation timeouts exist,
but an arbitrary JavaScript loop or promise has no driver-wide deadline.

Prefer semantic locators scoped to a panel and Playwright `expect` assertions.
Wait for navigation, a response, or visible state instead of fixed sleeps.
Use real clicks; avoid DOM-dispatched clicks that bypass interaction failures.
For browser acceptance cases, perform each business action under test through
its visible client control. Do not use `page.evaluate(fetch(...))` to send a
request, accept, reject, revoke, or message command as a substitute for that
UI action. Backend
API calls are limited to fixture preparation and result verification after a
visible client action, as defined by the test plan. Record direct API probes
separately from browser E2E results.
Keep scenario-specific labels, IDs and cleanup in the temporary step.

## Evidence and handoff

After authentication, clear setup errors and optionally start traces. On a
failure, capture a screenshot, inspect the page, read errors and stop traces for
all involved profiles. A network cancellation alone is not a product defect;
correlate it with the failed operation. Preserve the exact command and result.

Do not capture OTP screens or record authentication in traces. Traces can still
contain session/network data; keep all browser artifacts local and uncommitted.
The driver does not redact arbitrary step results or page snapshots.

Successful results need one brief progress row. Failures need reproduction,
expected/actual behavior, build identity and artifact paths. Distinguish selector
or setup failures from application bugs. Separate retained-cache reload, fresh
server recovery, live multi-session sync and offline catch-up assertions.

Before switching conversations, update the handoff with current code/build,
running services, profile-to-account mapping, restored/dirty fixture state,
unfinished checks and the next command. Use `close` to release browser profiles
if the next conversation cannot reuse the current driver. Do not reset databases
or profiles merely to resume work.
