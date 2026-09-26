package com.soms.client

import android.app.Application
import android.content.Context

/**
 * Process entry point. Initializes [com.google.firebase.FirebaseApp] from the persisted client config
 * BEFORE any component runs.
 *
 * This is the load-bearing hook for dynamic FCM. The APK ships WITHOUT `google-services.json` — each server
 * operator runs their own Firebase project, so the client can't bake one in. The web layer fetches the 4
 * Firebase client fields from the `/client/compat` payload (PushService.applyFirebaseConfig) and hands them
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
        appContext = this
        RustRuntimeBridge.initialize(this)
        SomsFirebase.ensureInitialized(this)
        // Eagerly create the notification channels at process start. Channel creation is idempotent and
        // free, and Android only registers an app as notification-capable (so it shows up in the per-app
        // Notifications / permission-management list) once at least one channel exists. The render paths in
        // SomsMessagingService call ensureChannel lazily, but on a device without Google Play Services
        // (common on mainland-China Android 9) the FCM path never fires and the foreground-service path
        // only runs after login — so a freshly opened app otherwise has no channel and is absent from
        // notification settings, which reads as "this app doesn't use notification permission." Creating
        // them here (Google's recommended hook) also guarantees channels exist before any background path
        // (e.g. a data-only FCM that wakes SomsMessagingService without ever starting MainActivity) posts.
        SomsMessagingService.ensureChannel(this)
    }

    companion object {
        /** The application Context, set in [onCreate] ahead of every component. Read by process-global
         *  singletons ([CallController]) that have no caller-passed reference (they are reached from both
         *  RealtimeService and the JS bridge in MainActivity). @Volatile: written once on the main thread,
         *  read on the call executor / JS bridge thread. */
        @Volatile
        lateinit var appContext: Context
            private set
    }
}
