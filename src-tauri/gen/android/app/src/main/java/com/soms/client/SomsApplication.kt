package com.soms.client

import android.app.Application

/**
 * Process entry point. Initializes [com.google.firebase.FirebaseApp] from the persisted client config
 * BEFORE any component runs.
 *
 * This is the load-bearing hook for dynamic FCM. The APK ships WITHOUT `google-services.json` — each server
 * operator runs their own Firebase project, so the client can't bake one in. The web layer fetches the 4
 * Firebase client fields from `GET /push/firebase-config` (PushService.refreshFirebaseConfig) and hands them
 * to [SomsFirebase] via the `SomsFcm.setFirebaseConfig` `@JavascriptInterface`, which persists them in
 * [SomsSecureStore]. `Application.onCreate` runs at process start, ahead of every component — critically
 * ahead of [SomsMessagingService], which a background data-only high-priority FCM can wake directly without
 * ever creating [MainActivity]. Initializing here guarantees `onMessageReceived` sees an initialized
 * FirebaseApp.
 *
 * A no-op when no config is persisted yet (first run / cleared) — FCM is simply unavailable until the web
 * layer fetches + hands over a config; the app runs on foreground SSE + the WorkManager poller meanwhile.
 * Tauri v2 requires no `Application` subclass (all of its init is Activity-scoped via
 * `ProcessLifecycleOwner`), so registering this subclass via `<application android:name>` is safe.
 */
class SomsApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        SomsFirebase.ensureInitialized(this)
    }
}
