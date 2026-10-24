# Two-node Web main-workflow acceptance

## Scope and ownership

This is the independent execution checklist for the **quick/main-workflow** mode
of `npm run pi:webtest`. It requires exactly two authorized SOMS deployments,
aliased Alpha and Bravo, not the fixed local lab addresses. Full acceptance uses
three nodes and [the full inventory](browser-e2e-test-plan.md).

This plan owns the quick execution scope and order, not a second set of product
contracts. The full inventory owns expected behavior, permission boundaries,
identity semantics and cross-cutting result rules. Refer to its relevant sections
when expanding each checklist. If the product contract is ambiguous, pause rather
than inventing an expectation. A quick PASS never substitutes for full acceptance.

Results live only in each local run directory. The Skill controls execution and
the Pi extension persists progress, issues and operator decisions. Do not add a
shared progress dashboard or retained-session history to this plan.

## Environment and fixtures

- Exactly two distinct node identities, Web origins and Admin origins. Collect
  each backend service URL independently; it may differ from the browser origin.
- Confirm actual federation identity domains, not just Web hostnames. Record
  server/API versions and verify authorized test environments before mutations.
- Create at least two dedicated users on **each** node, all with a unique run
  prefix: A1/A2 on Alpha, B1/B2 on Bravo. Use isolated browser contexts and verify
  identity through the UI. Never disable/delete or change existing users.
- Run local relationships, groups and messaging on both Alpha and Bravo; run
  federated actions in both directions, including groups owned on each node.
- Default viewport: desktop 1440 × 1000. Record a different viewport explicitly;
  full mobile/tablet and native Android matrices are not quick coverage.
- Build small synthetic image/audio/video/text/binary fixtures with known names,
  byte counts and hashes. No personal files. Record unsupported UI capabilities
  as gaps, never replace them with API-only PASS results.

## Case expansion and execution order

Before mutations, expand these matrices into stable assertion-sized IDs such as
`Q1.local-alpha.accept` or `Q5.personal.federated.live`. Record every planned item
as NOT RUN. Header placeholders cannot earn PASS from a subset of their children.
Record each result as it completes; do not wait until the end to write progress.

### Q0 — Preflight, Admin and user setup

References: full plan 0, 1.1–1.3; cookie/session isolation and harness self-check.

- Check Web and Admin reachability and both edge/service compatibility endpoints
  for each node. Verify TLS and exact configured origins; record server/API versions.
- Log into both Admin consoles (username defaults to `admin`). Confirm node/domain
  identity and create the four fixtures through the visible UI.
- Issue fresh OTPs and log each user into its own context. Verify the displayed
  account/domain and authenticated shell. No screenshot/trace of passwords or OTPs.
- Check console and failed network requests. An HTML 200 is not backend health.

### Q1 — Friendship lifecycle

References: full plan 2, 3 and relationship-cut rules.

For Alpha-local, Bravo-local, Alpha → Bravo and Bravo → Alpha:

- Search and verify exact account/domain; send a request, receive and accept it.
- Reject a request, cancel a pending request, and reapply. Confirm decision state
  at both participants and refresh snapshot lists when the contract requires it.
- Confirm one conversation/relationship, both-direction message delivery and
  identity labels; check duplicate request handling and cancellation of dialogs.
- Delete friendship from each side, verify composer/permissions and retained
  history according to contract, then re-add and send again without duplication.

Schedule destructive relationship checks after dependent message/avatar checks,
or create separate fixtures and document those dependencies.

### Q2 — Group membership lifecycle

References: full plan 4, 5, membership transition and group-role matrices.

For local groups on each node and mixed groups owned on each node:

- Create a group; verify owner, name, optional description and avatar controls.
- Invite and accept; separately exercise exposed search/application/join approval.
- Confirm every participant sees roster, roles, identity domains and the same group.
- Leave, verify removed-member access/composer and remaining-member roster, then
  rejoin through an exposed authorized path. Check live update and reload state.
- Check a basic owner/member permission contrast; do not infer full role coverage.

### Q3 — Group and message preferences

References: full plan 4.5, 5, 12 and additional conversation/group preferences.

- Change name, description and group avatar for local/mixed groups; verify all
  relevant participants and the contract's live-versus-refresh behavior.
- Publish/edit the exposed group announcement; verify visibility and read state.
- Change exposed message notification/mute settings and conversation preferences;
  verify persistence after reload and isolation from another user/group.
- Exercise exposed invite/join restrictions as owner versus ordinary member.
  Clearly name each setting tested; do not claim all settings from one toggle.

### Q4 — Message, media and file matrix

References: full plan 6, 7, 9; additional message semantics and media matrices.

Expand **local direct messages on both nodes**, **federated direct messages in
both directions**, **local groups on both nodes**, and **mixed groups owned on
each node**, across every supported type:

- Text, multiline text and emoji; image, audio, video; text and binary files.
- UI send/upload progress and completion; peer-visible exact-once receipt,
  correct sender/domain, ordering and basic unread/read behavior.
- Image preview, audio/video playback with bounded observable assertions, file
  name/size and download byte/hash comparison to the synthetic source.
- Quote/reply, direct forward, merged forward when exposed, withdrawal and peer
  projection. Record unsupported type/action combinations explicitly.
- Verify failed upload/send handling only with a bounded, authorized preparation;
  do not shut down a shared deployment or alter network infrastructure implicitly.

Fake media devices verify deterministic browser workflows, not hardware quality.

### Q5 — Personal and group avatar matrix

References: full plan 7.14 and I.1–I.4, including profile revision and refresh rules.

Use visibly different synthetic fixtures for first upload and replacement. Assert
resolved identity/image changes rather than merely observing a successful upload.

Personal avatars, locally on both nodes and federated in both directions:

- First upload and replacement before friendship, after friendship and while
  users share a group. Check self profile, peer profile, friend/conversation list,
  chat header, member list, new message and exposed sender card.
- Check peers after friendship deletion and group leave without leaking access;
  then re-add/rejoin and verify the correct current identity.
- Compare pre-existing messages, new messages, quotes and forwarded identity
  cards against the full plan's live-versus-historical revision contract.
- Check online live projection, explicit list refresh, whole-page reload,
  re-login and peer offline catch-up as separate assertions. Re-login requires
  a new OTP and authentication must not be traced.
- Exercise reset/remove only if the UI exposes it; absent controls are NOT UI PASS.

Group avatars for local and mixed groups owned on each node:

- Initial selection, replacement and exposed removal as owner; check header,
  conversation list, group details, member views and relevant invite/search cards.
- Check ordinary-member permission restrictions and former-member visibility.
- Check live, refresh, reload and rejoin projections; compare old forwarded cards
  using the specified snapshot contract, not an assumed latest-avatar rule.

### Q6 — Recovery, cleanup and summary

References: full plan recovery rules and cleanup/data safety.

- Reload authenticated contexts; verify exact identity, relationship/group state,
  retained history, media access and no duplicate messages or conversations.
- Test bounded browser offline/online catch-up without restarting shared services;
  verify peer messages and latest allowed profile/group state after reconnect.
- Remove only this run's authorized fixtures through supported UI where safe.
  If removal is unavailable or would destroy needed evidence, report residuals
  and ask the operator rather than directly deleting database rows.
- Close contexts; record remaining fixture IDs, profiles, cleanup and next actions
  in the run handoff. Finish only after every item has an outcome or explained gap.

## Pauses and completion

A driver failure immediately pauses browser mutations. Capture safe diagnostics,
classify PRODUCT_BUG, DRIVER_MISMATCH or ENVIRONMENT, and write the reproduction,
expected/actual and evidence through `webtest_run pause`. For a proposed repair,
name exact files/behavior and verification. Ask before changing drivers, selectors,
helper contracts or product source; do not silently repair and continue.

The operator may retry, skip, stop, or authorize that one repair. Cancellation
keeps the run paused. Repair does not authorize resuming: run focused checks and
request retry approval, then rerun the failed assertion. Preserve defects and
coverage gaps even when continuing. See [Pi tooling](../../tools/pi-web-testing/README.md).

A final PASS means **two-node Web main workflows, exact recorded matrix only**.
If any required combination remains unverified, report BUG or BLOCKED/NOT VERIFIED
with the completed subset. Full concurrency/expiry cuts, third-node interactions,
all visual viewports, comprehensive admin/security cases and full call coverage
are outside quick scope and remain owned by full acceptance.
