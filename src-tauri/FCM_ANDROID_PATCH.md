# FCM Android native side (reference)

> **Status (2026-07):** `gen/android/` is now **version-controlled** (Tauri's default — only
> `gen/schemas` is gitignored). All patches below are committed in-tree, so they survive a fresh clone
> and **no longer need re-applying** after `tauri android init`. This file is now a *reference* for what
> the native side contains and the invariants that must hold — not a re-apply runbook. The "re-apply"
> guidance below applies only if you deliberately regenerate `gen/android` (e.g. a Tauri major bump).

Historically `gen/` was fully gitignored and `tauri android init` regenerated the Android project on
demand, losing these native-side modifications — hence the original "re-apply" framing. The
browser/backend builds are unaffected by all of the below.

The edits live in four persistent (non-`generated/`) files plus two new Kotlin files. **Never** edit
anything under `gen/android/app/src/main/java/com/soms/client/generated/` or any `tauri.*.gradle.kts`
— they carry `AUTO-GENERATED` headers and are overwritten.

## Prerequisites (per-server Firebase project — DYNAMIC config)

This is a federated / self-hosted app: **each operator runs their own Firebase project.** The APK therefore
ships **WITHOUT `google-services.json`** — there is no per-env json to drop, no SHA-1 to register against
the APK. Instead the operator configures Firebase **server-side**, and the client fetches its config at
runtime:

1. Operator: create a Firebase project. Add an **Android app** with package name `com.soms.client` (matches
   `app/build.gradle.kts` `applicationId` and `src-tauri/tauri.conf.json` `identifier`). **Do NOT register
   SHA-1** — data-only FCM doesn't need it, and skipping it avoids the cross-project "same package+signing"
   conflict (only Google Sign-In / App Check need SHA-1, which this app doesn't use).
2. Operator: place `google-services.json` on the server at `data/google-services.json`, or configure the
   `FIREBASE_CLIENT_CONFIG` environment variable, and restart the backend. It parses and validates the file
   (the Android client must target `com.soms.client`) and publishes the 4 client fields at the public
   `GET /api/v1/shell/compat` response. The admin console (Push → Transport config) is read-only status only —
   the file is not edited there. The APK receives these after resolving its server origin and initializes
   FirebaseApp at process start (see SomsApplication / SomsFirebase).
3. Operator (server-side sending): Project Settings → Service Accounts → "Generate new private key" → set
   `data/firebase-service-account.json`. This is the SEND credential,
   independent of the client config above. Spark (free) tier is ample for chat push volume.

Nothing is baked into the APK — the same APK serves every operator's Firebase project.

## Patches

### 1. `gen/android/build.gradle.kts` (root)

The `com.google.gms.google-services` classpath is intentionally **absent** (the plugin is not applied — see
§2). Only the AGP + Kotlin classpaths remain.

### 2. `gen/android/app/build.gradle.kts`

The `com.google.gms.google-services` plugin is **NOT applied** (commented out in `plugins {}`): there is no
`google-services.json` to process. FirebaseApp is initialized manually by `SomsFirebase`. Only the Firebase
**library** deps are needed (they transitively bring `firebase-common` / `firebase-installations`, which is
where `FirebaseApp.initializeApp` + `FirebaseOptions.Builder` live):

```kotlin
implementation(platform("com.google.firebase:firebase-bom:33.4.0"))
implementation("com.google.firebase:firebase-messaging")
```

### 3. `gen/android/app/src/main/AndroidManifest.xml`

- `xmlns:tools` declared on `<manifest>` (for the `tools:node="remove"` below).
- `<application>` carries `android:name=".SomsApplication"` — the process-start hook that initializes
  FirebaseApp from the persisted client config before any component runs.
- POST_NOTIFICATIONS permission + the `SomsMessagingService` registration (as before):

```xml
<service
    android:name=".SomsMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

- **Dynamic-config additions inside `<application>`:** `tools:node="remove"` on the merged
  `FirebaseInitProvider` (FirebaseApp is initialized manually by `SomsFirebase` — there is no bundled
  google-services.json for the provider to auto-read), and
  `<meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false"/>` (re-enabled at
  runtime by `SomsFirebase` immediately after the manual `initializeApp`).

### 4. `gen/android/app/src/main/java/com/soms/client/MainActivity.kt`

Replace the stock 11-line `MainActivity` with the version that:
- captures the cold-start deep-link `EXTRA_THREAD_ID` into `DeepLinkState` in `onCreate`,
- flips `SomsMessagingService.appInForeground` in `onResume`/`onStop`,
- injects the pending deep link via `evaluateJavascript` in `onResume`,
- routes `onNewIntent` (warm-start) deep links to the live webview,
- attaches the `@JavascriptInterface` named `SomsFcm` (token + permission) in `onResume`.

See the current on-disk `MainActivity.kt` for the canonical text.

### 5. New Kotlin files in `com.soms.client`

- `SomsApplication.kt` — `Application` subclass registered via `<application android:name>`. `onCreate`
  calls `SomsFirebase.ensureInitialized(this)` — the **process-start** Firebase init. This is the
  load-bearing hook for dynamic FCM: a background data-only high-priority FCM that wakes a dead process
  starts it straight into `SomsMessagingService` WITHOUT creating `MainActivity`, so init must precede any
  component. `Application.onCreate` does. Tauri v2 requires no Application class (its init is Activity-
  scoped via `ProcessLifecycleOwner`), so registering this subclass is safe.
- `SomsFirebase.kt` — `object` owning the `FirebaseApp` lifecycle. `ensureInitialized(ctx)` reads the
  persisted client config (SomsSecureStore) and `FirebaseApp.initializeApp(FirebaseOptions)` idempotently
  (no-op when no config yet → FCM unavailable, app runs on SSE/WorkManager). `reconfigure(ctx, json)`
  persists a freshly-fetched config and re-binds Firebase: on a project change it `deleteToken` +
  `deleteApp` + re-`initializeApp` + fetches a new token (a same-named second `initializeApp` would throw
  otherwise). `clear(ctx)` tears it all down. `requestToken(ctx)` is the token Task + emit. New tokens
  flow back through the existing `SomsBridge.FcmToken` + `window.__SOMS_FCM_TOKEN__` pipe — no new web-side
  registration logic.
- `SomsBridge.kt` — process-global bridge: the live webview reference (set by
  `MainActivity.onWebViewCreate`), a UI-thread `eval()` helper, a `jsonStr()` escaper, and two nested
  holders: `SomsBridge.FcmToken.current` and `SomsBridge.DeepLink.pendingThreadId`.
- `SomsMessagingService.kt` — `FirebaseMessagingService` subclass. `onMessageReceived` posts a per-thread
  `NotificationCompat` (channel `messages`, grouped by thread) unless `appInForeground`, then advances
  the shared dedup cursor (`SomsSecureStore.advanceCursor`) so the worker doesn't re-notify; `onNewToken`
  stashes the token in `SomsBridge.FcmToken` and emits `window.__SOMS_FCM_TOKEN__(token)` to the webview.
  Also exposes `notifyMissed` / `notifyMissedSummary` for the WorkManager poller path (localized strings).
- `SomsSecureStore.kt` — EncryptedSharedPreferences wrapper holding the session token, api origin, the
  per-thread dedup cursor, and the **Firebase client config** (`firebase_config` key, JSON string of the 4
  fields the server publishes). Read by the worker, the realtime service, and `SomsFirebase` at process
  start; written by the JS bridge (token + origin + firebase config) and both push paths (cursor).
- `NotificationSyncWorker.kt` — `CoroutineWorker`, ~6h periodic. Skips when foreground/logged-out/no
  origin; OkHttp-POSTs `/notifications/missed` with the notification token; posts a localized local
  notification per fresh thread (or an aggregated summary when many), advancing the shared cursor.

The webview reference is obtained from `WryActivity.onWebViewCreate` (the idiomatic Tauri v2 hook), not
a view-tree walk. `MainActivity` adds a `@JavascriptInterface` named `SomsFcm` (`getToken()`,
`requestToken()`, `requestNotificationPermission()`, `setNotificationToken(token)`,
`setApiOrigin(origin)`) in `onWebViewCreate`, flips `SomsMessagingService.appInForeground` in
`onResume`/`onStop`, captures cold-start deep links in `onCreate`, routes warm-start links in
`onNewIntent`, and enqueues the periodic `NotificationSyncWorker` (unique work `soms-notif-sync`, KEEP)
in `onCreate`.

### 6. New gradle deps (app/build.gradle.kts)

```kotlin
implementation("androidx.work:work-runtime-ktx:2.10.0")        // NotificationSyncWorker
implementation("androidx.security:security-crypto:1.1.0-alpha06") // EncryptedSharedPreferences
implementation("com.squareup.okhttp3:okhttp:4.12.0")            // worker HTTP POST
```

### 7. New i18n resources

- `res/values/strings.xml` — `notif_missed_one` / `notif_missed_many` (English).
- `res/values-zh-rCN/strings.xml` — Simplified Chinese variants. Android picks per device locale automatically;
  `ctx.getString(R.string.notif_*)` resolves to the right one with no explicit branching. Wording
  mirrors `web/src/app/i18n/{en,zh-CN}.json notif.*` for cross-surface consistency.

## Compile invariants (these broke a release build — keep them on re-apply)

`tauri android init` regenerates `gen/android`, so any hand-written Kotlin there is lost. The two
files below currently have fixes that are NOT obvious from the surrounding code; re-create them this
way (the on-disk files are canonical, these are the rules that must hold):

- **`MessageSyncService.kt`** extends `android.app.Service` → it MUST override `onBind` (the base
  member is abstract), or `compileUniversalReleaseKotlin` fails with "does not implement abstract
  base class member onBind". Add:
  ```kotlin
  override fun onBind(intent: Intent?): IBinder? = null   // bound mode unused (started FGS)
  ```
  (and `import android.os.IBinder`). This file is the domestic `dataSync` foreground service
  (native SSE to `/notifications/stream`, the mainland-China real-time path with no FCM); it is NOT
  in the original §5 list — add it when re-applying.
- **`SomsMessagingService.parseSnapshotArray`** — the per-item `JSONObject` loop local MUST NOT be
  named `it`. Inside `mid.takeIf { … }` the implicit `it` is `mid` (a String), so `it.has(...)` /
  `it.isNull(...)` fail with "Unresolved reference". Name it `obj` (or anything but `it`):
  ```kotlin
  val obj = arr.optJSONObject(i) ?: continue
  …
  latestMessageId = mid.takeIf { obj.has("latestMessageId") && !obj.isNull("latestMessageId") && mid.isNotEmpty() },
  ```

- **`MainActivity.fetchFcmToken` delegates to `SomsFirebase`** and guards on `ensureInitialized` returning
  null. Under the dynamic-config model there is no `google-services` plugin at all — `FirebaseApp` is
  initialized from the server-fetched config persisted in `SomsSecureStore`. `ensureInitialized` is a no-op
  when already initialized this process; it returns null only when no config is persisted yet (first run /
  cleared), in which case FCM is unavailable and `fetchFcmToken` skips silently (the app runs on foreground
  SSE + the WorkManager poller). The historical crash — `FirebaseMessaging.getInstance()` throwing
  `IllegalStateException: Default FirebaseApp is not initialized` when the plugin was off — is now
  structurally impossible: `SomsFirebase.requestToken` itself guards on
  `FirebaseApp.getApps(ctx).isEmpty()`. `SomsMessagingService` needs no guard — the system only invokes it
  on a real FCM event, which can't fire without an initialized FirebaseApp.
  ```kotlin
  private fun fetchFcmToken() {
      if (SomsFirebase.ensureInitialized(this) == null) return  // no config yet — push unavailable
      SomsFirebase.requestToken(this)
  }
  ```

## Release signing (optional — needed only to install a *release* APK)

The signing config is **already wired** in `gen/android/app/build.gradle.kts`: it loads
`keystore.properties` when present and applies a `signingConfigs.release` to the release build type
(absent file → unsigned release, which Android won't install). Debug builds auto-sign with the stable
debug keystore the Makefile generates (see README §Android build). To produce an installable **release**
APK, provide the two secret files (both gitignored):

1. Generate the release keystore once (keep it + the passwords safe — it is your signing identity):
   ```
   keytool -genkeypair -keystore src-tauri/gen/android/app/soms-release.keystore \
     -alias soms -keyalg RSA -keysize 2048 -validity 10000 \
     -storepass <STOREPASS> -keypass <KEYPASS> -dname "CN=SOMS, O=SOMS"
   ```
2. `src-tauri/gen/android/keystore.properties`:
   ```
   storeFile=app/soms-release.keystore
   storePassword=<STOREPASS>
   keyAlias=soms
   keyPassword=<KEYPASS>
   ```

Both files are secrets — back them up out-of-band; a fresh clone needs them restored before a signed
release build.

## IPC contract (webview ↔ Kotlin)

| Direction | Carrier | Mechanism |
|---|---|---|
| Kotlin → JS (token rotation, warm deep link) | `WebView.evaluateJavascript` calling a global hook (`window.__SOMS_FCM_TOKEN__`, `window.__SOMS_DEEP_LINK__`) | Mirrors the origin init-script pattern |
| JS → Kotlin (token read, permission request) | `@JavascriptInterface` named `SomsFcm`, attached in `onWebViewCreate` | Mirrors `Ipc.kt`'s `@JavascriptInterface` pattern |
| JS → Kotlin (firebase client config hand-off) | `SomsFcm.setFirebaseConfig(json)` / `getFirebaseConfig()` `@JavascriptInterface` | web fetches the server's 4 fields and hands them to native, which persists + (re)initializes FirebaseApp; null clears it |
| Backend → client (public firebase config) | `GET /api/v1/shell/compat` (`@Public`) | its `firebase` field contains the 4 client fields when configured, else `{configured:false}` |
| JS → backend (register HTTP) | `POST /api/v1/devices/register` | standard |

No `@tauri-apps/api` dependency, no Tauri event permission, no custom Rust plugin — the bridge reuses
the codebase's existing global-injection + `@JavascriptInterface` style.

## Data-only payload contract

The backend (`PushService.dispatchForMessage`) sends data-only, `android.priority: high` messages:

```
{ threadId, messageId, contentType, ts[, preview] }
```

`preview` is included only for `PURE_TEXT` (truncated to 120 chars). No `notification` field — the
client builds the visible notification from this data so the canonical Message row stays the single
source of truth and `onMessageReceived` is always invoked (even when the OS has killed the app).

## Hardware-back bridge

Hardware-back is routed to the web nav state machine (`NavStateMachineService`), which peels one layer
(pane → aside → chat → home) and finishes the activity when the stack is empty. This replaces the default
(WryActivity's webview-history traversal, disabled via `TauriActivity.handleBackNavigation = false`).

| Direction | Carrier | Mechanism |
|---|---|---|
| Kotlin → JS (hardware-back press) | `OnBackPressedDispatcher` callback in `MainActivity.onCreate` → `SomsBridge.eval("window.__SOMS_BACK__ && window.__SOMS_BACK__();")` | Same `evaluateJavascript`-global-hook pattern as the token/deep-link emissions |
| JS → Kotlin (exit at home) | `@JavascriptInterface` named `SomsBack` (`exit()`), attached in `onWebViewCreate` | Same `@JavascriptInterface` pattern as `SomsFcm`; `exit()` finishes the activity on the UI thread |

JS registers `window.__SOMS_BACK__` at boot (`AppComponent`, gated `isTauri() && isAndroid()`): it calls
`nav.back()`; if that returns `false` (at home), it calls `window.SomsBack.exit()`. Desktop/browser have no
native back — history is flat, so browser-back exits there.

## Safe-area inset bridge (status bar / gesture bar)

Android WebView is drawn edge-to-edge (`enableEdgeToEdge()` in `MainActivity.onCreate`), so the system
status bar overlays the top of the web content. `env(safe-area-inset-top)` returns **0** in Android
WebView (it forwards cutout insets, not the status bar), so the web layer can't learn the inset from CSS
alone. The native shell measures it and injects it.

| Direction | Carrier | Mechanism |
|---|---|---|
| JS → Kotlin (read insets) | `@JavascriptInterface` named `SomsShell` (`getSafeInsets()`), attached in `onWebViewCreate` | Same `@JavascriptInterface` pattern as `SomsFcm`/`SomsBack` |
| Kotlin → JS (inset change, e.g. rotation) | `WebView.evaluateJavascript` setting `--soms-safe-top`/`--soms-safe-bottom` on `:root` | Same `evaluateJavascript` pattern as the token/deep-link emissions |

- `MainActivity.installInsetsListener()` (called from `onCreate`) registers a
  `ViewCompat.setOnApplyWindowInsetsListener` on `android.R.id.content`. It reads
  `WindowInsetsCompat.Type.statusBars().top` + `navigationBars().bottom` (device px), divides by
  `resources.displayMetrics.density` → integer CSS px, and stores them in `@Volatile` fields
  (`safeInsetTopCss` / `safeInsetBottomCss`). Per-device — never a hardcoded constant (Huawei =
  80dp ÷ 2.5 = 32px; other devices differ).
- The listener fires on the first layout pass (~1 frame after attach, well before the page finishes
  loading) and on every inset change (rotation).
- `SomsShell.getSafeInsets()` returns JSON `{"top":int,"bottom":int}`. The web app reads it in
  `main.ts` **before `bootstrapApplication()`** (`applySafeInsets()` in `services/runtime.ts`) and sets
  `--soms-safe-top`/`--soms-safe-bottom` on `:root` — so the first Angular paint already has the inset
  (FOUC-free). The listener's `evaluateJavascript` covers later changes (rotation) without a reload.
- CSS default (`web/src/app/assets/_tokens.scss`): `--soms-safe-top: env(safe-area-inset-top, 0px)` —
  correct for the browser/iOS-PWA build (which forward `env()`), so no native bridge is needed there.
  Consumed by the auth shell (`assets/utils.scss`) and the app shell to pad content below the status bar.
