# Shared Rust runtime and native platform adapters

## Accepted direction

Every native client uses one shared Rust core for business rules and
cross-platform runtime orchestration. Kotlin, Swift, and other native host code
report OS facts and execute explicit platform commands. The browser and NestJS
backend are separate hosts; this decision does not change backend ownership.

This is a target architecture, not a claim that every legacy Android capability
has already migrated. The first implementation slice is realtime convergence;
call-policy and remaining notification-policy cleanup must follow the same rule,
not become permanent platform exceptions.

## Realtime ownership

Rust owns connection admission, origin selection, the SSE protocol, reconnect
policy, HELLO cache/replay, feed and receipt lanes, notification projection,
account epochs, runtime-instance generations, and asynchronous cancellation.
The existing desktop supervisor is the reuse starting point, not a separately
maintained Android loop. A sink boundary carries typed commands to each host.

Android owns foreground-service anchoring, ConnectivityManager registration,
permissions, keystore persistence, notification rendering, WebView presentation,
and native media APIs. It does not own a socket, retry executor, protocol cache,
or feed scheduler. Android's `NativeEventTransport` remains the renderer adapter;
headless operation must not require a Tauri AppHandle or attached WebView.

## Safety contracts

- Start returns a runtime-instance lease. Stop, network observations, retry and
  forced reconnect target that lease. An obsolete adapter cannot stop or mutate
  its successor, even if an OS callback was already queued before unregistration.
- Stop invalidates publication authority synchronously and signals cancellation;
  it does not join a worker or hold a lifecycle lock across network, database or
  platform operations.
- Rust checks cancellation, instance generation and account epoch at asynchronous
  commit/publication boundaries. Dropping an in-flight network future is normal
  termination, not an uncaught worker-thread interruption.
- Native adapters revalidate queued presentation commands before executing them.
  Notification rendering revalidates after expensive platform preparation, not
  merely when the batch first arrives.
- Credentials remain in native secure storage and Rust memory; no credential is
  included in runtime events or diagnostic artifacts.
- Origin mode is mirrored to native persistence without feeding the same decision
  back through JavaScript to Rust. API and SSE use the same Rust authority.
- JNI callbacks use kept method signatures and instance-bound references. Native
  exceptions cannot silently terminate the shared supervisor or expose secrets.

## Session-owned call resources

Ending or replacing an authenticated session ends that session's call and native
media resources. Restoring the same token or recreating a WebView does not end a
call. Session invalidation must not leave a live microphone behind notification
buttons that can no longer pass the session/origin check.

The Android secure-storage transition currently connects this rule to the legacy
call SDK owner. It closes SDK work admission before changing credentials,
invalidates queued old work, cancels the registered HTTP request outside the
credential monitor, and releases media on the existing serialized SDK executor.
Cancellation targets the captured request, not all requests a later session might
have started. Cleanup checks its captured call owner and sends no REST request.
New SDK work waits for that resource release; normal incoming presentation must
not wait behind unrelated call signaling requests.

This resource-execution fence does not migrate the legacy call state machine or
introduce a new signaling delivery lane. Call business policy remains migration
debt under the shared Rust ownership rule above.

## Migration slices and gates

1. Extract the desktop Rust supervisor behind a platform-neutral sink. Preserve
   desktop command/event shapes, parser, HELLO merge and feed behavior; add
   generation/cancellation regression tests.
2. Connect Android's already available headless Rust runtime through JNI. Add
   Android event, identity, notification and explicit call-recovery commands.
3. Replace Kotlin realtime orchestration with its platform adapter. Remove the
   Kotlin origin selector, HELLO merger and temporary executor workaround.
   Remove the obsolete JavaScript-mediated origin feedback loop.
4. Verify both platform regressions and physical Android cold start, retained
   HELLO replay, logout/re-login, account switch, connectivity changes, background
   notification and call-frame delivery. Record each exact scope separately.

The call SDK remains a platform facility, but call decisions/state machines are
not exempt from Rust ownership. Similarly, legacy notification alert policy or
foreground suppression in host code is migration debt, not the pattern to copy
for another native client.

## Verification gates

Keep the Angular DI-cycle responsibility split and production-provider graph
regressions. Verify adapter leases with a fake backend, and shared-runtime
cancellation/generation behavior with Rust tests. An integrated Android build
must check JNI signatures as well as compilation. Physical-device acceptance
must prove the installed artifact's cold start, session restoration and
same-process logout/re-login; unit tests cannot establish those outcomes.
Desktop event/transport parity is a separate regression gate. Current execution
results belong in the owning development progress and handoff records.
