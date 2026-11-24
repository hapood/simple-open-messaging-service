# Composer avoidance silhouette

## Goal

When a higher layer requires the chat composer to step aside (dialog, aside pane, media viewer,
fullscreen call, paste panel), the composer slot must not become an empty gap. A static gray
composer silhouette always sits in the composer slot, beneath the real composer. The composer
slides down and fades out to reveal it, and later slides up and fades in over it. The motion is
identical for the browser composer and the Android native composer.

## Behavior

| Situation | Real composer | Silhouette |
| --- | --- | --- |
| Normal chat | visible, covering the silhouette | present underneath |
| Composer avoided (see below) | slides down and fades out | revealed (no animation) |
| Avoidance ends | slides up and fades in | covered (no animation) |
| Multi-select mode | hidden | not rendered (the selection bar owns the slot) |
| Blocked / read-only / quota paused / friendship ended | none | not rendered (the banner or empty slot owns it) |

The silhouette is rendered when `composerPlaceholderVisible()` is true, which is
`composerBinding() && !selectionMode()` in
[friend-message.component.ts](../../web/src/app/components/message-thread/friend-message.component.ts).
It has no show/hide transition of its own. Because it is always underneath, the asynchronous
native re-show needs no hand-off protocol: until the native view begins drawing, the silhouette
fills the slot.

"Avoided" is the `composerAvoided` computed in the same component:

- Browser composer: any routed dialog, or `nativeComposerOccluded()`. It drives the
  `msg-composer--dialog-hidden` class.
- Android native composer: the existing `shouldShow` effect hides the composer for a chatbox
  dialog of this thread, `nativeComposerOccluded()`, or selection mode.

## Visual specification

- Geometry: `position: absolute; inset-inline: 0; bottom: 0`, the same as `app-chat-input`.
  Height is `--soms-composer-height + --soms-safe-bottom`, which is the real composer height:
  - Browser: `ComposerGeometryService` keeps measuring the mounted (transparent) composer.
  - Native: `NativeComposerService.hideActive()` rejects the zero-height geometry emitted on hide,
    so the last real measurement, including multi-line drafts and quotes, is kept.
- It applies the same keyboard-lift transform as `.ci-input-bar`.
- Layering: `z-index: 3`, below the browser composer (`4`). The native composer is a view above
  the WebView. The silhouette is `aria-hidden` and has `pointer-events: none`.
- Look: composer bar background and top border, a rounded gray input capsule that fills the
  height, and a 48px gray circular send button. The fill is the
  `--im-composer-placeholder-fill` token.
- It is never measured, so it does not affect `--soms-composer-height`, the content bottom
  reserve, or the virtual-scroll height model. All box values are integer pixels.

## Motion

Only the real composer animates. Hiding goes to opacity 0 with a downward offset; showing starts
from that state and returns to opacity 1 with no offset.

| Side | Duration | Offset | Easing |
| --- | --- | --- | --- |
| Browser composer | `--im-composer-fade-duration` = 140ms | `--im-composer-slide-offset` = 12px | `--app-ease-standard` = `cubic-bezier(0.2, 0, 0, 1)` |
| Android native composer | `COMPOSER_FADE_DURATION_MS` = 140 | `COMPOSER_SLIDE_OFFSET_DP` = 12 | `PathInterpolator(0.2, 0, 0, 1)` |

The constants must change together. Each source states this requirement.

On Android, `show()` keeps the view `INVISIBLE` at the offset until Angular publishes bounds,
then animates in. The silhouette covers the slot in the meantime.

## Tests

The silhouette rule is a single computed expression and the motion is CSS and native animation,
so verification is manual:

- Browser: open a chatbox dialog, a global dialog and an aside pane. The composer slides down and
  fades to reveal the silhouette, then returns over it. The silhouette never animates.
- Android: open a peer profile, a gallery and a chatbox dialog, then close each. The behavior is
  the same as in the browser, with no empty frame while the native composer re-appears.
- With a multi-line draft or a quote, the silhouette matches the composer's height.
- Selection mode and banner states show no silhouette.
- Regression: the tail reserve and scroll position do not change when a dialog opens or closes.
