# Android 1:1 Call Follow-ups

Core audio/video calling was verified on two physical devices on 2026-07-26.
Unit tests and compilation cover the state machine, but the remaining work depends
on Android notification, process, audio, and lifecycle behavior and therefore
requires physical-device evidence.

## Release blockers

### Continuous incoming alert

Verify an incoming call continues to vibrate and ring after the incoming-call UI
moves to the foreground. Earlier testing found that vibration could stop during
that transition and that an Android notification-channel sound might play only
once.

If either problem remains, make ring ownership idempotent across the foreground
service and call UI. There must be exactly one audible loop and one vibration
loop, both stopped by accept, decline, cancel, timeout, or terminal failure.

Acceptance:

- test foreground, background, and locked-screen incoming calls;
- confirm alerting continues until a terminal user or timeout action;
- confirm repeated SSE/recovery events do not start overlapping alert loops;
- confirm silent/vibrate/DND behavior follows Android policy;
- record results on at least the Android 9 Huawei and Android 12 devices used for
  the original stabilization pass.

Relevant code:

- `src-tauri/gen/android/app/src/main/java/com/soms/client/CallRinger.kt`
- `src-tauri/gen/android/app/src/main/java/com/soms/client/CallService.kt`
- `src-tauri/gen/android/app/src/main/java/com/soms/client/CallController.kt`

## Adversarial device matrix

Run and record these cases before declaring native calls release-ready:

- backgrounded callee;
- force-stopped or killed callee woken by FCM;
- caller cancellation before acceptance;
- callee decline;
- peer hang-up from both sides;
- process loss or network loss during negotiation;
- mid-call background to picture-in-picture and return;
- SSE reconnect while connecting and while connected;
- denied camera or microphone permission.

Each case must terminate cleanly, release audio/video/ring resources, and leave
both clients able to place another call. Update the phase checklist in
[Android calls client](../android-calls-client.md) only after a physical-device
pass.

## Pre-release cleanup

Audit native call logging after the device matrix. Keep lifecycle milestones at
`info`; keep renderer, avatar-loading, SDP, ring-entry, and relink diagnostics at
`debug` unless an operator needs them for a documented failure mode.
