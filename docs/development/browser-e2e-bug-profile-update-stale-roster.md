# BUG: Profile Update Does Not Refresh Existing Group Roster Surfaces

## Status

**Candidate fix revised on 2026-09-20. Targeted automated checks passed; browser regression remains pending.**

## Summary

Alice successfully changed her personal display name and avatar through the Web
profile editor. The account profile revision advanced, but existing group
roster entries continued to reference the old profile revision. Bob's browser
continued to show Alice's old name in the group member roster instead of the
new profile.

## Environment

- Browser: Chrome driven by Playwright, independent contexts.
- Alpha Web: `http://localhost:3101/`.
- Bravo Web: `http://localhost:3102/`.
- Local account: `alicemu8azkcm@local`.
- Observers: Bob Alpha and Charlie Bravo.
- Group thread: Alpha-authoritative `PW-FINAL-1789833263100`.

## Reproduction Steps

1. Log Alice into the Alpha Web edge through an Admin-issued OTP.
2. Open the profile editor from the visible `编辑个人资料` control.
3. Select a valid PNG through the visible avatar picker and finish the crop
   editor.
4. Change the display name from its current value to `Alice Profile B` and
   save. Repeat once with `Alice Profile C`.
5. In Bob's independent Alpha browser, open the existing group and inspect
   `成员管理`.
6. Inspect the same group in Charlie's independent Bravo browser after the
   federated Group Meta projection settles.

## Expected Result

The latest profile revision and avatar should appear in existing group roster,
message sender, mention candidate, invite/application, quote/forward, and
notification surfaces. Local and federated observers should retain the correct
account/domain identity.

## Actual Result

The profile update API returned success and Alice's account advanced to
`defaultProfileRev=3` with the new avatar. However, the existing group roster
still contained Alice's `profileRev=1` fact and Bob's browser continued to show
`alicemu8azkcm Test`. The current `GroupMetaMemberFeed` rows for the group did
not receive a new Alice profile revision fact.

Observed authoritative rows:

```text
Account alicemu8azkcm defaultProfileRev = 3
GroupMetaMemberFeed Alice role=ADMIN profileRev = 1
```

The same stale revision is therefore available to local IndexedDB roster
materialization and federated mirror projection.

## Impact

- Existing local group members see stale display names and avatars.
- Existing federated group members can see stale profile evidence after S2S
  synchronization.
- Invitation, roster, mention, quote/forward, notification, and message sender
  surfaces can disagree about the same user.
- The immutable account/domain identity is not lost, but the visible profile
  revision is stale.

## Original Backend Root Cause

Before the fix, `UserService.updateProfile()` created the new personal profile snapshot and
advanced `Account.defaultProfileRev`, but did not reconcile the existing group
membership meta projection for groups containing that account. Group Meta roster
facts therefore remained at the join-time profile revision.

The first required fix is to update local authoritative group projections and
publish the corresponding federated/profile-resolution events without changing
membership roles or creating duplicate roster rows. A candidate backend change
was added during the investigation and the Alpha database later showed Alice's
roster fact at `profileRev=4`. That diagnostic candidate has since been replaced
by the atomic transaction implementation described below; the old browser
evidence does not establish a PASS for the revised implementation.

## Second Browser-Side Finding

After the backend candidate propagation, browser evidence showed the following
sequence:

1. The browser received Group Meta through `12`, including Alice's
   `UPSERT` with `profileRev=4`.
2. The browser requested `/user/profile-resolution` for Alice revision 4 and
   received `Alice Profile D` plus the new avatar bytes with HTTP 200.
3. IndexedDB contained both the member reference and the immutable profile
   snapshot for revision 4 in the diagnostic context.
4. The already rendered `成员管理` panel continued to display the old
   `alicemu8azkcm Test` label.

This identifies a separate client invalidation gap: Group Meta changes notify
`MemberProfileRepository.changed$`, but completion of the asynchronous
`profileWake$`/profile-resolution path does not reliably notify the mounted
roster panel to re-query its `members` store. The UI can therefore remain stale
even after the new profile revision is present locally. An initial client patch
was removed at the investigation pause. The revised implementation and completed automated checks are recorded below; browser
verification of that revision remains pending.

## Evidence

- `/tmp/soms-browser-e2e/bob-profile-update.png`
- `/tmp/soms-browser-e2e/charlie-federated-group-message.png`
- Alpha database inspection showed `defaultProfileRev=3` while the group roster
  fact remained at `profileRev=1`.

## Verification Plan

The September 20 implementation is ready for browser review, but the running
lab has not been confirmed to serve it. Build/serve the current Web bundle and
restart the lab backends without resetting the retained databases first.
Bob is now OWNER, Alice ADMIN, and Charlie MEMBER in the retained group.

- Open Bob's member-management panel before Alice saves a new name and avatar.
  Keep it mounted and require visible convergence without refresh or reopening.
- Observe Charlie's Bravo roster/header in an independent context; preserve
  Alice's Alpha identity/domain. Normal members may not have management access.
- Exercise both resolution paths where the environment permits: immediate HTTP
  READY, and HTTP PENDING followed by PROFILE_AVAILABLE and an EXACT fetch.
  Both Web paths converge on IndexedDB commit and one availability event per
  newly inserted snapshot. If PENDING cannot be reproduced, record it as pending.
- Confirm identical cached reads/repeated resolution do not create additional
  successful-update events, and an aborted commit does not notify. These are
  supporting diagnostics; browser PASS still requires the visible UI result.
- Repeat A → B → C rapidly, with name search (including an initially empty
  result) and pagination in flight. Old query results must not restore stale rows.
- Repeat after reopening, reload, SSE reconnect and a fresh login; check both
  name and actual rendered avatar, not only a successful HTTP response.
- Extend to sender/history, mention popup, pending invitation/request cards,
  quote/forward and other Additional I surfaces. Record each surface separately.
- Keep remote-home users in foreign-authoritative groups and native clients as
  separate pending scope. Add PostgreSQL concurrent role/leave/new-join tests;
  current sequential tests do not establish those races are correct.

Record build identity, participant/platform, visible before/after results,
console/network failures and screenshot paths in the
[progress document](./browser-e2e-progress.md). Do not mark the entire matrix
PASS from the Bob roster case alone.

## 2026-09-20 Implementation Review

The original evidence is consistent with two client gaps: immediate READY
responses were committed without a worker wake, and the member repository did
not subscribe to profile availability. The service-event handler had its own
post-commit wake, so adding another wake to every READY return would duplicate
notifications. The revised Web path uses one successful-update emitter in
`WebdbStorage.commitResolvedProfile`, after transaction commit and only when a
new immutable snapshot was inserted. The worker forwards that event. Neither
its service-event handler nor the main-thread READY return emits another wake.
Cached reads, repeated identical commits, and aborted commits do not emit an
update. Native SQLite SSE retains its existing platform adapter; this does not
claim a native notification redesign or native end-to-end verification.

`MemberProfileRepository` invalidates queried rosters on availability, including
empty name-search results, and clears its tracked threads on session end.
`GroupInfoComponent` discards superseded first-page and pagination results.

The backend candidate was moved out of the controller into the profile update
transaction. Group-owned propagation acquires parent scopes in canonical order,
re-reads membership under the group lock, preserves the current role, skips
departed members and older revisions, and queues durable fanout atomically.
This covers local users in locally authoritative groups. Remote-home profile
updates into foreign-authoritative groups and concurrent new joins still need
separate protocol/concurrency verification.

Validation completed before the notification refinement: backend build and the
current-roster/system-account PostgreSQL suites (4 tests) passed. These tests
cover revision advancement, non-regression, departed-member exclusion, and
system-account behavior; they do not prove the full concurrency matrix.

After the notification refinement, the Web development build and 26 repository/
storage tests passed. They verify notification visibility after commit, no
repeat notification for identical writes or cached READY responses, and no
notification on an aborted conflicting write. Browser regression remains
pending; no lab backend restart was performed in this follow-up.

The two member-panel query-ordering tests also passed (28 Web tests total).
