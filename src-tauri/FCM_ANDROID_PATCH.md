# FCM Android patch (re-apply after `tauri android init`)

`src-tauri/gen/` is gitignored — `tauri android init` generates the Android project on demand, and these
native-side Firebase modifications are NOT recovered from a fresh checkout. This file is the source of
truth. Re-apply all changes below after regenerating the Android project (or when bumping the Tauri
version). The browser/backend builds are unaffected.

The edits live in four persistent (non-`generated/`) files plus two new Kotlin files. **Never** edit
anything under `gen/android/app/src/main/java/com/soms/desktop/generated/` or any `tauri.*.gradle.kts`
— they carry `AUTO-GENERATED` headers and are overwritten.

## Prerequisites (one Firebase project)

1. Create a Firebase project. Add an **Android app** with package name `com.soms.desktop` (matches
   `app/build.gradle.kts` `applicationId` and `src-tauri/tauri.conf.json` `identifier`).
2. Download `google-services.json` → drop at `gen/android/app/google-services.json` (gitignored).
3. Register the debug **and** release signing-key SHA-1 in the console app's "SHA certificate
   fingerprint" — without it, FCM token retrieval silently fails.
4. Backend: Project Settings → Service Accounts → "Generate new private key" → set
   `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/sa.json` in the backend `.env`.

## Patches

### 1. `gen/android/build.gradle.kts` (root)

Add the google-services plugin classpath to `buildscript.dependencies`:

```kotlin
classpath("com.google.gms:google-services:4.4.2")
```

### 2. `gen/android/app/build.gradle.kts`

In `plugins {}`, apply the plugin:

```kotlin
id("com.google.gms.google-services")
```

In `dependencies {}`, add the Firebase BOM + messaging:

```kotlin
implementation(platform("com.google.firebase:firebase-bom:33.4.0"))
implementation("com.google.firebase:firebase-messaging")
```

### 3. `gen/android/app/src/main/AndroidManifest.xml`

- Add the permission: `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`
- Inside `<application>`, register the service:

```xml
<service
    android:name=".SomsMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

### 4. `gen/android/app/src/main/java/com/soms/desktop/MainActivity.kt`

Replace the stock 11-line `MainActivity` with the version that:
- captures the cold-start deep-link `EXTRA_THREAD_ID` into `DeepLinkState` in `onCreate`,
- flips `SomsMessagingService.appInForeground` in `onResume`/`onStop`,
- injects the pending deep link via `evaluateJavascript` in `onResume`,
- routes `onNewIntent` (warm-start) deep links to the live webview,
- attaches the `@JavascriptInterface` named `SomsFcm` (token + permission) in `onResume`.

See the current on-disk `MainActivity.kt` for the canonical text.

### 5. New Kotlin files in `com.soms.desktop`

- `SomsBridge.kt` — process-global bridge: the live webview reference (set by
  `MainActivity.onWebViewCreate`), a UI-thread `eval()` helper, a `jsonStr()` escaper, and two nested
  holders: `SomsBridge.FcmToken.current` and `SomsBridge.DeepLink.pendingThreadId`.
- `SomsMessagingService.kt` — `FirebaseMessagingService` subclass. `onMessageReceived` posts a per-thread
  `NotificationCompat` (channel `messages`, grouped by thread) unless `appInForeground`; `onNewToken`
  stashes the token in `SomsBridge.FcmToken` and emits `window.__SOMS_FCM_TOKEN__(token)` to the webview.

The webview reference is obtained from `WryActivity.onWebViewCreate` (the idiomatic Tauri v2 hook), not
a view-tree walk. `MainActivity` adds a `@JavascriptInterface` named `SomsFcm` (`getToken()`,
`requestToken()`, `requestNotificationPermission()`) in `onWebViewCreate`, flips
`SomsMessagingService.appInForeground` in `onResume`/`onStop`, captures cold-start deep links in
`onCreate`, and routes warm-start links in `onNewIntent`.

## IPC contract (webview ↔ Kotlin)

| Direction | Carrier | Mechanism |
|---|---|---|
| Kotlin → JS (token rotation, warm deep link) | `WebView.evaluateJavascript` calling a global hook (`window.__SOMS_FCM_TOKEN__`, `window.__SOMS_DEEP_LINK__`) | Mirrors the origin init-script pattern |
| JS → Kotlin (token read, permission request) | `@JavascriptInterface` named `SomsFcm`, attached in `onResume` | Mirrors `Ipc.kt`'s `@JavascriptInterface` pattern |
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
