# 1:1 Calls Release Checklist

Run the matrix on Web ↔ Web and Web ↔ Android. Repeat audio and video where applicable.

## Core lifecycle

- Start, ring, accept, connect, mute/unmute, and hang up from either side.
- Cancel before accept; decline from the callee; let an unanswered call time out.
- Upgrade an established audio call to video from either side.
- Turn each camera off/on and switch cameras without interrupting audio.
- Answer on one device while the same account rings on another; only the accepting device enters the call.

## Recovery and cleanup

- Interrupt the network briefly; verify “Reconnecting…” and automatic recovery.
- Keep the network unavailable past the recovery window; verify both sides exit and devices are released.
- Deny microphone/camera permission and retry after granting it.
- Disconnect a camera during video; verify audio remains and the peer sees the camera-off state.
- Disconnect the microphone; verify the failed call ends.
- Refresh/close the Web page and log out during a call; verify media indicators turn off and the peer exits.

## Visual and accessibility

- Before the first remote video frame, verify the avatar placeholder is shown instead of black video.
- Verify camera-off, waiting-for-video, connecting, and reconnecting labels match the actual state.
- In connected video, wait for controls to hide, tap to reveal them, then use every control.
- Check narrow mobile, tablet, desktop, landscape, window resize, display cutout, and bottom gesture inset.
- Keyboard through Web controls; verify visible focus and meaningful labels/pressed states.
