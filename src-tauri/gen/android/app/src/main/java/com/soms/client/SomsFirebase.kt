package com.soms.client

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * Single owner of the [FirebaseApp] lifecycle for the dynamic FCM runtime-config model.
 *
 * The APK ships WITHOUT google-services.json — each server operator runs their own Firebase project, so the
 * client can't bake one in. Instead the server publishes its 4 Firebase client fields at
 * the `/shell/compat` payload; the web layer receives them (`PushService.applyFirebaseConfig`) and hands
 * them here via the `SomsFcm.setFirebaseConfig` `@JavascriptInterface`. This object persists them in
 * [SomsSecureStore] and (re)initializes [FirebaseApp].
 *
 * **Why process-start init lives in `SomsApplication`, not MainActivity:** a data-only high-priority FCM
 * that wakes a dead process starts the process straight into [SomsMessagingService] WITHOUT creating the
 * Activity. `Application.onCreate` runs before any component, so [ensureInitialized] there guarantees
 * FirebaseApp is up before `onMessageReceived`. MainActivity only triggers token *fetch*; init itself is
 * process-start.
 *
 * New tokens always flow back through the existing pipe: [requestToken] / [SomsMessagingService.onNewToken]
 * write `SomsBridge.FcmToken.current` and emit `window.__SOMS_FCM_TOKEN__(...)`, which the web's PushService
 * turns into a `POST /devices/register`. No new web-side registration logic.
 *
 * On a server/project switch [reconfigure] tears the old app down (deleteToken + deleteApp) before
 * re-initializing with the new options — a same-named second `initializeApp` would throw `IllegalStateException`
 * otherwise.
 */
object SomsFirebase {
    private const val TAG = "SomsFirebase"

    /** Idempotently ensure the default [FirebaseApp] is initialized from the persisted config. Called at
     *  process start ([SomsApplication.onCreate]) and from the `fetchFcmToken` guard. Returns the app, or
     *  null when no config is persisted yet (first run / cleared) — in that state FCM is simply unavailable
     *  and [SomsMessagingService] is never invoked (no project → no token → no push). Does NOT fetch a token;
     *  the caller ([MainActivity.fetchFcmToken]) does, on every launch, so a cached token is re-loaded into
     *  `SomsBridge.FcmToken` even when `onNewToken` won't re-fire for an unchanged token. */
    fun ensureInitialized(ctx: Context): FirebaseApp? {
        if (FirebaseApp.getApps(ctx).isNotEmpty()) return FirebaseApp.getInstance()
        val options = optionsFromString(SomsSecureStore.getFirebaseConfig(ctx) ?: return null) ?: return null
        val app = FirebaseApp.initializeApp(ctx, options)
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        SomsLog.i("Firebase") { "FirebaseApp initialized for project ${options.projectId}" }
        return app
    }

    /** (Re)configure Firebase from a freshly-fetched config JSON (or null/empty to clear). Persists to
     *  [SomsSecureStore] FIRST (so a process restart mid-reconfigure still recovers the intended config),
     *  then: if a FirebaseApp already exists, delete its token + the app before re-initializing with the new
     *  options; finally fetch a fresh token. Runs on the UI thread (the `@JavascriptInterface` hops to it)
     *  so the token Task listeners — which fire on main — see a consistent app instance. */
    fun reconfigure(ctx: Context, json: String?) {
        val trimmed = json?.trim()?.takeIf { it.isNotEmpty() }
        SomsLog.i("Firebase") { "reconfigure start; configured=${trimmed != null}" }
        if (trimmed == null) {
            clear(ctx)
            SomsLog.i("Firebase") { "reconfigure clear dispatched" }
            return
        }
        SomsSecureStore.setFirebaseConfig(ctx, trimmed)
        SomsLog.i("Firebase") { "reconfigure config persisted" }
        val newOptions = optionsFromString(trimmed)
        if (newOptions == null) {
            Log.w(TAG, "setFirebaseConfig: malformed config JSON — rolling back")
            SomsSecureStore.setFirebaseConfig(ctx, null)
            return
        }
        if (FirebaseApp.getApps(ctx).isNotEmpty()) {
            // Tear down the existing project before binding the new one. deleteToken is async; chain the
            // re-init on its completion so the token unregister settles first.
            try {
                SomsLog.i("Firebase") { "reconfigure deleting old token asynchronously" }
                FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener {
                    SomsLog.i("Firebase") {
                        "reconfigure old-token task complete; successful=${it.isSuccessful}"
                    }
                    runCatching { FirebaseApp.getInstance().delete() }
                        .onFailure { e -> Log.w(TAG, "deleteApp: ${e.message}") }
                    freshInit(ctx, newOptions)
                }
            } catch (e: Exception) {
                Log.w(TAG, "deleteToken failed: ${e.message}; re-initializing anyway")
                runCatching { FirebaseApp.getInstance().delete() }
                freshInit(ctx, newOptions)
            }
        } else {
            SomsLog.i("Firebase") { "reconfigure no existing app; initializing" }
            freshInit(ctx, newOptions)
        }
    }

    /** Tear down Firebase entirely (the server has no FCM config → `{configured:false}`). */
    fun clear(ctx: Context) {
        SomsSecureStore.setFirebaseConfig(ctx, null)
        if (FirebaseApp.getApps(ctx).isEmpty()) return
        try {
            FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener {
                runCatching { FirebaseApp.getInstance().delete() }
                SomsBridge.FcmToken.current = null
            }
        } catch (e: Exception) {
            runCatching { FirebaseApp.getInstance().delete() }
            SomsBridge.FcmToken.current = null
        }
    }

    /** Fetch the current FCM registration token asynchronously and push it to the web layer via the shared
     *  `window.__SOMS_FCM_TOKEN__` hook (the web's PushService turns it into a register POST). A no-op when
     *  FirebaseApp isn't initialized. */
    fun requestToken(ctx: Context) {
        if (FirebaseApp.getApps(ctx).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                SomsBridge.FcmToken.current = token
                SomsBridge.FcmToken.lastError = null
                SomsBridge.eval("window.__SOMS_FCM_TOKEN__ && window.__SOMS_FCM_TOKEN__(${SomsBridge.jsonStr(token)});")
            } else {
                SomsBridge.FcmToken.lastError =
                    task.exception?.javaClass?.simpleName ?: "TOKEN_FETCH_FAILED"
                Log.w(TAG, "token fetch failed: ${task.exception?.message}")
            }
        }
    }

    private fun freshInit(ctx: Context, options: FirebaseOptions) {
        SomsLog.i("Firebase") { "freshInit start" }
        try {
            FirebaseApp.initializeApp(ctx, options)
            FirebaseMessaging.getInstance().isAutoInitEnabled = true
            SomsLog.i("Firebase") { "freshInit complete; token request dispatched" }
            requestToken(ctx)
        } catch (e: Exception) {
            Log.e(TAG, "freshInit failed: ${e.message}")
        }
    }

    private fun optionsFromString(json: String): FirebaseOptions? = try {
        val o = JSONObject(json)
        FirebaseOptions.Builder()
            .setApiKey(o.getString("apiKey"))
            .setApplicationId(o.getString("appId"))
            .setProjectId(o.getString("projectId"))
            .setGcmSenderId(o.getString("gcmSenderId"))
            .build()
    } catch (e: Exception) {
        Log.w(TAG, "optionsFromString: ${e.message}")
        null
    }
}
