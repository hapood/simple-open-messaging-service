# Native launch presentation

## Host coverage

macOS now creates its primary OS window and installs an AppKit launch layer before
opening client storage or constructing WebKit. Android retains its existing native
Activity launch presentation. Windows and Linux still use their existing startup
path; their native presentation adapters are not implemented by this change.

The macOS artwork, light/dark palette, 288-point logo canvas, 24-point lift,
320 ms logo movement, 100 ms delayed 220 ms brand reveal, and 180 ms dismissal
follow the Android launch presentation. Reduce Motion disables these animations.
The first frame follows the system theme; the database-resolved application theme
then recolors the existing layer without recreating it.

## Ownership and readiness

- [Rust launch owner](../src-tauri/src/launch/mod.rs) owns the launch identity,
  readiness, slow-start notice and closed/completed guards. Timeout only changes
  the status; it never reveals an unready renderer. Completion or window destruction
  cancels the outstanding slow-start task.
- [AppKit adapter](../src-tauri/src/launch/macos.m) draws and animates an overlay
  retained by the primary window. There is no second browser or splash window.
  It does not read preferences, restore sessions or decide when to dismiss.
- [Renderer bridge](../web/src/app/services/native-launch.ts) reports presentation
  facts using the Rust-injected launch identity. The root component waits for the
  first completed route, login configuration when relevant, Angular stability and
  two rendering opportunities before reporting ready. First-run `/config` does not
  request remote login configuration.
- Storage initialization runs off the macOS event thread. Attaching the sole child
  WebView and restoring overlay stacking occur in the same main-thread callback.
  Native calls are never made while holding the launch-state mutex.

Do not force AppKit drawing or flush Core Animation transactions from Tauri's
setup callback: drawing can re-enter Tao while its event-handler lock is held.
Return to the OS event loop to render the prepared native layer instead.

The macOS dependency pins Tauri 2.12.5 because creating a native-only window and
attaching its child WebView currently requires Tauri's `unstable` feature. Recheck
this integration when upgrading Tauri.

A bootstrap failure leaves an explanatory native status and a working window
close action rather than exposing a blank page. An indefinitely blocked external
operation, such as a Keychain permission prompt, remains covered; it is not treated
as successful renderer readiness.

## Focused validation

```sh
npm run test:native-contracts
cargo test --manifest-path src-tauri/Cargo.toml --lib launch::tests
npm --prefix web test -- \
  --include 'src/app/services/native-launch.spec.ts' \
  --include 'src/app/services/theme-bootstrap.spec.ts' \
  --include 'src/app/app.component.spec.ts'
```

The standalone macOS test does not open application databases, use Keychain or
contact a backend. It tests native layering, resize, theme updates, animation
cleanup and a real WKWebView whose JavaScript thread is deliberately blocked:

```sh
clang -fobjc-arc -fblocks -framework AppKit -framework QuartzCore -framework WebKit \
  src-tauri/src/launch/macos_test.m -o /tmp/soms-launch-presentation-test
/tmp/soms-launch-presentation-test /tmp/soms-launch-preview.png
```

For manual packaged-client validation, cold-launch both signed-in and first-run
states, check both themes and Reduce Motion, resize during launch, and close while
storage or the renderer is still loading. A normal first frame must contain native
artwork; no wall-clock deadline may reveal the WebView before it reports readiness.
