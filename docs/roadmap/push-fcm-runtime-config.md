# FCM client config — runtime fetch (open-source / self-host)

**Status:** **implemented (2026-07-19).** This doc was the design rationale + implementation TODO; the
"Key technical findings" (#1–4, #6–7) remain the load-bearing justification and are unchanged. The
**Design** section below describes the *originally planned* shape and is **superseded** in three
specifics — see [Implementation (as built)](#implementation-as-built) at the bottom for what actually
shipped (file source via `FIREBASE_CLIENT_CONFIG`, `GET /push/firebase-config`, **skip SHA-1**).

**Supersedes part of** [`src-tauri/FCM_ANDROID_PATCH.md`](../../src-tauri/FCM_ANDROID_PATCH.md) §Prerequisites
step 2 (the "drop `google-services.json` at build time" model) **for Android only**. Web Push and the
backend service-account path are unchanged.

## Goal

This is an open-source, self-hostable app. Each deployer runs their own server and must be able to use
**their own** Firebase project for push, without forking the app or rebuilding the APK. One universal
APK must connect to any self-hoster's server and automatically use that server's Firebase project.

The Android client currently bakes Firebase config in at build time via `google-services.json`
(gitignored, consumed by the `com.google.gms.google-services` Gradle plugin). That ties one APK to one
Firebase project — the opposite of the goal. Web Push already does the right thing: `WebPushService`
fetches the VAPID public key at runtime from `GET /notifications/vapid-key`. FCM must match that model.

## Key technical findings (the part not to re-derive)

These were established by analysis and are the load-bearing facts behind the design. If any feels wrong
later, re-verify before reverting to build-time.

1. **`google-services.json` is not mandatory.** It is only the input to the standard *auto-init* path:
   the Gradle plugin generates `res/values/google-services.xml`, and `FirebaseInitProvider` (a
   ContentProvider) reads those resources at app start and calls `FirebaseApp.initializeApp()`. The file
   feeds the SDK four values; it does nothing magic.

2. **`FirebaseApp.initializeApp(context, FirebaseOptions)` is a public, documented API.** It exists for
   multi-app instances, white-label/multi-tenant builds, and fetching config from your own backend —
   exactly our case. It is not reflection into private fields, not SDK patching, not a hack. Feeding the
   same four values at runtime is SDK-supported behavior.

3. **The client Firebase config is not secret.** `senderId` / `appId` / `apiKey` / `projectId` are
   identifiers, not keys. Firebase's docs state client API keys are safe to expose; they are protected by
   security rules and API restrictions, not by secrecy. Exposing them via a server endpoint is safe. The
   **only** secret is the service-account JSON (`GOOGLE_APPLICATION_CREDENTIALS`), which stays on the
   deployer's server — already correct in `PushService`.

4. **Runtime init trips no Android OS security mechanism.** Signature checks, Google Play Protect, Play
   Integrity, and package-name validation are all either opt-in or server-side. The SDK does not verify
   the app signature locally; Play Protect does not flag `initializeApp`; Play Integrity is only invoked
   if the app opts into **App Check** (off by default). There is no local OS gate on runtime Firebase init.

5. **The one real enforcement is server-side, at Google, and is unaffected by build-time vs runtime.**
   When the client requests an FCM token, Google's servers cross-check that the app's
   **(package name + signing certificate SHA-1)** is registered as an Android app under the project whose
   sender ID was used to initialize. Registered → token issued; not registered → silent failure (the same
   "missing SHA-1" failure `FCM_ANDROID_PATCH.md` warns about). This check happens on Google's servers,
   not on the device, and passes identically whether config was baked or fetched — as long as package +
   SHA-1 are registered in the deployer's Firebase project.

   > **As-built correction (2026-07-19):** this overstated the requirement for **data-only** messaging.
   > Token issuance + data-message delivery work **without** registering SHA-1 in practice. The as-built
   > decision is therefore to **skip SHA-1** (it is only needed for Google Sign-In / App Check, which this
   > app doesn't use), which additionally sidesteps the cross-project `(package + SHA-1)` uniqueness
   > conflict that would otherwise force every self-hoster onto a single shared signing key. SHA-1 remains
   > the documented **fallback** if a given project still refuses to issue a token.

6. **App Check is the single "if enabled, re-verify" caveat.** If FCM App Check enforcement (Play
   Integrity attestation) is ever turned on, attestation binds to the initialized project and the target
   project must have App Check + the app's Play Integrity configured. App Check is opt-in and off by
   default; basic data-only messaging does not touch it.

7. **Why config must come from the server, not just "not hardcoded":** an FCM token is scoped to a
   Firebase project (sender ID). The client must register with project X **and** the server must send via
   project X. Sourcing the client config from the same server that holds the service-account credentials
   guarantees they always match — eliminating a class of silent mismatch failures.

## Design

Mirror the existing Web Push / VAPID pattern exactly: server is the single source of truth for the
**public** client Firebase config; the client fetches it and initializes Firebase programmatically.

### Backend

**New endpoint** in `src/controller/notification.controller.ts`, next to `vapidKey()`
(`notification.controller.ts:48`), same shape:

```ts
@Get('notifications/fcm-config')
@ApiOperation({ summary: 'Public FCM client config for runtime init (Android).' })
fcmConfig(): ApiResult {
  return {
    data: {
      apiKey: process.env.FIREBASE_CLIENT_API_KEY ?? '',
      appId: process.env.FIREBASE_CLIENT_APP_ID ?? '',
      projectId: process.env.FIREBASE_CLIENT_PROJECT_ID ?? '',
      messagingSenderId: process.env.FIREBASE_CLIENT_MESSAGING_SENDER_ID ?? '',
    },
  };
}
```

Return empty strings when unset (like `vapid-key` does) — the client treats "any field empty" as
"FCM not configured for this server" and no-ops, same degradation Web Push uses.

**Env** (extend the `# ===== Push (FCM + Web Push) =====` block in `.env.example`, currently line 36).
The four values come straight from the deployer's downloaded `google-services.json`:

| Env var | `google-services.json` source |
|---|---|
| `FIREBASE_CLIENT_API_KEY` | `client[0].api_key[0].current_key` |
| `FIREBASE_CLIENT_APP_ID` | `client[0].client_info.mobilesdk_app_id` |
| `FIREBASE_CLIENT_PROJECT_ID` | `project_info.project_id` |
| `FIREBASE_CLIENT_MESSAGING_SENDER_ID` | `project_info.project_number` |

All four are public (finding #3). They are the client-side counterpart to the existing
`GOOGLE_APPLICATION_CREDENTIALS` (server-side secret). Both must come from the **same** Firebase project.

`PushService` is unchanged — `firebase-admin` still reads the service account from
`GOOGLE_APPLICATION_CREDENTIALS` (`push.service.ts:37`).

### Android client

In `com.soms.client` (the package owning `SomsBridge.kt`, `SomsMessagingService.kt`,
`SomsSecureStore.kt`, `MainActivity.kt`):

1. **Strip the build-time path.** Remove the `com.google.gms.google-services` plugin from
   `gen/android/app/build.gradle.kts` and the classpath from `gen/android/build.gradle.kts` (the two
   edits in `FCM_ANDROID_PATCH.md` §1–§2). Do **not** ship `google-services.json`. Keep the
   `firebase-bom` + `firebase-messaging` dependencies (§2) — the SDK is still needed, just not the plugin.
2. **Disable auto-init.** In `AndroidManifest.xml` remove the `FirebaseInitProvider` so it does not try
   to read the now-absent generated resources:
   ```xml
   <provider
       android:name="com.google.firebase.provider.FirebaseInitProvider"
       android:authorities="${applicationId}.firebaseinitprovider"
       tools:node="remove" />
   ```
3. **Fetch + cache + init.** On the existing "connect to server" step (the app already calls the backend
   and has `setApiOrigin`), add a fetch of `/notifications/fcm-config`. Persist the four values in
   `SomsSecureStore` (EncryptedSharedPreferences — already holds the token + origin + cursor).
4. **Init the default FirebaseApp** with the fetched `FirebaseOptions`:
   ```kotlin
   val opts = FirebaseOptions.Builder()
       .setApiKey(apiKey)
       .setApplicationId(appId)
       .setProjectId(projectId)
       .setMessagingSenderId(senderId)
       .build()
   FirebaseApp.initializeApp(this, opts)   // default app — FCM binds to it
   ```
   Then the existing token handshake (`SomsFcm` `@JavascriptInterface` `getToken()`/`requestToken()`,
   `onNewToken` → `window.__SOMS_FCM_TOKEN__`) is unchanged.
5. **Cold start** (user confirms this is a non-issue — there is always a connect step first): on every
   process start, read the cached config from `SomsSecureStore` and run the `initializeApp` above
   synchronously (e.g. in `Application.onCreate` or at the top of `SomsMessagingService`), so a push that
   cold-starts the process still has a live default app. The config is populated on the first connect and
   is thereafter available locally; push is never needed before the first successful connect.

`WebPushService` (web/PWA) and desktop notifications need no change — web already inits at runtime,
desktop uses system/browser notifications with no Firebase client config.

## Implementation TODO (historical — the original plan; superseded — see "Implementation (as built)" for what shipped)

- [ ] **Spike first (de-risk).** Before changing the architecture: on the current Android build, remove
      the plugin + json + provider, hardcode a `FirebaseOptions` with a real project's values in
      `Application.onCreate`, call `initializeApp`, fetch a token, and send a data-only push from the
      admin test-push surface. **Token issuance + delivery = proof nothing blocks runtime init** (finding
      #5: the only possible gate is server-side package+SHA-1 registration, which the spike exercises for
      real). If the spike fails, stop and re-investigate before proceeding.
- [ ] Backend: add `GET /notifications/fcm-config` handler + DTO/response typing; add the four
      `FIREBASE_CLIENT_*` vars to `.env.example`.
- [ ] Android: strip plugin/json/provider; add the fetch in the connect step; persist to `SomsSecureStore`;
      add the `initializeApp` call (foreground path + cold-start path).
- [ ] Update `src-tauri/FCM_ANDROID_PATCH.md`: mark §1–§2 (plugin + json) as **removed** under the runtime
      model; add the new §"runtime init" with the manifest provider-removal and the `FirebaseOptions`
      snippet; keep SHA-1 registration guidance (still required — finding #5).
- [ ] Decide signing strategy: ONE universal APK implies a single shared signing key, so every self-hoster
      must register **that key's** SHA-1 in their Firebase console. If self-hoster re-signs, they register
      their own. Document whichever is chosen.

## What every self-hoster still must do (Firebase console — invariant)

These are inherent to FCM regardless of build-time vs runtime config, and must be documented in the
self-hosting guide:

1. Create a Firebase project.
2. Add an Android app with package name `com.soms.client` (matches `applicationId` / `tauri.conf.json`
   `identifier`).
3. **Skip SHA-1** (the as-built default — see the finding #5 correction). Do **not** register a signing-
   key SHA-1 unless token retrieval proves to silently fail on a given project, in which case add the
   debug **and** release SHA-1 under "SHA certificate fingerprint" as the fallback.
4. Place `google-services.json` on the server at `FIREBASE_CLIENT_CONFIG` (default
   `data/google-services.json`), and the service-account JSON into `GOOGLE_APPLICATION_CREDENTIALS`, from
   the same project.

## Implementation (as built)

The Design section above proposed four separate **env-var** values (`FIREBASE_CLIENT_*`) and `GET
/notifications/fcm-config`. What shipped is simpler and better — a single **file path**, because
google-services.json is a Firebase-console download, structurally the same artifact as the
`GOOGLE_APPLICATION_CREDENTIALS` service-account key (also a file + env path), NOT a server-generated value
like the VAPID keypair. (An earlier iteration modeled it after VAPID — DB + admin-web upload — but that was
reversed on 2026-07-23; VAPID stays DB-backed because it is server-generated, FCM client config is not.)

- **Source = file, not env-values or DB.** The operator places the **whole** `google-services.json` on the
  server at `FIREBASE_CLIENT_CONFIG` (default `data/google-services.json`). `SettingsService.getFirebaseConfig`
  lazily reads it + `parseGoogleServicesJson` (`src/settings/firebase.ts`) validates the Android client
  targets `com.soms.client` and caches the 4 fields for the process lifetime (restart to change). admin-web's
  Transport-config FCM card is read-only status — there is no upload/clear surface.
- **Endpoint = `GET /push/firebase-config`** (`src/controller/notification.controller.ts`), public like
  `notifications/vapid-key`. The field is **`gcmSenderId`** (sourced from `project_info.project_number`),
  uniform end-to-end; there is no `messagingSenderId` anywhere in the codebase.
- **Client init = manual** (`SomsFirebase` / `SomsApplication`): `FirebaseApp.initializeApp(ctx,
  FirebaseOptions{apiKey,applicationId,projectId,gcmSenderId})` at process start from the persisted
  config, handed over by the web layer via `SomsFcm.setFirebaseConfig`. The `google-services` Gradle
  plugin is permanently off and `FirebaseInitProvider` is `tools:node="remove"`d.
- **SHA-1 skipped** with a documented fallback (see the finding #5 correction + self-hoster step 3).

`src-tauri/FCM_ANDROID_PATCH.md` is the current operational source of truth; this roadmap doc is kept
only for the rationale.

## References

- [`src-tauri/FCM_ANDROID_PATCH.md`](../../src-tauri/FCM_ANDROID_PATCH.md) — current build-time Firebase
  integration (the parts this supersedes for Android).
- `src/push/push.service.ts:37` — backend `firebase-admin` init from `GOOGLE_APPLICATION_CREDENTIALS`
  (unchanged).
- `src/controller/notification.controller.ts:48` — `GET /notifications/vapid-key`, the endpoint shape to
  mirror for `fcm-config`.
- `web/src/app/services/web-push.service.ts:128` — runtime VAPID fetch, the precedent this generalizes.
- Memory: `fcm-push-architecture` (current FCM design), `fcm-runtime-config-planned` (this decision).
