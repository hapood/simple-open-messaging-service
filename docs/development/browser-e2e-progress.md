# Cross-platform E2E Progress

Last reconciled: **2026-09-20** against the retained browser results and current
working-tree changes. This is the resume checklist; the
[test plan](./browser-e2e-test-plan.md) defines the full acceptance matrix.
Historical PASS results below apply only to the stated scope and tested build.
The documentation cleanup did not run tests, restart services, or verify live
service health. Current fixes are still working-tree changes, not a release.

## Manual Browser Run: 2026-09-20

Execution is being performed in real Chromium pages with one isolated browser
context per account. Playwright is used only as the browser control surface and
for screenshots; the business actions are performed through the visible Web and
Admin UI. Browser output directories are ignored by Git.

| Case | Platform / viewport | Result | Evidence / note |
| --- | --- | --- | --- |
| 0.1 Edge rendering | Chromium, 1440x1000 and 390x844; Alpha, Bravo, Charlie | PASS | All six pages returned HTTP 200, title `SOMS`, visible non-empty shell, no console errors or failed requests. Screenshots are under `/tmp/soms-browser-e2e/` and are not tracked. |
| 0.2 Narrow login surface | Chromium, 390x844; Alpha, Bravo, Charlie | PASS | Login/QR surface rendered without visible clipping or overlap in the sampled viewports. |
| 0.3 Admin login and navigation | Chromium, Alpha Admin | PASS (after fixture recovery) | The visible Admin form initially showed `账号或密码错误` because the retained password differed from `.env`. The test agent reset only the `admin` password hash in the three retained lab databases, then logged in through the real Admin page. Users and Settings rendered; no database reset or API-only workflow was used. The route expected as Audit is currently the visible 持久任务 page, so the Admin navigation map needs a separate audit-route check. |
| 0.4 Admin fixture creation | Chromium, Alpha/Bravo/Charlie Admin | PASS | Created the run-owned Alice/Bob on Alpha, Charlie on Bravo, and Diana on Charlie through visible Admin dialogs. Each row showed the expected local domain and active status. Run prefix is retained locally for continuation and is not a credential. |
| 0.5 User OTP login and context isolation | Chromium, four independent contexts, 1440x1000 | PASS | Issued codes from each user's visible Admin detail dialog, then completed OTP login in the corresponding user page. Alice/Bob/Charlie/Diana each reached their own empty workspace with no console errors. OTP values were not recorded. |
| 2.1 Local friend search | Chromium, Alice/Bob isolated contexts, 1440x1000 | PASS | Alice opened the visible 好友请求 panel, searched Bob's exact local account, and saw Bob's display name with 添加好友. No domain/identity mismatch or console error observed. |
| 2.2 Local friend request | Chromium, Alice/Bob isolated contexts, 1440x1000 | PASS | Alice selected Bob, saw the dedicated request form and optional note field, then used the visible 发送请求 action. Bob received one incoming request card without refresh. |
| 2.3 Local friend acceptance | Chromium, Alice/Bob isolated contexts, 1440x1000 | PASS | Bob accepted through the visible request card. Both clients converged on one P2P row with a system-message preview and thread item count 1; Bob's card changed to 已同意. |
| 2.4 Duplicate local request | Chromium, Alice context, 1440x1000 | PASS | A second exact search returned one Bob result with the visible 已是好友 state and no duplicate request action or second result row. |
| 2.5 Local message and unfriend | Chromium, Alice/Bob isolated contexts, 1440x1000 | PASS | Alice sent a unique text and both clients displayed it. Bob used the visible 好友信息 -> 解除好友关系 -> confirmation flow; Bob retained the message history and showed the removal system event, while Alice received the relationship update. |
| 2.6 Local relationship boundaries | Chromium, Alice context, 1440x1000 | PASS | Searching Alice's own account showed 本人; searching an unknown account showed 未找到用户 and the query text. No add action, relationship, or extra thread was created. |
| 3.1-3.2 Federated friend search and identity | Chromium, Alice@alpha.test context, 1440x1000 | PASS | Alice searched the full `charliee2e82252821@bravo.test` address. The result showed Charlie and the source `bravo.test` domain with 添加好友; it was not presented as a local identity. |

The retained Admin password condition is not a project blocker. If it recurs,
restore the local lab credential through the controlled reset procedure and
re-verify through the Admin page. Do not record the password, OTP, cookie, or
storage state here.

## Resume Here

1. Review and deploy the current Profile fix to the lab without resetting its
   databases. The backend build and Web development build passed on September
   20, but the lab backends were not restarted in that follow-up. Confirm the
   browser edge serves the new worker bundle; a successful build alone does
   not establish this.
2. Reuse the retained fixture below for this regression. Sign in through each
   node's Admin UI with its current credential and issue fresh OTPs immediately
   before login. Keep independent Alice, Bob, and Charlie contexts.
3. Run the [Profile regression checklist](./browser-e2e-bug-profile-update-stale-roster.md#verification-plan),
   starting with Bob's already-open member panel and Charlie's Bravo roster.
   Keep the panel mounted while Alice changes name/avatar. Do not use a reload
   or reopening as the first success assertion.
4. Record local and federated results separately, then continue the remaining
   matrix below. Any case without an explicit completed result remains pending.
   Browser results do not establish Android/native results.

## Retained Environment and Fixtures

These are historical fixture facts, not a live inventory. Confirm availability
before resuming; do not create replacements just because a fresh login is needed.

| Role | Home node | Web edge | Account | Last confirmed state |
| --- | --- | --- | --- | --- |
| Alice | Alpha | `http://localhost:3101/` | `alicemu8azkcm` | ADMIN in retained mixed group; latest diagnostic profile was Alice Profile D, revision 4 |
| Bob | Alpha | `http://localhost:3101/` | `bobmu8azkcm` | OWNER after ownership transfer |
| Charlie | Bravo | `http://localhost:3102/` | `charliemu8btagx` | MEMBER after federated leave/rejoin |
| Diana | Charlie | `http://localhost:3103/` | `dianamu8btagx` | Admin creation and OTP issuance confirmed; consumer scenarios pending |

- Retained Alpha-authoritative group: `PW-FINAL-1789833263100`.
- Alpha also has older local fixtures `charliemu8azkcm` and `dianamu8azkcm`;
  they are not the federated Charlie/Diana participants.
- Local identities use `local`; Alpha identities appear as `alpha.test` on
  Bravo. Preserve account/domain distinctions in every assertion.
- Admin entry is `/admin/` on each Web edge; Admin account is `admin`.
  Bootstrap configuration does not overwrite a previously changed password.
- Backend ports: `3201`, `3202`, `3203`. Built Web edges: `3101`–`3103`.
- Browser used: system Chrome at `/usr/bin/google-chrome`, headless Playwright,
  independent contexts per participant. Desktop and 390×844 mobile were sampled;
  tablet and complete responsive coverage remain pending.
- Historical screenshots: `/tmp/soms-browser-e2e/`. These are temporary local
  artifacts and may no longer exist; paths below identify the original evidence.
- Do not record passwords, OTPs, cookies, or storage state. Fixtures were retained
  for manual inspection; no cleanup or database reset is claimed. After testing,
  log out/close contexts and use Admin to remove only confirmed run-owned fixtures
  if they are no longer needed. Do not delete older unrelated accounts.

## Confirmed Browser Results

Partial results are intentionally narrower than a full numbered test-plan case.

| Plan area | Confirmed scope | Still required |
| --- | --- | --- |
| 0 / 1 Environment and Admin | All three edges and Admin logins worked; user lists, account creation, and OTP issuance observed; reusable desktop/mobile entry smoke passed 6/6 | Remaining Admin workflows and full identity/login lifecycle matrix |
| 2 Local friendship | Alice/Bob request acceptance and friendship system message | Rejection, cancellation, removal/re-add, duplicate and authorization cuts |
| 3 Federated friendship/P2P | Alice searched Charlie at `bravo.test`; request, acceptance, exact text receipt, domain labels and thread counts passed | Remaining relationship cuts and Charlie-node/Diana coverage |
| 4.1 Creation | Fresh group appeared newest; Group Meta fetched; owner count 1 and OWNER badge | 4.1a avatar/form validation matrix and regression after subsequent changes |
| 4.2 / 4.3 Invite/roster | Bob accepted, thread count rose 1→2, roster showed two members; MEMBER lacked manager actions | Remaining invitation/application cuts |
| 5.12 Local leave/rejoin | Bob's leave made thread read-only, stopped live away messages, retained history; rejoin later confirmed by role tests | Explicit ordered catch-up/unread assertion for local rejoin |
| 5.12a Local roles | Alice promoted Bob to ADMIN, badge/access survived fresh login; ownership transferred to Bob, Alice became ADMIN and lost dissolve control | Full role/denial/concurrency matrix and federated role mutation |
| 5.12 / 5.12a Federated group | Charlie joined; Bravo roster converged to 3 with Alice ADMIN, Bob OWNER, Charlie MEMBER and correct domains; Charlie's message reached Alice/Bob | Reconnect/restart and other mixed-group cuts |
| 5.12 Federated leave/rejoin | No live away-message delivery; after rejoin both away messages appeared in order with Alpha identity | Remaining transition/concurrency cases |
| 5.11 Mention | Local Bob selection sent successfully, full address preserved, Bob received message and unread badge | Dedicated mention marker, multiple/all, permissions, federated targets, withdrawal and notification matrix |
| 6 Text/read | Alice/Bob ordered text history, count, recipient preview and read clearing; two local group texts arrived live in order with unread 2; federated P2P/group text receipt | Full rapid multi-sender/reconnect matrix; earlier local P2P live first-message observation required reload, so do not infer full live receipt coverage |
| 6.4 / 6.6 Withdrawal | Local group sender-only withdrawal, both views lost original body, Bob retained tombstone after refresh | Federated, media/mention, mobile and loss-of-membership cases |
| 6.12 / 6.12a / 6.12b Report and Admin deletion | Backend message-report/delete E2E and Admin component tests exist; no browser end-to-end execution claimed | Web report -> Admin list -> server deletion -> local/federated participant convergence, unread/mention/thread counters, offline reconnect, nested/media cases |
| 6.8 / 6.9 Preview | Sender/recipient difference follows attention eligibility; own messages do not advance sender preview | Continue per-participant eligibility checks |
| 7.1 Quote | Local group text reply showed original author/text in composer and recipient quote | Direct forward, nested content, authorization/withdrawal cuts |
| 9.4 Voice | Local group and federated P2P recording/receipt/playback passed with fake media; playback time advanced without media error | Real audio quality, remaining media/file state machine |
| 10.1 Calls | Federated outgoing/incoming, accept, both sides' mute/hang-up controls and call events observed | Normal hang-up result, actual media quality, local calls, video and failure/lifecycle matrix |
| 5.13 / Additional B Search | Charlie's mixed-group search for `MENTION-FIXED` showed `1 / 1` | P2P assertion, filtering, pagination, withdrawn/unauthorized results |
| 5.13 / Additional A Block | Federated block request returned success and visible switch changed with domain preserved | Refresh persistence, unblock, blocked send/call behavior; verify current block state before call tests |
| Additional I Personal Profile | Alice editor saved new profile/avatar; backend and client stale-roster evidence captured | Open bug below; no propagation PASS |

### Closed Findings

The two fixed Bug records and the expected-preview observation have been
consolidated here; their separate files were removed on September 20. Their
regression requirements remain in the test plan.

- **Group member count zero — fixed, browser PASS.** Backend local membership
  now seeds the authoritative Group Meta cursor; mirror membership retains its
  replicated cursor. Web HELLO drains thread/Group Meta even with a worker,
  and successful group creation refreshes the realtime handshake. Current
  changes are in `GroupMembershipProjectionService`, `ThreadRepository`,
  `ConversationListService`, and `NewGroupComponent`; PostgreSQL regression
  assertions exist in `test/group-creation.e2e-spec.ts` and
  `test/group-meta-mirror-round.e2e-spec.ts`. Final browser evidence: fresh
  group increased thread count 6→7, fetched Group Meta through 2, and displayed
  one OWNER. Screenshot: `pw-final-group-members.png`. The earlier unresolved
  Bob acceptance note was superseded by the 4.2/4.3 PASS above.
- **Mention missing domain — fixed, browser PASS.** Roster-to-editor mapping in
  `friend-message.component.ts` now preserves `account@domain`; the candidate
  filter test covers full-address input. The real send returned `code: 0`,
  encoded `somfp://user/bobmu8azkcm%40local`, and Bob received the text with an
  unread badge; no `40006` recurred. Screenshot: `bob-mention-fixed.png`.
  This does not establish the full mention notification/permission matrix.
- **Sender preview remains a system message — expected behavior.** Own messages
  are ineligible for the sender's attention preview. Bob saw the latest eligible
  text; both histories, count and read behavior were correct. The acceptance
  rule is retained in test-plan 6.8/6.9. Screenshots:
  `alice-thread-messages-ordered.png`, `bob-refresh-history-check.png`.

### Other Evidence Index

All filenames below are relative to `/tmp/soms-browser-e2e/`.

- Federated request/text: `alice-federated-request-sent.png`,
  `charlie-federated-accepted.png`, `alice-federated-message.png`,
  `charlie-federated-message.png`.
- Local group text/withdraw/quote: `alice-group-messages.png`,
  `bob-group-messages.png`, `bob-withdrawn-final.png`,
  `bob-withdrawn-refresh.png`, `bob-quoted-message.png`.
- Voice: `bob-voice-playback.png`, `charlie-federated-voice.png`.
- Membership/roles: `local-away-alice.png`, `local-away-bob.png`,
  `alice-owner-transferred.png`, `charlie-rejoined-federated-group.png`.
- Mixed group delivery: `alice-federated-group-message.png`,
  `bob-federated-group-message.png`.

## Open Bug and Automated Validation

[Profile/avatar update leaves mounted roster stale](./browser-e2e-bug-profile-update-stale-roster.md)
remains **browser regression pending**. The revised backend commits local
profile, authoritative roster propagation and durable fanout in one transaction.
The Web path emits availability only for a newly inserted resolved snapshot after
IndexedDB commit; the worker forwards it, queried member rosters invalidate, and
superseded panel queries cannot overwrite newer results.

Completed on September 20 before this documentation-only cleanup:

| Validation | Result | Limit |
| --- | --- | --- |
| `npm run build` | PASS | Compilation, not live deployment |
| `npm run build:debug --prefix web` | PASS | Development bundle; serving it was not verified |
| `npm run test:e2e -- test/current-group-roster.e2e-spec.ts test/system-account.e2e-spec.ts` | 4 tests PASS | Revision advancement/non-regression, departed-member exclusion and system account; not concurrent mutation coverage |
| Web member/profile repository, storage and native-routing specs | 26 tests PASS | Commit visibility, duplicate/cache/abort notification behavior; native routing is not native E2E |
| GroupInfo component query-ordering spec | 2 tests PASS | Superseded first-page and pagination results dropped |

The 28 Web tests are in `member-profile-store.service.spec.ts`,
`profile-store.service.spec.ts`, `webdb-storage.spec.ts`,
`webdb.service.native.spec.ts`, and
`components/group-info/group-info.component.spec.ts` under `web/src/app/`
(the first four are under `services/`). Run selected specs with
`npm test --prefix web -- --watch=false --include='<spec path>'`.

Still unverified: mounted Bob/Charlie browser regression, native Profile behavior,
concurrent Profile/role/leave/new-join operations, and remote-home Profile changes
in foreign-authoritative groups. The current backend propagation covers local
users in locally authoritative groups only.

## Android Validation Status

No Android device E2E PASS evidence was found in the consolidated run records.
The browser results above remain browser-only; native-routing unit tests are
not Android acceptance results. The historical filename of this log is retained
so existing links and tooling continue to work.

| Android scope | Status | Resume action |
| --- | --- | --- |
| APK/device/WebView/lab connection (11.1) | Pending | Record installed build and device details; confirm app node and account |
| Shared business cases (0–10, Additional A–I) | Pending on Android | Reuse case IDs and record Android local/federated results separately |
| Native input, picker and visual behavior (11.2–11.3) | Pending | Manual device checks until native driver observation/actions support the flow |
| Lifecycle, notification and session isolation (11.4–11.5, 11.8) | Pending | Keep independent observer sessions and record foreground/background conditions |
| Profile fix (11.6 / Additional I) | Pending; Web fix does not establish native correctness | Start with mounted roster, then rapid changes and app restart |
| Media/calls (11.7) | Pending | Verify real device permissions and media, not only signaling |

Use the [Android supplement](./browser-e2e-test-plan.md#11-android-platform-supplement)
and [runner capability limits](./cross-platform-ai-e2e.md#current-implementation-limits-2026-09-20).
The adaptive runner currently lacks multi-account orchestration and complete
native observation. These are tooling limitations, not confirmed app defects;
manual validation can continue. Append each Android result with case ID, build,
device/OS/WebView, participant/node, execution method, visible evidence and the
remaining untested scope. Do not replace the browser result with an Android one.

## Remaining Test Queue

Run each applicable case separately for local/federated participants and
Web/Android. The full plan remains authoritative; this priority list does not
remove unlisted cases.

1. **Profile regression and identity media (Additional I):** mounted roster,
   rapid A→B→C, empty name search, pagination race, reopen/reload/reconnect;
   then request/invite cards, P2P, sender history, mention, quote/forward,
   notification and call surfaces. Test personal avatar reset and group avatar
   lifecycle independently. Foreign-authoritative and native paths are pending.
2. **Relationships, membership and roles (2–5):** finish local catch-up,
   federated role mutation, reject/cancel/expire/duplicate invites, applications,
   kick/leave/dissolve and permission/concurrency cuts. Include Diana/Charlie node.
3. **Message/attention and content (5.11, 6–8):** multi-sender ordering,
   duplicate/reconnect behavior, multiple/all/federated mentions and withdrawal
   clearing, report-to-Admin deletion (6.12), direct-forward with a selectable
   existing target, nested quotes/forwards, system lifecycle and access-loss
   cases. Report/delete must be recorded separately from sender withdrawal.
4. **Media and calls (9–10):** images/files/video/gallery, progress/cancel/retry,
   refresh/remote restart, local/federated calls, normal end, reject/timeout/busy,
   permissions and actual audio/video. Fake-media playback does not prove quality.
5. **Search/block/preferences/Admin (1, 5.13, Additional A–D):** complete partial
   search/block checks, pin/mute/notification/preferences and remaining Admin flows.
6. **Visual and platform coverage (Additional H):** desktop/tablet/mobile for
   each major workflow; inspect composer/emoji visibility and native keyboard,
   picker, notification and lifecycle behavior on Android.

## Latest Verification Run

| Area | Result | Evidence |
| --- | --- | --- |
| Browser lab entry points | PASS, 3/3 desktop contexts | `npm run test:browser -- --project=desktop` |
| PostgreSQL backend regression | PASS, 15/15 tests | `npm run test:e2e -- test/current-group-roster.e2e-spec.ts test/group-creation.e2e-spec.ts test/group-meta-mirror-round.e2e-spec.ts` |
| OTA web bundle | Built | `shell-bundle/soms-web-0.1.0-alpha.0.tar.gz`, SHA-256 `708e7930e2db3abc0b73178c425cedcde1a04091928c100b471271c795164ce6` |
| Android APK | Rebuilt and installed | SHA-256 `c45b6798dbd5d34e7a703a045911ecc33e6f1971366a02b6c5eb684731b52dfb` |
| Android recovery configuration | **FAIL: embedded APK error-page button did not navigate; testing stopped at credible bug** | [Android server settings bug](./browser-e2e-bug-android-server-settings-unresponsive.md) |

The final run used the APK embedded frontend: no active `web/active.json` or OTA
bundle was present. The error-page button remained visible and enabled after a
coordinate tap, Enter, and a second tap; no `/config` fields appeared. The
source route exists, and no runtime exception was logged. A prior retained-OTA
run behaved differently, so its asset-selection caveat is recorded separately.
Remaining Android business cases are pending; testing stopped at this bug.

### Android Recovery Re-test Summary

- **Case:** 11.1 / Android connection-error recovery
- **Result:** FAIL, credible bug reproduced; testing stopped
- **Build:** debug APK SHA-256 `c45b6798dbd5d34e7a703a045911ecc33e6f1971366a02b6c5eb684731b52dfb`
- **Device:** Huawei RVL-AL09, Android 9 / SDK 28, WebView 126.0.6478.188
- **Execution:** ADB install, explicit unlock, native activity launch, UI
  hierarchy inspection, two coordinate taps, three-second wait
- **Observed:** `com.soms.client/.MainActivity` remained foreground; the
  WebView still exposed the same enabled `服务器设置` button at
  `[456,1380][821,1491]`; no `/config` form or dialog appeared.
- **Scope status:** Remaining browser matrix and Android business cases remain
  pending; testing is stopped at this credible blocker as requested.

## Environment and Automation Notes

- Historical 502 incidents were caused separately by stopped backends and by
  Caddy using HMR configuration while ports 4200/5180 were stopped. Restarts
  reused the databases; switching the edge to built assets restored HTTP 200.
  A missing installed `pino-http` dependency was also restored during that run.
  These were environment incidents, not product results or current blockers.
- Expired OTPs and a stale Admin credential blocked earlier attempts; later
  authenticated runs superseded those blocks. Use the current Admin credential.
- New-user dialog fields are `#cu-account` and `#cu-name`. New-group controls
  include a visible name input and description textarea; avoid the hidden avatar
  input. Friend search requires Search followed by a separate request dialog.
- SSE can prevent `networkidle`; wait for a specific visible state instead.
  Wait for join confirmation overlays to close before opening a thread.
- Voice recording changes its accessible label while held. The successful run
  kept pointer coordinates across that transition. An earlier locator timeout
  was superseded by playback PASS.
- The emoji panel may dominate accessible text; inspect visible layout before
  classifying off-screen emoji buttons as overflow. Direct-forward needs both a
  source message and an existing selectable conversation target.


## Complete Server-Configuration Flow — 2026-09-20 13:06 UTC

**PASS for the tested flow; earlier failed-tap reports remain unexplained.**
This run used the already-active OTA frontend at the start, not the embedded
frontend. It does not establish that every previous failure was an OTA issue.

- Initial runtime: `main-TFPJDXR5.js`, active version
  `local-ui-20260812-0818`, with unreachable `qifa.io` / `192.168.88.208:3000`.
- Brought the device to the foreground and confirmed document visibility.
  Closed the existing modal and reopened server settings using actual ADB taps.
- Focused/selected the address field via CDP; entered
  `http://127.0.0.1:3101` using Android input, then tapped the submit button.
  No Angular handler or native configuration command was invoked directly.
- Compatibility validation succeeded. The second-server confirmation displayed
  primary `http://alpha.test:7667` and secondary `http://127.0.0.1:3101`.
  Tapped **Save both addresses**.
- The normal flow persisted both addresses, installed the server's OTA bundle,
  and navigated to `/auth/qr`, with a rendered login QR code and expiry timer.
- Final runtime: `main-GO3DQRLS.js`, active version `0.1.0-alpha.0`, SHA-256
  `8b6b1246dae73f6afa2fcb55886911c58dbc8bc362ee9fac3290f9e4baaf3ea3`.
- Force-stopped and relaunched the app; it again reached `/auth/qr` with a
  fresh QR code, confirming the configuration survives a cold start.
- Local screenshots: `.tmp/android-dialog/server-pair-confirm.png` and
  `.tmp/android-dialog/server-config-complete.png`.
- The device is intentionally left configured for the alpha lab. The secondary
  loopback address uses the existing ADB reverse mapping on port 3101.
  Account authentication and subsequent business flows were not performed.
