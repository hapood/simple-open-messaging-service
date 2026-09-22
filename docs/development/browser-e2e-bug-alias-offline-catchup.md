# Browser E2E: Alias Offline Catch-Up Does Not Start From Window Network Events

Date: 2026-09-22. Build under test: `a7546edc` with the rebuilt Web client.

## Status

FIXED and verified on 2026-09-22 with the rebuilt browser client.

## Reproduction

Retained Alpha fixtures:

- `block-a`: `blk104850043`, sender profile
- `alias-second`: an independent browser profile for the same account,
  `blk104850043`, receiver profile
- P2P peer: `blk204850043`, conversation `threadId=2`

Observed sequence:

1. Clear the alias and verify both profiles show `添加备注`.
2. Set `alias-second` offline with Playwright's
   `browserContext.setOffline(true)`.
3. Save `Net Catch E2E` from `block-a`.
4. Confirm the alias does not appear in the offline receiver.
5. Restore the network with `setOffline(false)` and wait up to 150 seconds.
6. The receiver does not catch up the alias without a reload.
7. A later alias write, after the connection is otherwise active again, does
   arrive live. This shows that alias persistence and normal live delivery are
   working; the missing behavior is the reconnect/catch-up trigger.

The failing run returned:

```json
{
  "onLineWhileOffline": false,
  "leakedWhileOffline": false,
  "recoveredAtMs": null,
  "aliasConvergedAtMs": null,
  "finalHasAlias": false,
  "finalHasDefault": true
}
```

After the fix, the same scenario returned:

```json
{
  "onLineWhileOffline": false,
  "leakedWhileOffline": false,
  "recoveredAtMs": 27,
  "aliasConvergedAtMs": 17045,
  "liveClearMs": 4,
  "finalHasAlias": true,
  "finalHasDefault": false
}
```

The receiver converged to the alias without a page reload. The exact timing
is environment-dependent and is not an acceptance threshold.

The fresh-cache variant is separate and passed: closing `alias-second`, saving
`Offline Catch E2E` from `block-a`, reopening the retained profile, and
observing the alias from server state all succeeded. The evidence screenshot is
`/tmp/soms-browser-e2e/alias-verify-offline-catch-e2e.png`.

## Root cause

`web/src/app/services/sse.worker.ts` listens for `online` and `offline` on the
Dedicated Worker global scope. The browser automation probe showed that
Playwright's network emulation dispatched those events on `window`, but did not
dispatch them inside a Dedicated Worker:

```text
window: offline, online
worker: no offline/online events
```

The worker therefore did not abort its current fetch on the simulated offline
transition and did not wake its reconnect backoff on the simulated online
transition. The client has no main-thread fallback listener that can call the
transport's reconnect path. The worker's 60-second stale-frame watchdog is only
a backstop and did not produce a usable recovery in this run.

This is partly a test-environment limitation because `setOffline()` is not a
physical network transition. It still exposes a portability gap: browser
implementations and WebViews are not required to deliver network status events
to Dedicated Workers consistently. The transport should have a lifecycle-owned
main-thread fallback, or another explicit reconnect signal, while preserving
the worker as the owner of SSE parsing and backoff.

## Evidence and boundaries

- Fresh-cache/server recovery: PASS.
- Independent-profile live save and clear: PASS.
- Offline receiver did not show a phantom alias: PASS.
- Offline catch-up without reload: PASS after fix.
- Failed-save alert and retry: NOT RUN.
- No screenshot was taken during the offline transition; the profile
  screenshot proving the persisted alias is
  `/tmp/soms-browser-e2e/alias-verify-offline-catch-e2e.png`.

Do not claim that this run proves physical-device offline behavior. The fix
adds `network-offline` and `network-online` messages to the main-to-worker
protocol. `WorkerSseTransport` forwards window events and removes its listeners
when the transport stops or the worker fails; the worker reuses its existing
abort and backoff wake paths. The focused Web test and built-client browser
scenario both passed.
