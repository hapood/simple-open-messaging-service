# Cross-platform AI E2E runner

The cross-platform E2E plan is the single business-test source. The adaptive runner reads its numbered natural-language
cases and executes the selected case against either a real browser or the Android Tauri application. Do not duplicate
business steps or expected results in this runner document or in driver code:

```bash
# Browser only (the runner defaults to both platforms)
CROSS_PLATFORM_PLATFORM=browser \
AI_TEST_API_KEY=... \
AI_TEST_CASE=0.1 \
npm run test:cross-platform

# Android emulator or device through Appium UiAutomator2
AI_TEST_API_KEY=... \
CROSS_PLATFORM_PLATFORM=android \
AI_TEST_CASE=0.1 \
npm run test:cross-platform
```

## Architecture

The runner has four deliberately separate layers:

- The Markdown test plan contains the goal, actions, and expected result in human language.
- `AiAgent` observes the current screen and chooses one action from a restricted action protocol.
- `BrowserDriver` uses Playwright for browser DOM and browser input.
- `AndroidDriver` uses W3C Appium / UiAutomator2. It discovers the WebView context dynamically and can switch to
  `NATIVE_APP` for the Android-native composer, keyboard, picker, or other native surface.

The AI does not receive arbitrary shell, JavaScript, HTTP, or file-system capabilities. It can only select `tap`,
`type`, `press`, `scroll`, `wait`, `switchContext`, or `finish`, and every decision is recorded with the observation.
This is the intended bounded action interface. The implementation limitations below
must be accounted for before accepting a run result.

## Authoring contract

- Add or change business coverage in the plan for the target platform:
  `browser-e2e-test-plan.md` for browser, `android-e2e-test-plan.md` for
  Android.
- Give every independently runnable item a globally unique bold numeric id such as `6.1` or `6.3a`.
- Describe user intent and visible expected behavior. Do not put CSS selectors, Android coordinates, or view hierarchy
  assumptions in a business case.
- State platform exceptions in the case.
- Keep credentials and one-time codes out of plans, prompts, screenshots, and artifacts.
- The loader includes indented continuation lines and rejects duplicate numeric ids instead of choosing one silently.

## Android prerequisites

1. Build and install a debug APK for `com.soms.client` using the
   [native build instructions](../../src-tauri/README.md#android-build-primary-client-target).
   Record APK/build identity, Android version, device, and installed WebView version.
2. Start Appium with the UiAutomator2 driver, for example `appium --base-path /`.
3. Connect an unlocked emulator or device with USB debugging enabled.
4. Make sure the app can reach the federation lab edge from the Android device. Run
   `node scripts/android-lab-server.mjs` after each host network change. It
   probes the current host addresses, configures `adb reverse` for ports `3101`
   through `3103` when a device is attached, and prints the server origins to use
   in the Android app. `localhost` inside Android is the device itself; use the
   helper's loopback recommendation only after `adb reverse` succeeds, otherwise
   use the printed LAN address. Configure the node through the app before the
   run: `CROSS_PLATFORM_BROWSER_URL` does not navigate or configure the Android app.
5. Verify that Appium can attach to the app WebView with a compatible driver.
   If no WebView is available, report a tooling block rather than an app failure.
6. Use a dedicated test device/session with the expected account already prepared.
   The driver does not select a device by UDID; multiple connected devices require
   external isolation or a driver enhancement, not an undocumented environment variable.

Useful environment variables:

- `APPIUM_URL`, default `http://127.0.0.1:4723`
- `ANDROID_APP_PACKAGE`, default `com.soms.client`
- `ANDROID_APP_ACTIVITY`, default `.MainActivity`
- `ANDROID_NO_RESET`, defaults to preserving app data; `0` disables this capability.
  Do not use reset behavior to prepare a retained regression fixture.
- `CROSS_PLATFORM_BROWSER_URL`, default `http://localhost:3101/`
- `CROSS_PLATFORM_PLATFORM`, default `both`; also accepts `browser` or `android`
- `CROSS_PLATFORM_SCENARIOS`, default `docs/development/browser-e2e-test-plan.md`;
  Android runs must point it at `docs/development/android-e2e-test-plan.md`
- `AI_TEST_CASE`, exact numeric ID preferred, defaults to `0.1`; exact IDs are
  required when available. A title-substring selector must match exactly one
  case; ambiguous matches are rejected with candidate IDs.
- `AI_TEST_MODEL`, default `gpt-4.1-mini`
- `AI_TEST_MAX_STEPS`, default `24`
- `AI_TEST_ARTIFACT_DIR`, default `/tmp/soms-cross-platform`

If the AI key, browser edge, Appium server, device, or selected case is unavailable, the run is `BLOCKED` with an explicit reason. It must not be reported as a product pass. The final artifact is `result.json` under `AI_TEST_ARTIFACT_DIR`.

## Current Implementation Limits (2026-09-20)

These are source-review findings, not results from an Android device run.
The runner is a partial automation scaffold; the shared acceptance plan is
broader than its implemented execution capabilities.

- `both` starts independent browser and Android runs concurrently. It does not
  connect them as sender/recipient, switch participant accounts, or coordinate
  an Admin OTP handoff. Each platform run has one driver/session. Multi-account
  cases require coordinated manual testing or additional orchestration.
- The browser driver creates a new context; Android uses existing app data by
  default. Do not assume either run has the required signed-in fixture.
- Android context switching exists, but `visibleElements()` always issues a CSS
  query, including in `NATIVE_APP`. Native observation is therefore incomplete.
  Locator strategies are also not fully adapted to WebView/native differences.
  Native keyboard, picker and notification coverage cannot be inferred from
  the existence of `switchContext`.
- Long press/hold, drag/crop gestures, app background/kill/relaunch, notification
  shade operations and coordinated multi-device actions have no dedicated
  runner actions. Perform these manually and record the result separately.
- Case loading does not automatically include global platform rules, fixture
  tables, or all parent-section context with a selected numbered item. Review
  preconditions manually; loading an item does not prepare its prerequisites.
- `finish` carries a structured outcome: `PASS`, `FAIL`, `BUG`, `BLOCKED`, or
  `SKIPPED`. The runner writes these outcomes to `result.json`; `FAIL`, `BUG`,
  and `BLOCKED` return a non-zero exit code. `SKIPPED` is explicit and is not
  converted into a product failure.
- Observations and decisions are written verbatim, with screenshots, and sent
  to the configured AI endpoint; there is no credential redaction. Do not run
  through password/OTP entry or sensitive screens. The browser's fresh-context
  login handoff needs additional support before authenticated automated cases
  can satisfy that requirement. Screenshots are serialized as JSON text rather
  than supplied as image input; automated visual judgment is not established.
- Artifact filenames repeat for the same platform/case/step. Set a distinct
  `AI_TEST_ARTIFACT_DIR` for each run to preserve earlier evidence. Browser
  observations distinguish business HTTP errors, transport failures, and
  console/page errors; normal HMR and favicon cancellations are filtered.
  Android `recentErrors` is not a collected logcat/WebView-console feed; an
  empty list does not prove an error-free run.

Record manual Android results in local run artifacts with the build identity,
using the same business case IDs and Android supplement cases in the
[Android E2E test plan](./android-e2e-test-plan.md). Do not treat a plan or a
removed progress record as evidence of completed acceptance.
