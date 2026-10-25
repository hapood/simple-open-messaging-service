# Native call ownership

The shared Rust [call model](../../src-tauri/src/call/model.rs) owns call admission,
lifecycle transitions, offer identities, signaling deduplication, retries, timers,
and audio-to-video upgrade decisions. Its reducer emits explicit effects and does
not perform I/O. The [runtime](../../src-tauri/src/call/runtime.rs) serializes these
decisions while running HTTP and timers asynchronously, so a stalled signaling
request cannot delay a local hangup.

Each call captures the existing immutable login owner, credential, endpoint
candidates, and a call lease. Media commands also carry a peer revision. SDK
results must return their original lease and peer revision. Completed offer
rounds are retained for answer deduplication. Timer tickets reject callbacks that
were already queued when a timer was replaced. Login cancellation closes network
work and releases the original media resources without adopting successor
credentials.

Outgoing signals use a FIFO lane. A transport retry repeats the exact signal ID
and body. GET signaling recovery is replay-safe; call initiation and acceptance
are never automatically replayed. Terminal reporting uses the captured login
after local release. If a cancelled outgoing initiation later succeeds, Rust
cancels that specific server call without reviving local state.

The Android [JNI adapter](../../src-tauri/src/call/android.rs) transports commands
and facts. [CallController](../../src-tauri/gen/android/app/src/main/java/com/soms/client/CallController.kt)
owns PeerConnection, tracks, camera resources, SDP application, and platform
presentation. Its immutable snapshot is a mirror of Rust state. SDP media
inspection associates native ICE callbacks with their actual WebRTC credentials;
it does not decide call lifecycle or schedule signaling. CallService renders
notifications, manages audio focus and foreground-service resources, and checks
Rust admission again when delayed OS intents arrive.

There is one implementation of call policy. No Kotlin state machine, signaling
HTTP client, business timer, or fallback implementation remains. The existing
`/api/v1/calls/*`, `CALL_EVENT`, and `CALL_SIGNAL` contracts are unchanged. This
migration introduces no SQLite tables, schema changes, or migrations.

Reducer tests cover lifecycle and negotiation policy. Runtime tests use local
HTTP servers to verify immediate local hangup, cleanup of late initiation
success, and cancellation on logout. JVM tests cover SDK resource fences and
media SDP/ICE inspection. Device validation must additionally exercise audio and
video calls, callee-first video upgrades, Wi-Fi/cellular handoff, notification
answer/hangup, renderer recreation, and logout during negotiation.
