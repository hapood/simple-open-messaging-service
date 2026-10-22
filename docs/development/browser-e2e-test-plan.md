# Web Browser E2E Test Plan

This document is the canonical natural-language acceptance suite for the local
three-node federation lab. The numbered business cases run against the Web
client in a browser. Android acceptance cases are defined separately in
[android-e2e-test-plan.md](./android-e2e-test-plan.md).
It covers account isolation, local and federated users, direct messages, group
messages, media, calls, administrative actions, and visual defects. Backend API
calls may be used only to prepare fixtures or verify a result after a visible
client action. An API-only result is not an E2E pass.

## Document ownership and lifecycle

This document is the canonical acceptance inventory. It contains stable test
scope, execution rules, matrices, and result semantics; it does not contain run
history or current completion claims.

Browser and Android have separate acceptance plans:

- `browser-e2e-test-plan.md` defines browser coverage;
  `android-e2e-test-plan.md` defines Android coverage.
- Run evidence belongs in local run artifacts, identified by platform, build,
  fixture set, and case ID. Do not accumulate progress dashboards or session
  handoffs in the project documentation.
- Keep reusable regression cases and investigation lessons in the acceptance
  plan or tooling guide, not in standalone closed-defect records.

Keep reusable harness instructions in `browser-e2e-tools.md`. This plan does not
claim any case has passed. New independent runs use fresh fixture prefixes;
reuse retained fixtures only after confirming their current roles and state.

## Test Rules

The deterministic browser runner is Playwright against the HMR frontend only.
Start the backend and HMR frontend first:

```bash
npm run dev:be
npm run dev:fe
```

Use the runner with:

```bash
npm run test:browser -- --project=federation-desktop
```

The runner refuses to start unless both Angular Web and Admin Vite report a
current successful HMR build in `/tmp/soms-browser-e2e/status/`. Built frontend
assets are not a browser acceptance target.

An adaptive browser runner can also read the numbered cases in this document
and let an AI agent operate Playwright through a restricted action protocol:

```bash
CROSS_PLATFORM_PLATFORM=browser AI_TEST_CASE=6.1 AI_TEST_API_KEY=... npm run test:cross-platform
```

It does not coordinate multi-user cases. Review the
[runner limitations](./cross-platform-ai-e2e.md#current-implementation-limits-2026-09-20)
before using it. Manual execution remains valid for the acceptance suite.

The Playwright projects and Pi driver share the lockfile-paired Chromium installed
by `npm run test:browser:install`; `CHROME_PATH` is an explicit debugging override.
See [browser testing architecture](browser-testing.md) for target isolation. Set `BROWSER_HEADFUL=1` for a visible browser. AI-run artifacts
default to `/tmp/soms-cross-platform/` and must not contain authentication
state.

### 0.7 Browser harness self-check

Run this self-check before product acceptance work and after changing the browser
harness. A harness failure is **BLOCKED**, not a product **FAIL** or **BUG**.

- The three edge URLs are reachable through the HMR frontend at ports 3101,
  3102, and 3103; browser acceptance must not use built frontend assets.
- The Web and Admin HMR status files report the current lab session and a
  successful build; a compilation failure is surfaced before browser actions.
- Persistent driver `status`, `open`, `inspect`, and `close` work without
  resetting a profile or database.
- Headful mode is available through `BROWSER_HEADFUL=1`; default runs remain
  headless.
- Invalid edge URLs and eval paths outside the repository or temporary step
  directory are rejected.
- Independent profiles do not share cookies, visible account identity, or
  IndexedDB state.
- Screenshots and traces are written under the local artifact directory with
  restrictive permissions; OTPs and passwords never enter artifacts or logs.
- Browser observations include console errors, failed requests, and relevant
  HTTP error responses, while normal HMR/favicons are filtered.
- The adaptive runner validates AI actions at runtime, writes `result.json`,
  distinguishes PASS/FAIL/BUG/BLOCKED/SKIPPED, and refuses unsupported
  single-participant execution for coordinated multi-user cases.

### Acceptance and execution boundaries

- Expand matrix bullets into stable case IDs before execution. Record platform,
  local/federated topology, fixture, build, and evidence per case. Use NOT RUN
  for planned work; SKIPPED requires a reason. A targeted unit test does not
  complete a browser acceptance case.
- Establish the expected product behavior before labeling a difference a BUG.
  Record the selected profile revision for versioned identity surfaces and the
  refresh trigger for snapshot lists. A historical avatar or a request list
  awaiting explicit refresh is not automatically stale.
- Record the observation deadline and actual convergence time for asynchronous
  checks. On timeout, separate a broken locator, unavailable environment, and
  completed product action with a missing result; do not invent a product SLA.
- Test only exposed capabilities. An absent avatar-reset control, for example,
  cannot earn a UI PASS from a component test. Record that boundary explicitly.
- Prioritize identity isolation, authorization, send/receive, profile resolution,
  and recovery before expanding media, layout, and node combinations. These
  priorities change execution order, not the required coverage.

### Platform coverage

- All cases run in a browser. Consumer cases use the Web client edges;
  administration cases use the browser Admin context of the selected node.
- Multi-user cases use one isolated Playwright context per account. Never
  replace one account's session while the case still needs that participant.
- A case that cannot run in a browser must be stated in the numbered case
  itself and reported as **SKIPPED**, not PASS.

Every small item has one of these outcomes:

- **PASS**: the client action completed and the expected state was visible in
  every required participant window.
- **FAIL**: the requested action or its business result did not complete.
- **BUG**: the business result may be correct, but the UI is broken. Examples
  include overlapping content, clipped text, broken responsive layout,
  invisible or disabled controls, stale loading indicators, wrong identity
  labels, incorrect avatars, leaked withdrawn content, and a page that cannot
  recover from a reconnect.
- **BLOCKED**: the environment prevented a meaningful test, such as a missing
  browser capability, missing media permission, or an unavailable node. A
  blocked item must include the exact cause and must not be reported as a pass.

For each completed small item, record:

1. The item ID and outcome.
2. The browser context, user, node, and viewport.
3. The exact UI actions and visible result.
4. Screenshots before and after important mutations.
5. Any console error, failed network request, or unexpected API response.
6. Cleanup status and whether the fixture can be reused.

## Lab Topology

| Node    | Federation domain | Browser edge                 | Backend                 | Database               |
| ------- | ----------------- | ---------------------------- | ----------------------- | ---------------------- |
| Alpha   | `alpha.test`      | `http://localhost:3101`      | `http://127.0.0.1:3201` | `soms_fed_lab_alpha`   |
| Bravo   | `bravo.test`      | `http://localhost:3102`      | `http://127.0.0.1:3202` | `soms_fed_lab_bravo`   |
| Charlie | `charlie.test`    | `http://localhost:3103`      | `http://127.0.0.1:3203` | `soms_fed_lab_charlie` |
| Admin   | selected lab node | selected node edge `/admin/` | selected backend        | selected lab database  |

Always use the edge URL for a browser test. Do not point the SPA at port
`320x` directly unless the test specifically targets an API or transport
failure. The edge selects the correct backend and federation identity.

## Fixed Browser Entrances

| Purpose       | URL                            |
| ------------- | ------------------------------ |
| Alpha Web     | `http://localhost:3101/`       |
| Bravo Web     | `http://localhost:3102/`       |
| Charlie Web   | `http://localhost:3103/`       |
| Alpha Admin   | `http://localhost:3101/admin/` |
| Bravo Admin   | `http://localhost:3102/admin/` |
| Charlie Admin | `http://localhost:3103/admin/` |

The Admin console is served through the same edge as its node. Do not use
`http://localhost:5180/admin/` for this lab's browser acceptance run; that is
the standalone Vite development entry and is not the federation edge.

### Admin-to-Web OTP handoff

1. Open the node Admin URL in the dedicated `admin` browser context.
2. Sign in as `admin` with the current lab Admin password. The bootstrap value
   in `.env` is only valid for a newly created Admin row; it is not a reliable
   password after a previous run changed that row. A stale retained Admin
   password is a test-fixture condition, not a project blocker: the test agent
   may use the controlled local lab credential-reset procedure to restore the
   Admin account, without resetting lab databases or recording the replacement
   password. The reset must be followed by a real Admin-page login check.
3. Open Users, locate the target account, open its detail view, and choose the
   visible issue-login-code action.
4. Read the one-time value from `#ilc-code` immediately. Never write it to a
   file, screenshot, report, terminal log, or this document.
5. In that user's independent Web context, open the edge URL. Choose the OTP
   login method if the initial route is QR, then fill `input[name="account"]`
   and `input[name="code"]` and submit.
6. Assert the visible account identity before doing any mutation. If the code
   expires, issue a new code and retry in the same short sequence.

## Cookie and Session Isolation

### Why tabs are unsafe

Browser cookies are scoped by scheme, host, and path, not by port. Therefore,
`http://localhost:3101`, `http://localhost:3102`, and
`http://localhost:3103` can share cookies because all three use the host
`localhost`. Opening Alice, Bob, and Charlie in ordinary tabs can silently
replace their session cookies. A second problem is that each account has SSE,
local storage, IndexedDB, service-worker state, and cached application data;
sharing a browser profile can mix those states even when the pages use
different ports.

### Selected isolation strategy

Use one persistent Playwright browser context per logical account. This is the
single supported strategy for this test plan:

```text
browser
  context-admin
  context-alice-alpha
  context-bob-alpha
  context-charlie-bravo
  context-diana-charlie
```

Each context must have its own storage state, cookies, local storage, IndexedDB,
service workers, permissions, and pages. A context may contain multiple tabs
for the same account, but never contains two different accounts. Save storage
state only in a local temporary directory and never commit it.

Recommended context names:

| Context                                         | Account type       | Edge URL                     |
| ----------------------------------------------- | ------------------ | ---------------------------- |
| `admin-alpha` / `admin-bravo` / `admin-charlie` | node administrator | selected node edge `/admin/` |
| `alice-alpha`                                   | local user         | `http://localhost:3101`      |
| `bob-alpha`                                     | local user         | `http://localhost:3101`      |
| `charlie-bravo`                                 | federated user     | `http://localhost:3102`      |
| `diana-charlie`                                 | federated user     | `http://localhost:3103`      |

The test runner must assert the active account after every login by reading the
visible profile/account label. A context must be discarded and recreated after
logout, forced logout, disable/enable, or an unexpected account label.

### Context lifetime and login-rate-limit rule

Contexts are long-lived fixtures for the duration of a related test batch. The
runner must create and retain one Admin context per node and one user context
per participant, then reuse those contexts for adjacent cases. Do not create a
new Admin context or perform a new Admin login for every small test item:
Admin login is rate-limited, and repeated login attempts create a test-harness
failure that can obscure the product result. Re-authenticate only when the
visible session is invalid, the backend has restarted, or the test explicitly
exercises logout or session expiry.

Admin contexts are node-specific because all lab edges use the `localhost`
host; sharing one Admin context across Alpha, Bravo, and Charlie would replace
the host-scoped Admin cookie and produce a false authentication failure.

If the retained Admin password is stale, reset only the local lab Admin
credential as test setup. Generate a random temporary password in memory, pass
it through the current process environment, and use it only to log in through
the visible Admin page. Never write that password to source, documentation,
logs, screenshots, shell history, or test artifacts. The reset must not reset
the lab databases, users, groups, messages, or federation state.

### Browser-control execution principles

The browser controller is part of the test harness and must be debugged
separately from the product under test. A locator timeout or detached DOM node
is not an unstable product UI. Inspect the live DOM and identify the owning UI
framework before deciding the result:

- Locate interactive controls through form semantics, accessibility
  relationships, routes, or scoped component structure. Never locate a control
  by localized or user-visible text. Text is allowed only for scoped business
  assertions.
- Admin React dialogs use `[data-slot="dialog-content"]` and must be reacquired
  after a dialog state transition.
- Web Angular root popups use `.material-modal.modal-show` inside
  `app-root-popup`; they are not Admin dialogs.
- Scope actions to the visible modal and close it through its visible action
  before clicking a background element with matching text.
- Scope identity, message, and domain assertions to the visible header, result
  card, message row, or dialog; whole-page text includes hidden emoji and
  attachment content.
- After reload, reopen the target conversation before asserting history.
- The group invite page renders inside `section.join-workspace`. Its
  `role=tab` elements must be scoped to that section; the chat emoji panel also
  renders `role=tab` elements globally, so a global `role=tab` locator selects
  the wrong tab.
- The Admin login success signal is the visible searchbox on `/admin/users`.
  Do not use `waitForURL` or localized heading text as
  the success condition; the sidebar, breadcrumb, and page title repeat the
  same translated label.
- Group names are capped at 31 characters. A test name longer than that is
  truncated by the form; subsequent assertions must match the truncated
  visible name (use a regex on the stable prefix) rather than the full input.
- Group invitation candidates require an active friendship. A user who
  removed the friend relationship earlier in the run cannot be invited until
  the relationship is re-established through the UI. Plan fixture order so a
  removal test does not silently break a later invitation test, or re-add the
  friendship first (which itself exercises the relationship re-add cut).

Only stop with a product BUG after the UI action is complete and the expected
versus actual difference is reproduced with a scoped assertion. Fix a
control-layer failure in the harness and retry; repair or explicitly record an
environment failure. Neither is a product result.

Do not use ordinary tabs, multiple accounts in one context, or multiple private
windows as an alternative. Ports do not isolate cookies, and private windows
can share one private cookie container. The runner must create the five named
contexts above and treat a missing or mixed context as a test-environment
failure.

Do not inspect or export cookies, passwords, or session storage for test
assertions. Isolation is established by the browser context/profile boundary,
and correctness is checked through visible UI behavior.

### Same account on multiple nodes

The same logical account should not be logged into Alpha and Bravo unless the
scenario explicitly tests that behavior. A local account belongs to its home
node. A federated participant is represented by its home-node account and
should use its home-node browser edge for UI assertions.

## Fixture Matrix

Use unique, timestamped accounts created by the Admin UI or the documented
admin provisioning flow. The following roles cover the main matrix:

| Fixture | Home node | Role                                    |
| ------- | --------- | --------------------------------------- |
| Alice   | Alpha     | local user, P2P sender, group owner     |
| Bob     | Alpha     | local user, P2P recipient, group member |
| Charlie | Bravo     | federated user, mixed group member      |
| Diana   | Charlie   | federated user, third-node group member |
| Admin   | Alpha     | administrator                           |

Keep the fixture address visible in the test log, including its domain. A
display name alone is insufficient when checking local/federated identity.

## Test Schedule

Chapters 0–10 are the shared business chapters that also apply on Android.
Chapter 11 is owned by the Android platform supplement in
[android-e2e-test-plan.md](./android-e2e-test-plan.md); browser runs never
record `11.x` results. Chapter 12 covers group announcements on the browser.

### 0. Environment and account setup

- **0.1** Open all required edge URLs and verify that each page renders the
  correct application title.
- **0.2** Check desktop and narrow mobile viewport screenshots before login.
- **0.3** Log in to Admin and verify Dashboard, Users, Audit, and settings
  navigation.
- **0.4** Create Alice, Bob, Charlie, and Diana through the Admin UI. Verify
  that the account home node and domain are shown correctly.
- **0.5** Log each user into its own browser context and verify the visible
  account identity.
- **0.6** Record browser console errors and failed requests during initial
  bootstrap. A blank shell, stuck spinner, or repeated failed SSE request is a
  failure even if the HTML response was `200`.

### 1. Administrator workflows

- **1.1** Search and paginate the user list.
- **1.2** Open each fixture's detail page and confirm account, domain, status,
  sessions, and audit data.
- **1.3** Issue a login code and complete the user login flow.
- **1.4** Disable Alice, verify her existing browser session is forced out, and
  confirm the UI explains the state rather than remaining on a stale chat page.
- **1.5** Re-enable Alice and verify that a new login works.
- **1.6** Force logout one user while that user's browser is open. Confirm the
  next protected operation returns to the login screen.
- **1.7** Verify audit records for destructive admin actions.

### 2. Local user relationships

- **2.1** Alice searches for Bob by local account.
- **2.2** Alice sends a friend request. The browser flow includes the search
  result's add-friend action followed by the confirmation dialog's send-request action; Bob sees the incoming request without a refresh.
- **2.3** Bob accepts; both windows show the active relationship and the same
  P2P thread.
- **2.4** Repeat the request and acceptance to verify idempotent or explicit
  duplicate handling.
- **2.5** Alice and Bob exchange messages, then Alice removes Bob. Verify the
  relationship UI changes while retained history remains readable according to
  the product contract.
- **2.6** Test self-request, unknown user, blocked user, and unauthorized
  message attempts. Verify a clear error state and no accidental new thread.
- **2.7** Verify the two-step friend-request confirmation is not skipped,
  duplicated, or left with a stale dialog after cancellation.

For every item in this section, run the local Alpha pair and record a separate
federated Alpha-to-Bravo result. A local PASS must not be reused as a federated
PASS: account address, domain label, transport state, system message, and
reconnect behavior are separate assertions.

#### 2.x Relationship cut matrix

Run the following matrix for both `Alice ↔ Bob` (local) and
`Alice@alpha.test ↔ Charlie@bravo.test` (federated):

- New request, request card delivery, accept, reject, cancel, and expiry.
- Duplicate request, simultaneous crossed requests, duplicate accept/reject,
  and stale-card action after the other side already decided.
- Remove relationship from each side, retained history, read-only state,
  blocked send/call controls, and re-add using the existing thread.
- Self request, unknown account, malformed address, disabled account, blocked
  account, unavailable remote node, delayed federation, retry, and recovery.
- Refresh, logout/login, SSE reconnect, and multi-tab-in-one-account checks:
  no duplicate request card, thread, system event, unread badge, or domain
  label.
- Local identity must present the account's real home domain (for example
  `alice.w1007@alpha.test`); federated identity must retain the source domain
  at search, request, thread, message, profile, preview, system event, and
  error surfaces. No user-facing surface may render the retired `local`
  sentinel.

- **2.x.cancel.federated**: Alpha sends a request to Bravo, then withdraws
  it while Bravo retains the incoming-list snapshot. Verify the sender shows
  a disabled withdrawn status, accepting the stale receiver card is rejected,
  refreshing the incoming tab removes decision controls, and both whole-page
  reloads retain the withdrawn state and read-only history. Reapply and accept
  to restore the fixture; confirm a new message arrives once. Record the
  snapshot refresh trigger separately from live delivery.

### 3. Federated user relationships

- **3.1** Alice Alpha resolves Charlie Bravo by the full federated address.
- **3.2** Verify the result card shows Charlie's account and `bravo.test`, not
  a local placeholder or an Alpha identity.
- **3.3** Alice sends the request; Charlie sees it in the Bravo browser.
- **3.4** Charlie accepts; verify both sides show the active relationship.
- **3.5** Send messages in both directions and verify source account, source
  domain, avatar, ordering, and unread state.
- **3.6** Remove the relationship from each relevant side and verify the
  read-only/retained-history behavior.
- **3.7** Repeat after a reconnect and confirm no duplicate relationship rows
  or duplicate UI cards are shown.

### 4. Local group workflows

- **4.1** Alice creates a group and confirms owner role and group metadata.
- **4.1a** Verify the new-group form's avatar picker, group-name length
  counter, optional description, validation, and create action.
- **4.2** Alice invites Bob; Bob accepts in the Bob context.
- **4.3** Verify both members see the same roster, role, group name, avatar,
  and thread.
- **4.4** Send messages from Alice and Bob. Verify real-time receipt, order,
  sender labels, unread counts, and read markers.
- **4.5** Update group name/description/avatar and verify all participants see
  the update without stale duplicate headers.
- **4.6** Bob leaves. Verify the roster, permissions, and message composer
  update on Alice and Bob's screens.
- **4.7** Test manager-only invite, role, kick, transfer, and dissolve paths.
  Confirm forbidden controls are hidden or disabled, and forbidden direct
  navigation produces a clear error.

### 5. Mixed federated group workflows

- **5.1** Alice Alpha creates a group.
- **5.2** Alice invites Bob Alpha, Charlie Bravo, and Diana Charlie.
- **5.3** Each member accepts in its own home-node browser.
- **5.4** Verify every browser displays the same roster with correct account and
  domain labels. A local/federated identity mismatch is a **BUG**.
- **5.5** Send a round-robin sequence from all four users. Verify each message
  arrives once, keeps origin identity, and appears in the same order.
- **5.6** Mark messages read from one browser at a time and check unread state
  only changes for the correct account.
- **5.7** Have Charlie leave from Bravo and verify Alpha/Charlie/Diana converge
  on membership and write permissions.
- **5.8** Invite Charlie again and verify a fresh accepted membership does not
  resurrect stale permissions or duplicate roster rows.
- **5.9** If the lab supports a controlled node interruption, disconnect Bravo,
  send an allowed message, restore Bravo, and verify eventual convergence.

### 5.10 Group invitation and application cut matrix

Every group membership scenario must be executed twice:

| Dimension         | Local case       | Federated case                            |
| ----------------- | ---------------- | ----------------------------------------- |
| Inviter/owner     | Alice Alpha      | Alice Alpha                               |
| Invitee/applicant | Bob Alpha        | Charlie Bravo, then Diana Charlie         |
| Browser contexts  | Alice + Bob      | Alice + Charlie/Diana                     |
| Identity check    | local account    | full account + home domain                |
| Transport check   | local state feed | federation delivery and mirror projection |

For each side of the matrix test:

- Owner invitation, invitee acceptance, rejection, cancellation, duplicate
  invitation, and accept/reject race.
- Invitee-initiated application, owner approval, owner rejection, applicant
  cancellation, duplicate application, re-application after rejection,
  re-application after leaving, and application after being kicked.
- Invite/approval after the invitee loses friendship, blocks the owner, is
  disabled, or the remote node is unavailable.
- Owner, ADMIN, and MEMBER control visibility; forbidden UI controls and
  direct navigation; simultaneous decisions by two managers.
- Request tabs, counts, unread dots, read watermarks, ordering, stale cards,
  refresh/reconnect, and node restart.

Browser scope excludes invitation expiry, accept/reject and
simultaneous-manager decision races, disabled-account, and remote-node-
unavailable variants: browser execution does not deterministically stage
concurrent decisions or peer-node outages. These exclusions are not successful
acceptance results.

- Roster cardinality, role, account/domain labels, group thread count/order,
  composer write permission, and lifecycle system-message uniqueness.

### 5.11 Mention and attention matrix

Run each case in a local-only group and a mixed local/federated group. The
sender, mentioned user, non-mentioned member, and observing browser must be
separate contexts where applicable.

- Single local mention: namespace-0 mention semantics
  (`somfp://user/0/bob`, displayed as @Bob) and Bob's mention unread.
- Single federated mention: `@Charlie@bravo.test` semantics, source domain,
  and Charlie's mention unread on Bravo.
- Multiple mentions across local and federated members in one message.
- The all-members mention by OWNER, ADMIN, and MEMBER. Verify authorization, including
  whether a MEMBER sees the candidate but receives a clear rejection or does
  not see the candidate; the behavior must be consistent with the product
  contract.
- The all-members mention in a local group and a federated group, including remote delivery,
  per-account unread isolation, and no duplicate notifications.
- Invalid account, invalid domain, unknown member, removed member, long
  account/display name, whitespace/case variants, and manually typed protocol
  text versus a selected mention chip.
- Mention after quote, mention inside a reply, quote a mention, mention inside
  a forwarded card, and nested forward containing a mention.
- Mention source withdrawal before read, after read, while offline, during
  reconnect, and after federation replay. The mention badge must disappear if
  the only valid unread mention is withdrawn; it must remain if another valid
  unread mention survives.
- Mark-read behavior: opening the thread clears the correct account's mention
  state only; it must not clear another member's state.
- Thread preview, unread count, `@` badge, push/notification text, refresh,
  reconnect, and system-message ordering for every local/federated variant.

### 5.12 Membership transition message-sync matrix

This matrix is required separately for a local group and a federated group. It
must use at least three independent browsers so that one participant can leave
while the remaining participants continue sending messages.

| Phase                       | Local case                                           | Federated case                                                     |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Members                     | Alice/Bob/another Alpha member                       | Alice Alpha/Charlie Bravo/Diana Charlie                            |
| Leave                       | Bob leaves Alpha group                               | Charlie leaves from Bravo                                          |
| Active senders during leave | Alice and the remaining local member                 | Alice and Diana on their home nodes                                |
| Rejoin                      | Bob is invited again and accepts                     | Charlie is invited again and accepts                               |
| Required assertions         | roster, unread, count, order, preview, system events | all local assertions plus domain, S2S delivery, mirror convergence |

For each local and federated run:

- Record thread item count and newest-first order before leave, after leave,
  while away, after re-invite, and after rejoin.
- Send at least three messages while the member is away: one immediately after
  leave, one while the leaving browser is offline/reloaded, and one immediately
  before rejoin. Verify whether each message is intentionally visible or
  hidden according to the product membership contract; do not assume all
  historical messages are readable.
- Verify the remaining members receive every permitted message once, in order,
  with correct unread counts and previews. The leaving member must not receive
  unauthorized live delivery while absent.
- After rejoin, verify the member receives the documented catch-up boundary,
  not an arbitrary full history or a missing permitted message. Check message
  order, sender account/domain, system events, and duplicate suppression.
- Full Group Meta recovery must not generate GROUP_JOINED or GROUP_LEFT,
  even when the snapshot restores a previously departed member or removes a
  previously present member. Do not require a system-message preview or unread
  increment from full recovery; check roster and message catch-up separately.
- Send a post-rejoin message from every member and verify all participants
  converge on the same sequence and thread preview.
- Verify unread count and `@` unread independently for the rejoining account and
  the accounts that stayed. Opening the thread in one browser must not clear
  another browser's count.
- Repeat with a federated member's home node temporarily disconnected, then
  restored; check delayed delivery, duplicate events, roster role, and domain
  labels.
- Verify refresh/reconnect at each phase and ensure no stale composer or stale
  member-management panel remains after leave/kick/rejoin.

### 5.12a Group role and ownership matrix

Run this matrix separately for a local group and a mixed federated group:

- OWNER promotes a MEMBER to ADMIN; both browsers show the new role and the
  correct local/federated identity.
- OWNER demotes ADMIN to MEMBER; the former ADMIN immediately loses manager
  controls, including after refresh/reconnect and direct navigation.
- OWNER transfers ownership to a local member and to a federated member.
  Verify the new OWNER gains manager controls, the old OWNER becomes an
  administrator as the transfer dialog states, and both system messages and
  domain labels are correct.
- ADMIN attempts allowed member management and forbidden owner-only actions;
  MEMBER attempts every manager action. Hidden/disabled controls and server
  rejection must agree.
- Attempt role/ownership changes concurrently from two managers; verify one
  committed order, no duplicate roster rows, no stale role resurrection, and
  correct unread/system-message state.
- Leave, kick, re-invite, rejoin, and dissolve after role changes. Verify
  permissions cannot survive membership loss and do not return after refresh.
- Check desktop/tablet/mobile member panels for role badge clipping, long
  federated domain labels, covered action menus, and wrong avatar/profile.

### 5.13 Block and search matrix

Run block/unblock and search independently for local and federated P2P peers.

- Block before friendship, after friendship, after messages exist, and after a
  remote peer blocks the actor.
- While blocked, test incoming/outgoing text, attachments, quote/forward,
  friend request, audio call, video call, notification, unread, thread preview,
  and retained history. Repeat after refresh and SSE reconnect.
- Unblock from each home node and verify the exact restored capabilities,
  duplicate-free system events, and no resurrection of stale unread state.
- Search local account/name and full federated address/name. Check wrong
  domain, unknown account, disabled/blocked peer, duplicate names, long labels,
  whitespace/case variants, pagination, result identity, and error copy.
- In-chat search must run separately on local P2P, federated P2P, local group,
  and mixed group. Search plain text, emoji, @ entities, quoted text, forward
  summaries, media filenames, withdrawn text, no-result text, and long text.
- Every search result must jump to the correct message without exposing
  withdrawn/unauthorized content or confusing local and federated sequences.
- Repeat after leave, rejoin, block, unblock, reconnect, and remote-node
  recovery. Check search header layout and result navigation on mobile.

### 6. Message receipt and withdrawal

Run these checks in both a local P2P chat and a mixed federated group. Keep the
sender, recipient, and observing browser visible in the test log.

- **6.1** Send plain text and verify the recipient receives it without manual
  refresh.
- **6.2** Send several messages quickly from different users and verify stable
  ordering and no duplicates after reconnect.
- **Scope revision (2026-09-24, 6.3):** the OS desktop-notification firing cut
  is out of browser scope until the driver can grant
  `Notification.permission`; the badge, preview, and mark-read parts stay in
  browser scope. **6.3** Verify unread badge, thread preview,
  notification state, and mark-read behavior for each account.
- **6.3a** Verify the composer, emoji panel, attachment tools, and send control
  do not obscure one another; the default panel state must not prevent text
  sending or make message order unreadable.
- **6.4** Sender withdraws a message. Verify every authorized participant sees a
  tombstone/withdrawn presentation, with no original text, media URL, or
  sensitive preview remaining.
- **6.5** Withdraw from a narrow viewport. The context menu, confirmation, and
  resulting tombstone must not overlap the composer or viewport edge.
- **6.6** Refresh and reconnect all participants. The withdrawn state must
  persist and must not briefly reveal the original body.
- **6.7** Attempt to withdraw another user's message and a message after losing
  membership. Verify rejection and unchanged history.
- **6.8** Compare every participant's thread-list item count, preview,
  unread badge, and in-thread message sequence after a fresh login. Each
  preview must follow the attention eligibility rule for that participant;
  identical preview text is not required. In particular, a participant's own
  messages do not occupy that participant's preview slots.
- **6.9** After sending a user message following a system message, verify the
  recipient's preview advances to the latest eligible message, including after
  refresh. The sender may retain the previous eligible preview by design.

- **6.10** Repeat 6.1-6.9 separately for local P2P, federated P2P, local
  group, and mixed federated group. Include the sender, recipient, observer,
  local domain, remote domain, thread count/order, preview eligibility, unread,
  mention unread, and refresh/reconnect result in each record.
- **6.11** Withdraw a message containing a single mention, multiple mentions,
  and the all-members mention; verify the recipient's mention marker and notification do not
  survive solely because the withdrawn body once contained an @ entity.
- **6.12** Report a message from the Web client, process it from the Admin Web
  message-report page, and delete the reported message through the server-side
  moderation action. This is distinct from sender withdrawal and must be run
  separately for each message origin and conversation shape:
  - local P2P: reporter, sender, and observer use independent browser contexts;
  - local group: reporter, sender, and third member observe the same thread;
  - federated P2P: deletion on the author's home propagates to the peer; deletion
    of a peer-authored mirror by the local admin stays on the reporting node and
    must not remove the author's home copy;
  - federated group: moderation at the authoritative group propagates to member
    mirrors, including the author's home; moderation at a member home of its
    own author's message propagates through the origin; moderation of another
    home's author at a mirror remains local-only.
    For each authorized propagation, record the publisher and receiver message
    coordinates, report success, Admin list visibility, Admin delete response,
    tombstone/system presentation, and report row transition. Verify the
    original body is absent at every authorized receiver, including after
    refresh/reconnect; local-only moderation must leave other nodes unchanged.
    Unauthorized participants must not gain access through the report flow.
- **6.12a** Repeat 6.12 with unread state and attention state already pending.
  Assert unread count, mention unread, all-members mention, thread item count, thread
  order, preview, notification, and in-thread ordering after deletion. Repeat
  while one client is offline, then refresh/reconnect it; the result must
  converge without duplicate tombstones or the original content flashing.
- **6.12b** Repeat 6.12 for quoted, directly forwarded, history-forwarded, and
  nested-forward content, plus image, file, voice, and video messages. Verify
  that deleting the source removes or marks the source reference according to
  the product contract, while immutable history-forward content does not reveal
  the deleted source body. Test duplicate reports, report dismissal, repeated
  deletion, deletion of an already withdrawn message, and attempts to report
  own/system/call/unauthorized messages.
- Receipt-timing, origin-retraction refusal, coordinate-collision, and
  tombstone-before-message variants have no browser-reachable entry point and
  are intentionally not part of this browser plan.

### 7. Quote, forward, and nested content

Current Web status: **COMPLETE** for the browser matrix as of 2026-09-24. The
items below remain the acceptance definition for future regressions.

- **7.1** Quote local text and verify the target preview opens the correct
  message.
- **7.2** Quote a federated message and verify account, domain, and sequence
  refer to the original source, not the mirror's local sequence.
- **7.3** Quote an image, audio message, contact card, and withdrawn message.
- **7.4** Direct-forward text, media, and contact card.
- **7.5** History-forward a selection of multiple messages and verify order,
  summaries, sender identity, and quote relationships.
- **7.6** Forward a forward card to depth 2 and depth 3. Verify the card is
  readable and visually contained. Attempt depth 4 and verify a clear limit
  error without a partial message.
- **7.7** Withdraw the source after creating a quote and both forward types.
  Verify the quote becomes unavailable while the immutable history forward
  retains its permitted snapshot.
- **7.8** Check long names, long URLs, long messages, emoji, and narrow widths
  inside quote and forward cards. Overflow or overlap is a **BUG**.

- **7.9** Repeat 7.1-7.8 for local and federated sources separately. Quotes
  preserve their source coordinates. Forward details retain display snapshots
  only, without source-author account/domain/key fields; the outer message
  identifies the forwarder. CONTACT_CARD content keeps its target identity.
- **7.10** Quote a message containing a local mention, a federated mention,
  multiple mentions, and the all-members mention; then send a new reply with and without a
  new mention. Verify source and new mention identities independently.
- **7.11** Withdraw the source of each quoted/forwarded mention message before
  and after the target reads it. Verify the quote's documented tombstone or
  unavailable state, no leaked original body/domain, and correct mention-unread
  cleanup.
- **7.12** Direct-forward and history-forward the same text, image, file,
  audio, gallery, video, contact card, quote, and nested forward to local and
  federated targets. Verify target availability, item count/order, outer sender
  identity, attachment state, and frozen display snapshots. Inner snapshot rows
  must not invent author domain labels.
- **7.13** Build nested forwards at depth 2 and 3 from local and federated
  sources; attempt depth 4 for both and assert a clear limit error with no
  partial message. Withdraw the source at every depth and compare quote versus
  immutable history snapshot behavior.

#### 7.14 Forwarded identity and avatar acceptance

Run direct forwards, multi-author history forwards, and nested forwards
separately, with local and federated authors and recipients. The entry point
determines the mode, and each mode has its own expected rendering:

- **Direct forward** (context-menu `转发` on one message, mode `DIRECT`):
  the recipient sees the message re-sent as the forwarder. An ordinary source
  remains ordinary; a FORWARD source retains its complete bundle and detail
  view without increasing depth.
- **History forward** (multi-select `合并转发`, mode `HISTORY`): the recipient
  sees a new FORWARD card wrapping the selected snapshots. The display and avatar
  assertions below also apply to a DIRECT-preserved FORWARD card.

- **7.14a** Distinguish the outer sending user's avatar from each inner snapshot
  avatar. Inner rows show frozen names and avatars without an author address or
  profile lookup. Include equal display names and avatars; they must not merge
  independent rows into an inferred sender group.
- **7.14b** Inspect both the collapsed card and opened history/detail view,
  including depth 2/3. Check real image loading, not only an accessible image
  label that can also describe an SVG fallback.
- **7.14c** Repeat with warm and fresh client media caches. Keep the detail view
  open while snapshot avatar bytes load through the outer message's resource
  authorization. Verify the captured avatar appears without a source-author
  profile request or reopening the view.
- **7.14d** Change the source author's profile before and after forwarding.
  New HISTORY snapshots use the source message's exact selected profile; later
  profile changes do not rewrite an existing bundle. DIRECT retains an existing
  FORWARD bundle unchanged. A snapshot without an avatar uses a display fallback.
- **7.14e** Scroll the card offscreen and back, switch conversations, open and
  close details repeatedly, and reload. Reused views must not retain another
  snapshot's image or name. Include narrow layouts and a recipient who
  has no direct friendship with the original author but may view the forward.
- **7.14f** Repeat the applicable withdrawal, moderation, and access-loss checks
  from 7.7/6.12b; record the permitted snapshot behavior separately from live
  source access. Do not assume cached, already-authorized history must vanish.

### 8. System messages and lifecycle events

Current Web status: **COMPLETE** for the browser matrix as of 2026-09-24. Keep the cases below as regression definitions.

System messages are server-authored events, not ordinary user text. Verify
their content, ordering, sender presentation, localization, and visibility in
every affected browser context. They must not expose internal IDs or transport
details unless the product explicitly defines them as user-visible.

- **8.1** Establish and remove a local friendship. Verify the relationship
  lifecycle message, if defined by the client contract, appears once and is
  ordered relative to nearby user messages.
- **8.2** Establish and remove a federated friendship. Verify both nodes show
  the correct local/federated account and domain, with no duplicate lifecycle
  event after reconnect.
- **8.3** Create a group and accept invitations. Verify create, invite, join,
  and role messages on the owner and member browsers.
- **8.4** Leave a group, kick a member, transfer ownership, and dissolve a
  group. Verify each resulting event is visible only to its authorized
  audience and does not leave a stale composer or roster entry.
- **8.5** End an audio/video call normally and through failure, decline, or
  cancellation. Verify the call-ended system message is consistent on both
  participants and does not reveal raw signaling payloads.
- **8.5a** Verify the missed-call system event and incoming-call controls
  (accept/decline) before testing connected media.
- **8.6** Refresh and reconnect after every lifecycle event. The event must not
  duplicate, reorder, disappear, or briefly reveal an obsolete state.
- **8.7** Check narrow layouts, long display names, federated domains, and
  translated system text. Clipping, overlap, wrong identity, or unread-state
  corruption is a **BUG**.

### 9. Media, audio, and files

Current Web status: **COMPLETE for the browser matrix as of 2026-09-24.** Keep the cases below as regression definitions. Media authorization follows retained-history semantics: logout and non-members are denied, withdrawal invalidates the contextual object, while an established P2P relationship removal or group leave preserves already-visible history as read-only and may continue serving its bound media; the composer and attachment controls must still disappear.

- **9.1** Send a valid image and verify thumbnail, full-size preview, loading,
  failure, and download states.
- **9.2** Send a multi-image gallery and verify stable cell dimensions and no
  layout shift while thumbnails load.
- **9.3** Send a generic file and verify filename, size, download action, and
  authorization after refresh.
- **9.4** Send an audio/voice message. Verify play/pause, duration, progress,
  loading, and error states in both local and federated chats.
- **9.5** Verify unauthorized participants cannot read the media URL after
  logout, relationship removal, group leave, or message withdrawal.
- **9.6** Withdraw media and verify the player, thumbnail, and download link
  disappear or become the documented tombstone state.
- **9.7** Forward image, audio, gallery, and contact-card content across nodes.

### 10. Audio and video calls

Use Alice and Bob for a local call, then Alice and Charlie for a federated call.
The call test requires separate browser contexts and explicit microphone/camera
permissions granted only to the test origins.

- **10.1** Start an audio call and verify the callee receives the incoming-call
  UI in real time.
- **10.2** Verify ringing, accept, connected, and call-duration states.
- **10.3** Exchange signaling frames and verify neither UI displays raw signaling
  payloads or stale loading indicators.
- **10.4** Upgrade audio to video and verify both participants see the video
  state and camera controls.
- **10.5** End normally and verify call history/system notice on both sides.
- **10.6** Test decline, caller cancel, timeout/failure, and busy behavior.
- **10.7** Test a federated call and verify the correct domain/account labels.
- **10.8** Test permission denial and device absence. The UI must provide a
  recoverable error, not a frozen overlay or an unusable page.

### 12. Group announcements

Run 12.1–12.5 in a local Alpha group and 12.6–12.8 across the Alpha/Bravo
federation with an origin group and a remote mirror member. Use isolated test
accounts, record the observed Group Meta feed coordinates in the result
entries, and never paste announcement content containing private information
into logs.

- **12.1** Create a group as a local owner. Open its chat on desktop and
  narrow/mobile viewports. An initially cleared announcement shows neither a
  loudspeaker nor an automatic popup. An ordinary member cannot access the
  editor; the local owner and a local admin can find **Group announcement**
  under the chat More → group-info panel.
- **12.2** Publish a multiline announcement including emoji and literal
  `<b>not markup</b>`. Check the loudspeaker beside the group name, the
  chatbox-scoped popup (over both message list and composer), plain-text
  rendering and line wrapping, focus/keyboard-back/backdrop dismissal, and
  that the message history/scroll position does not move. Close it, leave and
  reopen the chat: it must not reopen automatically. Click the loudspeaker: it
  should still open manually.
- **12.3** Edit the text as an admin: it must get a new Group Meta `feedId`,
  not a message sequence, and auto-open once again. Change it rapidly twice
  while one client is offline: after reconnect only the newest compacted text
  may be shown, not intermediate edits. A stale acknowledgement of an older
  displayed popup must not suppress the newest edit.
- **12.4** Try empty text, 4097 Unicode code points, double submit,
  unauthorized member edit, and a dissolved/read-only group. The UI should
  prevent invalid submissions and the server should reject unauthorized
  writes. Clearing requires confirmation. Clear and revisit: the loudspeaker
  and automatic popup disappear; the known `text: null` projection must not be
  confused with an unknown/unfetched announcement.
- **12.5** Open the same group on two devices/sessions of one account. View
  the popup on device A. Device B should obtain the new per-account read
  watermark through the existing `THREAD_FEED_UPDATED` cursor pull and must
  not auto-open that announcement after convergence; a later edit should
  auto-open on each device once. No new SSE event type or announcement text
  should appear in SSE payloads.
- **12.6** Have a remote member join an origin group. Publish/edit/clear as an
  origin-local owner/admin. The remote mirror should receive the current
  announcement through Group Meta and display it with the same loudspeaker and
  popup behavior. A remote admin cannot publish an announcement on the mirror.
  Other group/profile/roster updates must not cause an already read
  announcement to reappear.
- **12.7** With the remote client offline, advance and compact the announcement
  several times, including an explicit clear; reconnect and check that the
  latest current projection wins. Force a bounded full recovery with multiple
  pages: while recovery is incomplete the cached announcement must not be
  displayed. When complete, a returned announcement from an earlier page
  should be retained even if the last page contains no announcement; a full
  drain containing none makes it unknown rather than a known clear. Subsequent
  delta catches up when the origin replaced it above the fixed full boundary.
- **12.8** Revoke the remote relationship and attempt further reads: no more
  announcement data should be served. Reauthorize, recover the current
  projection, and verify that a stale cached copy is never displayed as
  current before the new Group Meta head is reached.

## Cross-Domain Coverage Matrix

The words "local" and "federated" are test dimensions, not labels that can be
substituted after the fact. Every applicable small item below requires two
separate browser records:

| Dimension  | Local execution                                    | Federated execution                                                         |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Accounts   | Alice/Bob on Alpha                                 | Alice Alpha + Charlie Bravo, and Diana Charlie where relevant               |
| Web edges  | Alpha for both contexts                            | Each user uses its home-node edge                                           |
| Identity   | full `account@alpha.test` home-domain presentation | full `account@bravo.test` / `account@charlie.test` peer-domain presentation |
| Transport  | Alpha HTTP/SSE/state feed                          | S2S delivery, mirror projection, remote HTTP/SSE                            |
| Assertions | local thread, role, unread, system event           | same assertions plus origin domain, mirror sequence, convergence            |
| Recovery   | browser refresh/reconnect                          | browser refresh, remote-node reconnect, delayed/duplicate federation event  |
| UI         | 1440x1000 and 390x844                              | 1440x1000 and 390x844 on both home edges                                    |

Never mark a federated case PASS because its local analogue passed. The result
log must use suffixes such as `2.4-local` and `3.4-federated` and include the
source and target domain in every screenshot/result entry.

## Additional Feature Matrix

These are required feature domains that must be scheduled even when they are
not represented by a single top-level page. Each bullet is run for both local
and federated cases unless the domain is explicitly local-only.

### A. Relationship and Block

- Search by account, display name, full federated address, whitespace/case
  variants, unknown account, disabled account, and malformed address.
- Friend request send, cancel, accept, reject, duplicate, crossed request,
  expiry, stale card, reconnect, and node restart.
- Remove friendship from either side, re-add, retained history, send/call
  permissions, old thread reuse, and lifecycle system messages.
- Block and unblock a peer; verify the switch, persisted state, incoming and
  outgoing message behavior, call behavior, request behavior, profile label,
  thread preview, unread, and refresh/reconnect convergence.
- Block before friendship, block after friendship, block a local peer, block a
  federated peer, remote peer blocks locally, both sides block each other, and
  unblock from both home nodes.
- Confirm the block UI does not claim that a federated peer is local and does
  not expose internal authorization/error payloads.

### B. Search

- Friend/user search: local account, local display name, federated full
  address, domain-only mismatch, unknown result, pagination, duplicate result,
  and long identity labels.
- In-chat message search in local P2P, federated P2P, local group, and mixed
  group: exact text, substring, emoji, mention text, withdrawn text, quoted
  text, forwarded text, media filename, no result, multiple results, next/
  previous navigation, close/reopen, and refresh.
- Search result selection must jump to the correct message sequence and must
  not confuse an author's local sequence with a federated mirror sequence.
- Verify search does not expose withdrawn bodies, unauthorized group content,
  internal CAS URLs, feed IDs, or stale results after leave/block/remove.
- Verify search UI at desktop/mobile: input/header does not overlap the date
  pill, navigation buttons remain clickable, result count is correct, and the
  page does not horizontally overflow.

### C. Conversation Preferences

- Mute/unmute, pin/unpin, alias, block, mark-read, unread, mention unread,
  and notification preview for local and federated threads.
- Verify preference changes persist after refresh/reconnect and remain scoped to
  the acting account; Bob's mute/pin must not alter Alice's.
- Verify group preferences and P2P preferences do not leak across a reused
  thread ID or a re-added friendship.

### D. Groups and Roles

- Create, update name/description/avatar, invite, apply, accept, reject,
  cancel, expire, leave, kick, promote, demote, transfer ownership, dissolve,
  and rejoin.
- Execute each action once in a local group and once with a federated member;
  run a four-person mixed group for roster/domain/order convergence.
- Test owner/admin/member controls, direct-navigation denial, simultaneous
  manager decisions, stale cards, duplicate events, unread request dots, and
  permission changes after leave/kick/block.

### E. Message Semantics

- Text, emoji, multiline, long text, link preview, reply/quote, direct forward,
  history forward, nested forward depth 2/3/4, contact card, image, gallery,
  file, audio, and video.
- For every message type, test send/receive, order, duplicate suppression,
  unread, preview, mark-read, refresh/reconnect, withdraw, unauthorized
  withdrawal, quote/forward after withdrawal, report, Admin deletion,
  moderation tombstone propagation, and local/federated origin.
- Test system messages separately from user messages: relationship, group,
  invite/application, role, leave/kick/dissolve, calls, media failure, and
  node recovery.

### F. Mention and Notification

- Single local mention, single federated mention, mixed multiple mentions,
  all-members mention, invalid target, long target, mention in quote, mention in forward,
  and mention in nested forward.
- Test OWNER/ADMIN/MEMBER permission for the all-members mention, mention unread isolation,
  push/notification text, thread preview, read clearing, refresh/reconnect,
  and withdrawal of the only or one-of-many unread mentions.

### G. Media and Calls

- Image/file/gallery/audio/video state machine: staged, uploading,
  synchronizing, downloading, complete, failed, canceled, retrying, and
  withdrawn. Run local and federated source/receiver pairs separately.
- Distinguish node-to-node federation transfer from browser-to-disk download;
  verify progress monotonicity, hash/size, no duplicate download, refresh
  recovery, remote node restart, and authorization after leave/block/withdraw.
- Audio calls and video calls: local and federated ringing, accept, reject,
  cancel, timeout, busy, permission denial, device absence, reconnect, end
  system message, and no signaling leakage.

### H. UI/Accessibility/Responsive Review

- Every feature above is checked at desktop, tablet, and 390x844 mobile.
- Check clipping, overlap, focus traps, covered controls, keyboard/Enter
  behavior, dialog/backdrop dismissal, labels/tooltips, domain truncation,
  spinner cleanup, virtual-scroll stability, and horizontal overflow.
- UI defects are BUG outcomes even when the backend business result is correct.

### I. Avatar and Identity-Media Matrix

Avatar changes must be tested independently from text/profile changes. Every
case below is run once for local participants and once for federated
participants where the identity is visible across nodes.

#### I.1 Personal avatar lifecycle

- Upload a valid square image, portrait image, landscape image, transparent
  PNG, large image, small image, animated/unsupported image, and a file with a
  misleading extension.
- Verify picker, crop/editor, rotate/zoom if offered, preview, cancel, save,
  upload progress, upload completion, and upload failure states.
- Switch Alice's avatar A → B → C rapidly; verify the final committed avatar
  wins and stale upload completions cannot restore A or B.
- Cancel after selecting an image and confirm the old avatar remains.
- Reload during upload, reconnect after upload, and log out/in; verify the
  committed avatar remains and the UI does not show a stale preview.
- Verify avatar propagation in profile page, friend search result, request
  card, P2P thread list, message sender label, member roster, mention popup,
  notification, call UI, quote card, and forward card.
- Verify every surface renders the profile revision selected by its evidence.
  Different historical and current references may legitimately show different
  images. Check object URL cleanup after repeated switches and remounts.

#### I.2 Local/federated personal avatar matrix

| Scenario               | Local assertion                               | Federated assertion                                    |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Alice changes avatar   | Bob sees new avatar on Alpha                  | Charlie sees new Alice avatar on Bravo                 |
| Charlie changes avatar | Alice sees the remote update after federation | Alpha/Bravo source and mirror labels stay correct      |
| Refresh/reconnect      | Both local browsers converge                  | Both home-node browsers converge after S2S replay      |
| Offline/delayed update | Old avatar remains until committed            | No partial or stale remote profile is shown            |
| Remove/reset avatar    | Default avatar appears everywhere             | Default avatar propagates without wrong local fallback |

For every federated avatar assertion verify the domain and account remain
correct; a remote avatar must never be attached to a same-account local row.

#### I.2a Profile-update trigger matrix

Test both profile-reference changes and availability of the selected immutable
profile. A new revision does not globally invalidate historical references.
For each profile change A → B → C, record each surface's selected revision and
run the local and federated columns separately. Consecutive messages may share
an existing sender run; use an intervening peer message when checking a new run.
Snapshot lists are checked after their supported refresh action.

| Trigger/surface          | Local execution                                                                   | Federated execution                                                                 |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| New friend request       | Bob's Alpha request card updates Alice's avatar/name                              | Charlie's Bravo request card updates Alice's remote avatar/name and domain          |
| Accepted friendship      | Existing P2P header/list/message sender refreshes                                 | Remote P2P header/list/message sender refreshes after S2S replay                    |
| Group invitation         | Pending local invite card shows current group/owner/avatar                        | Remote invite/application card shows current group/owner/avatar and source domain   |
| Group join/roster        | Existing member row and group header refresh                                      | Mirror roster and group header refresh on the remote home node                      |
| New message              | Sender avatar in a new message and thread preview uses the newest profile         | Federated sender avatar/domain update arrives with or before the message projection |
| Existing message history | Render the revision selected by the message/sender run without rewriting identity | Resolve the selected historical revision without local-domain substitution          |
| Mention popup            | Candidate label/avatar updates                                                    | Federated candidate retains remote account/domain and new avatar                    |
| Quote/forward card       | Render the revision selected by card evidence; execute 7.14                       | Preserve source account/domain and the selected permitted revision; execute 7.14    |
| Call UI/system event     | Caller/callee avatar updates in an active/local call                              | Federated call UI uses the remote profile and domain                                |

For every row:

- Change profile while the target surface is already open, then while it is
  closed and reopened.
- Change profile before the invitation/request/message is created and again
  after it has already arrived but before it is read.
- Verify A → B → C rapid changes cannot finish out of order and restore an old
  image or display name.
- Verify profile update events survive refresh, SSE reconnect, delayed
  federation, and a new login; no surface may require a full database reset.
- Compare the visible avatar URL/image digest only through browser-rendered
  behavior. Do not use cookies or internal storage state as a PASS assertion.
- Verify each rendered image matches its surface's selected revision after
  that reference changes or its pending resolution completes. A newer image
  elsewhere is not by itself evidence that this surface is incorrect.

#### I.2b Profile fields beyond avatar

Repeat the same matrix for display name, bio, and default-avatar reset. A
profile update must not change the immutable account/domain identity, message
author identity, group membership role, or thread ordering unless the product
explicitly defines that behavior.

#### I.2c Resolution paths and lifecycle isolation

Browser scope, 2026-09-24 revision: I.2c.6 (clear-cache recovery) stays in
this browser plan. I.2c.3 (revision/namespace match isolation), I.2c.4
(delayed completion across session switches), and I.2c.5 (disconnect during
pending resolution) require deterministically staged out-of-order
notifications and pending-resolution windows of a few hundred milliseconds;
they are removed from the browser sweep. Negative assertions about internal
notification ordering are not reliably provable from rendered DOM alone.

- **I.2c.1** Warm-cache/READY: mount each identity surface with the selected
  profile already cached. It must render without requiring a later event.
- **I.2c.2** Cold-cache/PENDING: keep the surface mounted through runtime
  completion and local notification. It must update without manual refresh.
  Exercise proactive UI demand and state-feed-triggered resolution separately.
- **I.2c.6** Clear chat cache using Settings, then reopen/reload identity
  surfaces. Profile rows and avatar assets must remain usable according to the
  profile-cache contract. Test fresh-cache behavior separately; no historical
  schema conversion or legacy avatar compatibility is required.

Browser assertions establish visible behavior. Deterministic event ordering,
commit-before-notification, and four-field mismatch cases also require focused
runtime/repository tests; record those separately and do not claim that UI code
subscribes to raw backend SSE.

#### I.3 Group avatar lifecycle

This is a required independent matrix, not an optional part of personal
avatar testing. Run it once for an Alpha-local group and once for a mixed
Alpha/Bravo/Charlie group.

- Owner creates a group with no avatar, with an avatar, and changes the group
  avatar after members have joined.
- Change group avatar A → B → C from OWNER; verify ADMIN/MEMBER viewers update
  without duplicate headers or stale thread-list avatars.
- Verify the exact trigger fan-out after each change: owner browser, existing
  member browser, pending invitation/application card, newly joined member,
  thread-list row, message header, member-management panel, mention popup,
  quote/forward card, notification, and call UI.
- Change the avatar while the group info panel is open, while the group is
  closed, immediately before/after an invitation, during a member join, and
  while a member is leaving. Each surface must converge to the same final
  revision.
- Attempt group-avatar changes as MEMBER, after leaving, after being kicked,
  after ownership transfer, and after dissolution; controls must be hidden or
  produce a clear rejection.
- Verify group avatar in every member's thread list, message header, group
  info, invite/application card, member-management panel, notification, quote,
  forward, and call surface.
- Test local group avatar propagation and mixed federated group propagation to
  Alpha, Bravo, and Charlie home-node browsers.
- In the federated case, change the group avatar on Alpha and assert the Bravo
  and Charlie mirrors update with the Alpha group identity, not a local group
  identity. Change it again from Alpha after a remote member joins and verify
  no stale mirror or remote-domain/avatar pairing remains.
- Change the avatar while an invite is pending, while a member is joining,
  while a member is leaving, and while a remote node is offline. Verify the
  final avatar and event ordering after convergence.

#### I.4 Authorization, media safety, and visual checks

- Avatar URL must not expose internal storage paths, temporary upload names, or
  an unauthorized asset.
- After block, friendship removal, group leave, kick, dissolve, message
  withdrawal, and logout, verify avatar visibility follows the product access
  contract and does not leak through cached DOM/image URLs.
- Verify failed/corrupt/oversized uploads leave the old avatar intact and keep
  the form recoverable.
- Verify long names and federated domains beside avatars do not overlap,
  truncate identity, distort aspect ratio, or shift fixed row heights.
- Run desktop, tablet, and 390x844 mobile checks for crop dialogs, profile
  panels, group headers, invite cards, roster rows, message bubbles, and call
  overlays. UI clipping, wrong avatar, stale avatar, or layout shift is a BUG.

## Viewport and Visual Review Matrix

For every major page and each high-risk mutation, capture at least:

| Viewport | Width | Height | Focus                                                 |
| -------- | ----: | -----: | ----------------------------------------------------- |
| Desktop  |  1440 |   1000 | sidebar, chat, member panel, admin tables             |
| Tablet   |   900 |   1100 | collapsed navigation, dialogs, two-column transitions |
| Mobile   |   390 |    844 | composer, menus, quotes, media, call overlay          |

Check the full visible page and not only the target control. Mark a **BUG** for
any of the following:

- text, icons, buttons, menus, dialogs, or message bubbles overlap;
- content is clipped, horizontally scrolls unexpectedly, or exceeds its parent;
- a control is visible but covered by another element or cannot be clicked;
- a loading, error, or reconnect overlay never clears;
- sender/account/domain labels are truncated so identity becomes ambiguous;
- a message, withdrawn body, media URL, or quote preview is exposed incorrectly;
- the layout changes height unexpectedly while messages or media load;
- a browser console error prevents a visible workflow from completing.

## Result Template

Use one entry per small item:

```text
Major category: 6. Message receipt and withdrawal
Small item: 6.4 Sender withdrawal in mixed federated group
Platform: browser
Build/revision: ...
Execution: manual | Playwright smoke | adaptive runner
Outcome: PASS | FAIL | BUG | BLOCKED | SKIPPED
Contexts: alice-alpha, bob-alpha, charlie-bravo, diana-charlie
Viewports: 1440x1000, 390x844
Actions: ...
Expected: ...
Observed: ...
UI review: ...
Console/network: ...
Screenshots: ...
Cleanup: ...
```

## Cleanup and Data Safety

Use a unique fixture prefix for every run. Do not reuse old accounts merely
because they already exist. A continuation of a retained run may reuse the
fixtures explicitly identified in the progress log; verify their current state
and do not assume initial roles, friendships, or empty history. At the end of a run, log out every browser context,
close pages, and remove temporary storage-state files. Delete or disable only
the accounts created by the run. Do not run `npm run dev:reset` while another
test run is using the lab; it drops the isolated lab databases and runtime
state for all three nodes.

If a run is intentionally retained for manual inspection, record the fixture
prefix, account domains, group IDs visible in the UI, and the exact cleanup
command or admin actions still required.
