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

### Driver lifetime across tool calls

The canonical client is the `browser_driver` extension loaded by
`npm run pi:webtest`; it keeps the driver as a direct child process with pipes
and matches replies by id. Plain shells and one-shot agent tool calls cannot
hold a child process between calls: run `node test/browser-e2e/driver.mjs`
behind a persistent tty when the harness supports it, otherwise a detached
named-pipe setup is required. Do not add a second tracked client for this;
re-derive it from the operational edges below when needed:

- Start the driver with `setsid`, not just `nohup`. An outer tool-call timeout
  kills the caller's whole process group, and an undetached driver dies with
  it.
- Keep a holder process (for example `setsid bash -c 'exec sleep infinity > fifo'`)
  holding the FIFO write-end open so the driver never sees EOF between
  commands, and guard the command write with its own timeout: a FIFO write with
  no reader blocks forever.
- Exactly one driver per profile set. Guard liveness with pidfiles, not
  `pgrep -f`: a `> fifo` redirection never appears in a process cmdline, so the
  pattern never matches and every check spawns another holder.
- OTP codes live in driver process memory and die with it. Issue OTP and
  `userLogin` back-to-back in the same driver lifetime.
- Cold starts are slow: a fresh Chromium profile plus the first Angular Vite
  compile can exceed two minutes. Budget login commands generously instead of
  retrying into a lost OTP.

### Lab health and migration-drift triage

An edge page returning HTTP 200 proves only that Caddy and the frontend are
reachable. Before a browser verdict, check all three layers independently:

1. `browser_driver frontendStatus` must report current successful Web and Admin
   HMR builds.
2. Edge URLs on ports 3101-3103 must answer, and their `/api/v1/client/compat`
   routes must not return 502.
3. Backend URLs on ports 3201-3203 must return 200 from `/api/v1/client/compat`.

A visible page combined with API 502s, an empty thread plus a retry control, or
repeated aborted `/api/v1/events` requests is an environment failure until the
backend layer is restored. Do not record a product PASS or BUG from that state.
Inspect the frontend/backend lab logs and live processes before restarting
anything.

If `npm run dev:be` exits with `applied migration was modified: <version>`, the
lab is blocked by migration checksum drift. Report the exact version and compare
`database/migrations/` with the lab database's `schema_migrations`; never reset
the databases merely to bypass the check. Updating a checksum is an explicit
lab-maintenance action, not a normal browser-test step: obtain authorization,
change only the identified lab records, do not touch business tables, and then
rerun the migration status/startup check. Keep schema drift separate from the
browser product verdict.

### Android lab network preflight

Before Android/Appium validation, run the repository helper after every host
network change:

```sh
node scripts/android-lab-server.mjs --lan  # prefer the current Wi-Fi IP over USB reverse
```

The helper probes the current host addresses for lab ports `3101` through
`3103` using `/api/v1/client/compat`, configures `adb reverse tcp:<port>
tcp:<port>` when `adb` and a device are available, and prints the server origins
to enter in the Android app. Check `/api/v1/client/compat`: a stale backend
process can return 200 on the removed `/shell/compat` while returning 404 on
the new endpoint. When
that happens, rebuild and restart only the backend lab supervisor; do not reset
lab databases or reinstall the APK to work around a stale backend process.
`--lan` prefers the current Wi-Fi IP; without it a successful USB reverse
prefers `127.0.0.1`. Use
the printed loopback origins only when reverse setup succeeds; otherwise use the
printed LAN origins and keep the Android device on the same network. If `adb` is
unavailable, record the Android run as a tooling block rather than a product
verdict.

For the Android server-configuration and login gate, use the WebView helper
instead of hand-tapping the form:

```sh
node scripts/android-webview-flow.mjs configure --origin http://127.0.0.1:3101
# Pipe the freshly issued code via stdin from a trusted, non-logging issuer.
node scripts/android-webview-flow.mjs otp-login --account ACCOUNT --code-stdin
```

`configure` requests only the entered origin. Confirm the persisted `api_origin`
contains the probed address after declining an advertised pair and after an app
restart; reaching `/auth/qr` alone does not prove persistence. The Android app
always loads the Web frontend embedded in its APK. A Web or native change
requires a new APK build and install; the server does not distribute OTA assets:

```sh
make -C src-tauri apk-debug ABI=aarch64 WEB_BUILD=1 \
  ANDROID_HOME=/home/lenovo/Android/Sdk \
  ANDROID_NDK_HOME=/home/lenovo/Android/Sdk/ndk/27.1.12297006
/home/lenovo/Android/Sdk/platform-tools/adb install -r \
  src-tauri/dist/android/soms-0.1.0-alpha.0-debug-arm64-v8a.apk
```

Native frontend artifacts are isolated in `web/dist/native/browser`. Both debug
and release builds use AOT: the native CSP intentionally forbids `unsafe-eval`,
so an Angular JIT build cannot boot. The shared frontend build runner generates
the push worker, compiles with AOT, validates native bundle metadata, then
postprocesses source maps. `verify:native` rejects runtime Angular compilers before
packaging. Browser/test output in `web/dist/web` and Playground output in
`web/dist/playground` are not used by the native shell.

Use `WEB_BUILD=0` only after building the exact native frontend to embed, for
example `npm --prefix web run build:native -- --configuration development`.
The Makefile validates reused output too. Install with `-r` to preserve app data;
never uninstall the APK for a routine test.
Use a fresh OTP and the stdin-fed flow to verify login on the newly installed
APK. For a disposable lab user, a trusted issuer can authenticate the Alpha
admin from `/dev/shm/soms-admin-pw`, create the user, issue one fresh code, and
pipe that code from memory directly into `android-webview-flow.mjs otp-login
--account ACCOUNT --code-stdin`. The issuer must suppress child stdout/stderr on
failure unless output is explicitly redacted. Never pass OTPs as CLI arguments,
save them to artifacts, or log them. An OTP attempt that stays on `/auth/otp`
is not a PASS: issue a _new_ code before retrying and require an authenticated
home shell as the result. For case 11.1, separately confirm the saved
`api_origin`, the responding `/client/compat` identity, and the visible profile
account against that node's admin user listing; do not infer the logged-in
identity merely from the home URL.

For a bounded Android P2P check, create/accept a disposable friendship through
the UI, then use an independently authenticated peer to send or verify messages.
`android-chat-peer.mjs` issues its own OTP in memory and suppresses secret-bearing
errors; it does not accept credentials or OTPs as command-line arguments:

```sh
node scripts/android-chat-peer.mjs send-text --node alpha --peer PEER_ACCOUNT --thread-id THREAD_ID --text 'peer-fixture-unique'
node scripts/android-chat-peer.mjs check-text --node alpha --peer PEER_ACCOUNT --thread-id THREAD_ID --text 'android-fixture-unique'
node scripts/android-chat-peer.mjs check-file --node alpha --peer PEER_ACCOUNT --thread-id THREAD_ID --file /tmp/android-fixture.txt --name android-fixture.txt
```

`check-text` requires exactly one matching peer-visible message. `check-file`
requires one matching file name and byte count, then downloads its CAS content
as the peer with `threadId` and `seq` query parameters and compares SHA-256 with
the local source. The device still must show its own successful UI rows: API
acceptance alone is not an Android UI PASS. On this Android build the chat
composer and attachment tray are native Android views, so a WebView DOM query
will not find the EditText or file picker. Use `adb shell uiautomator dump` to
locate the native controls, `adb shell dumpsys input_method` for the IME, and
system Back to test draft retention. The picker uses Android DocumentsUI;
files for a disposable fixture can be pushed to `/sdcard/Download/` via `adb
push`. Preserve app data with `adb install -r`. For a new disposable lab
account, issue its OTP and pipe it to the WebView helper without showing the
code or putting it in process arguments:

```sh
node scripts/android-lab-otp-login.mjs --node alpha --create
# Or reuse an account that is still present in the CURRENT lab state:
node scripts/android-lab-otp-login.mjs --node alpha --account ACCOUNT
```

A fresh OTP login is **not** evidence that a saved session restores. To test
that separately, record the authenticated account, native cache schema version,
and SQLite file identity; `adb shell am force-stop com.soms.client`, relaunch,
and verify the same account using the authenticated `/user/my-profile` response
and the stable native cache. Refresh the adb CDP forward after process restart:
`android-webview-flow.mjs status` locates and forwards the current WebView
socket. An initial snapshot can show only the app-shell spinner; wait for the
routed page and server handshake before giving a verdict.

The Android 9 retained-session defect was caused by the **platform SQLite
engine opening Rust's shared database file**. It cannot parse the Rust-owned
`threads` generated columns, reported malformed schema at trigger
`threads_namespace_before_insert`, and its default corruption handler deleted
the database. Kotlin `ClientStateDb` now uses Rust JNI for call-peer and
notification-preference reads/writes. Do not add `SQLiteDatabase` access to the
Rust-owned `soms-local.sqlite3` from Kotlin: a successful Rust read does not
show the platform SQLite can parse that schema. The Rust thread-feed snapshot
must decode all server fields (including `announcementReadFeedId`); resumable
upload init must carry `partId`, numeric `position`, and `intent`, matching Web.

For the Android JNI bridge regression, build the app with the Makefile first;
standalone Gradle cannot run Tauri's Rust build task without the CLI WebSocket.
Then assemble only the instrumentation APK with those Rust tasks excluded and
run the focused tests without wiping the installed app:

```sh
(cd src-tauri/gen/android && ANDROID_HOME=/home/lenovo/Android/Sdk ./gradlew \
  :app:assembleUniversalDebugAndroidTest \
  -x :app:rustBuildUniversalDebug -x :app:rustBuildArmDebug \
  -x :app:rustBuildArm64Debug -x :app:rustBuildX86Debug \
  -x :app:rustBuildX86_64Debug --no-daemon)
adb install -r src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk
adb shell am instrument -w -e class com.soms.client.ClientStateDbTest \
  com.soms.client.test/androidx.test.runner.AndroidJUnitRunner
```

## Commands

| Action       | Fields beyond `id` and `action`                         | Behavior                                                                          |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status`     | none                                                    | Current contexts, externally locked profiles, URLs, lab nodes, artifact directory |
| `open`       | `user`, optional `node`, `url`, `viewport`              | Open/reuse a profile and navigate; viewport applies when creating it              |
| `inspect`    | `user`                                                  | URL and accessible page snapshot                                                  |
| `adminLogin` | `node`, optional `user` (admin profile name)            | Open/reuse the admin profile (default `admin-<node>`) and log in if necessary     |
| `issueOtp`   | `node`, `account`, optional `user` (admin profile name) | Search Admin users, issue OTP, keep it in memory                                  |
| `userLogin`  | `user`, `node`, `account`                               | Resume the profile or consume its account's in-memory OTP                         |
| `eval`       | `user`, `script`                                        | Run a trusted local `.mjs` step against that profile                              |
| `shot`       | `user`, `name`                                          | Save a screenshot                                                                 |
| `errors`     | `user`, optional `clear: true`                          | Return bounded console/page/request errors; optionally clear after reading        |
| `traceStart` | `user`                                                  | Begin an explicit business-flow trace                                             |
| `traceStop`  | `user`, `name`                                          | Save the trace ZIP                                                                |
| `closeUser`  | `user`                                                  | Release one profile, preserving login/cache                                       |
| `resetUser`  | `user`                                                  | Close and delete that profile, including login/cache                              |
| `close`      | none                                                    | Close all contexts; retain profiles and keep driver available                     |

Profile/artifact names accept letters, digits, underscores and hyphens. `user`
is a local browser profile name, not necessarily the application's account.
Use separate names for accounts and for independent sessions of the same account.

Parallel sessions should pass a private admin profile name to `adminLogin` and
`issueOtp` (for example `user: "admin-parallel-1"`) instead of contending for
the shared `admin-<node>` profile: a Chromium persistent profile must not be
opened by two contexts, so the shared name acts as a lock. A failed admin login
drops the half-open session, and a cached session found sitting on the login
page is re-logged-in on the next `issueOtp`. After a lab reset, refresh
`/dev/shm/soms-admin-pw` from `.env` or every new admin profile login times out.

Example, submitting each command after its prerequisite succeeds:

```json
{"id":1,"action":"open","user":"alice-device-1","node":"alpha"}
{"id":2,"action":"inspect","user":"alice-device-1"}
{"id":3,"action":"eval","user":"alice-device-1","script":"/absolute/path/to/temporary-step.mjs"}
{"id":4,"action":"errors","user":"alice-device-1","clear":true}
{"id":5,"action":"closeUser","user":"alice-device-1"}
```

For fresh login, run `adminLogin`, `issueOtp`, and `userLogin` sequentially. OTPs
are consumed once; issue a new one for a second device. OTP login creates an
additional user session and does not evict existing logged-in browser profiles
for the same account; only the browser profile lock itself is exclusive. Driver
selectors must use form semantics, accessibility relationships, routes, or
scoped structure; do not locate controls by localized visible text. This helper
is test setup, not coverage of every authentication workflow.

For local UI fixture setup, import `test/browser-e2e/steps/ui-fixtures.mjs`:
`createLocalUser(adminPage, { account, displayName })`,
`requestLocalFriend(senderPage, { account, displayName })`, and
`acceptLocalFriend(recipientPage, { displayName })`. The helpers operate through
visible Admin/Web controls only. Use separate logged-in browser profiles for
each user. They do not issue login codes or manage sessions; use the driver
login helpers for those prerequisites. Pass the target's exact display name
when requesting or accepting, and keep one-off account data in the temporary
scenario rather than the reusable module.

### Opening threads and the desktop chat pane

The desktop chat pane keeps two layers (`.pane-layer.pane-fg` foreground plus a
backgrounded layer), each with its own `.msg-header` and `.msg-container`.
Always scope message-surface selectors to `.pane-layer.pane-fg`; an unscoped
`.msg-header` read can come from the stale background thread.

Clicking the already-open thread row is a TOGGLE on non-compact layouts
(`shouldCloseChatOnThreadSelect`): a step that re-clicks the active row closes
the chat while the pane keeps rendering the old foreground layer, leaving
`.pane-empty` covering the composer. Before clicking a thread row, assert the
foreground header text AND `app-chat-pane .pane-empty:visible` count 0; skip
the click when the thread is already live. After any open click, wait for the
`.pane-empty` overlay to disappear before targeting the composer.

Aside overlays (group-info, group-join-requests, member manager) sit above a
`.drawer-mask` that Escape does not close; walk them down with the last visible
`.page-header__back` (one level per click) before touching the thread list.
The forward dialog confirms merged/history forwards through `app-split-button`
(the header primary action), not a plain button; the single-message
right-click forward is DIRECT mode and re-sends content as an ordinary
message, while the card-based snapshot flow requires multi-select → merged
forward. Multi-select pre-selects the message whose context menu opened it —
clicking that row again deselects it and disables the selection-bar forward
action.

The driver resolves a temporary step's relative imports once and caches them:
after editing a shared step helper, import it under a new filename or the old
module keeps running.

### Message context menus and multi-select

Open a message context menu from the message's real interactive content, not
from its accessible `listitem` wrapper. The wrapper often owns layout only and
a right-click on it may produce no menu. Stable targets include:

- image: the message's `打开图片` / open-image button;
- file: the message's `打开文件` / open-file button;
- audio: the visible `.msg-bubble.msg-media--audio` bubble, because its backing
  `<audio>` element is intentionally hidden;
- text or forward card: the visible message bubble/card control.

After choosing **multi-select** from the first message's context menu, add other
messages with ordinary clicks on their content controls. Assert the selection
bar count before forwarding. A visual gallery row may contain multiple
underlying messages; selecting one image control can select only that source
message. Capture the `send-forward` request and verify `sourceMessages`, `mode`,
and order instead of inferring the payload from the grouped UI row.

A missing context menu after right-clicking a wrapper is a selector/harness
failure, not a product failure. Reacquire the visible content control after
reload or virtual-scroll reuse before retrying.

## Media permissions and call tests

`http://localhost` is a secure context, so calls never need treat-as-HTTPS
workarounds. Two real failure modes exist and the driver neutralizes both on
every profile launch:

- A headless profile whose media prompt was auto-dismissed stores a persisted
  per-origin `block` in its ContentSettings; later getUserMedia calls fail
  immediately with `NotAllowedError` without prompting again.
- Headless Chrome may expose no real microphone/camera.

The driver therefore adds `--use-fake-ui-for-media-stream` and
`--use-fake-device-for-media-stream` and grants `microphone`/`camera` for all
three lab origins after `launchPersistentContext`. Profiles opened by an older
driver process do not get this; grant at runtime from a step via
`context.grantPermissions([...], { origin })` and reload. A running driver does
not pick up driver.mjs edits until it is restarted. Verify with
`navigator.permissions.query({ name: 'microphone' })` before concluding that a
call failure is a product result; `NotAllowedError` at setup is an environment
failure, not a block/enforcement verdict.

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
