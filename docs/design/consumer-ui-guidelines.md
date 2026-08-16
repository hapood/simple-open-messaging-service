# Consumer UI Guidelines

These guidelines capture the durable decisions from the 2026 consumer UI
redesign. The implementation in `web/` is authoritative when this summary and
the application differ.

## Product and platform priorities

SOMS should present user tasks rather than its transport and deployment
internals. Finding a conversation, reading and sending messages, recovering from
failure, and managing contacts should remain more prominent than diagnostics or
protocol terminology.

Android Tauri is the first device-validation target. Desktop Tauri, desktop web,
and mobile web use the same product model with layouts adapted to available
space. Platform-specific capability differences may change presentation but not
the meaning of state or actions.

## Interaction baseline

- Give each screen a clear title and primary action.
- Keep frequent actions visible and progressively disclose advanced or dangerous
  actions.
- Represent loading, empty, error, ready, offline, disabled, and permission-denied
  states explicitly. Blank space is not a loading state.
- Place recoverable feedback near the action that failed and offer retry or a
  clear recovery path.
- Do not expose SSE, FCM, WebView, federation, or similar implementation terms in
  ordinary user-facing copy.
- Preserve the user's context across navigation, reconnects, keyboard changes,
  and failed sends.

## Visual system

Use the semantic tokens in `web/src/app/assets/_tokens.scss`. Shared surfaces and
components use `--app-*`; chat-domain presentation may use `--im-*`. Components
should not introduce unexplained colors, shadows, radii, font sizes, or motion
durations. Hard-coded values are acceptable only for intrinsic media geometry,
platform workarounds, or documented one-off assets.

Color must not be the only carrier of state. Light and dark themes must preserve
the same hierarchy and interaction meaning. Prefer content hierarchy and spacing
over decorative surfaces.

## Responsive and accessible behavior

- Compact layouts prioritize a single active task; wider layouts may keep
  navigation, conversation list, and content visible together.
- Preserve the selected conversation and logical focus when layout modes change.
- Account for Android safe areas, the software keyboard, dynamic viewport height,
  and system back behavior on real devices.
- Core flows must work with touch, mouse, and keyboard. Interactive elements need
  visible focus, adequate target size, an accessible name, and non-color state
  cues.
- Respect `prefers-reduced-motion`; removing animation must not remove state
  feedback.
- All product copy belongs in the localization catalogs. Check both English and
  Chinese because length and composition behavior differ.

## Change verification

For a meaningful UI change, test the affected states rather than only the happy
path:

1. loading, empty, populated, error, offline, and retry behavior;
2. compact mobile and expanded desktop layouts, plus any affected transition;
3. light and dark themes;
4. English and Chinese copy, including long names and composition input;
5. keyboard navigation, visible focus, and reduced motion;
6. Android safe area, software keyboard, system back, rotation, and relevant
   permissions when native behavior is involved;
7. failed-send and reconnect recovery when messaging state is involved.

Run the focused Angular tests and the production web build. Use real-device checks
for keyboard, permission, notification, call, camera, and native-overlay behavior;
browser emulation is not sufficient evidence for those paths.
