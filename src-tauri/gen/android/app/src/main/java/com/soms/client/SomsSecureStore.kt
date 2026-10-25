package com.soms.client

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Encrypted-at-rest store for the state the background services (NotificationSyncWorker, RealtimeService,
 * SomsMessagingService) need to survive across app process deaths — none of which the WebView/JS side can
 * hand them at the moment the service fires (the WebView is suspended):
 *  - `sessionToken`: the no-expiry session credential from POST /auth/login (Bearer on /events + /missed).
 *  - `apiOrigin`: the backend base URL the user configured (mirrors the web `apiOrigin`).
 *  - `pollingEnabled`: the user's Settings → Background toggle (default true). The worker reads it on
 *    every fire to self-gate; JS flips it via SomsFcm.setPollingEnabled (which also cancels / re-enqueues
 *    the schedule). Stored here rather than JS localStorage precisely because the worker fires with no
 *    WebView alive to read localStorage.
 *
 * EncryptedSharedPreferences (AES256-GCM) is the documented Android best practice for credentials at
 * rest; for a scoped/short-lived token this is belt-and-braces but cheap. The JS side pushes these
 * session credentials via SomsFcm; server origins are a read-only mirror of Rust configuration.
 */
object SomsSecureStore {
    private const val FILENAME = "soms_secure"

    /** The backend's global API version prefix, interpolated into every notification-path URL the
     *  background services build ([RealtimeService], [NotificationSyncWorker], SomsMessagingService).
     *  Mirrors the web `apiPrefix` constant (`${apiOrigin()}/api/v1`) — Nest applies this prefix to every
     *  controller, so `/notifications/stream` is actually served at `/api/v1/notifications/stream`. A path
     *  without it 404s, which (being a non-401 failure) the FGS treats as transient and retries forever —
     *  the service stays up but never receives a frame. Keep this in sync with `constants.ts`. */
    const val API_PREFIX = "/api/v1"

    private const val KEY_SESSION_TOKEN = "session_token"
    private const val KEY_LOGIN_SESSION_ID = "login_session_id"
    private const val KEY_CURRENT_USER_ID = "current_user_id"
    private const val KEY_API_ORIGIN = "api_origin"
    private const val KEY_API_ORIGIN_SECONDARY = "api_origin_secondary"
    /** Persisted mirror of Rust's active-origin choice: "primary" (default) or "secondary". */
    private const val KEY_ORIGIN_MODE = "origin_mode"
    private const val KEY_POLLING_ENABLED = "polling_enabled"
    private const val KEY_FGS_ENABLED = "fgs_enabled"
    private const val KEY_FCM_LAST_CHECK = "fcm_last_check"
    private const val KEY_FIREBASE_CONFIG = "firebase_config"
    private const val KEY_NOTIF_PERM_REQUESTED = "notif_perm_requested"

    @Volatile
    private var cachedOrigin: String? = null

    @Volatile
    private var cachedSecondary: String? = null

    @Volatile
    private var cachedFirebaseConfig: String? = null

    /** The cached encrypted-prefs singleton. EncryptedSharedPreferences.create is expensive (a MasterKey
     *  AES-GCM derivation + an encrypted-file open) — the AndroidX Security README says to cache it. Built
     *  ONCE per process (first access) + reused by every get/set, so a single native notification synchronization
     *  (getSessionToken + getApiOrigin + getMissedCursor) pays ONE derivation instead of three on the
     *  FCM-wake critical path. applicationContext so the cache never holds an Activity. @Synchronized so
     *  two threads racing the cold first-access can't each build a (harmless-but-wasteful) duplicate. */
    @Volatile
    private var cachedPrefs: SharedPreferences? = null

    @Synchronized
    internal fun prefs(ctx: Context): SharedPreferences {
        cachedPrefs?.let { return it }
        val p = EncryptedSharedPreferences.create(
            ctx.applicationContext,
            FILENAME,
            MasterKey.Builder(ctx.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        cachedPrefs = p
        return p
    }

    /** The no-expiry session token (POST /auth/login, app client) — the single native credential that
     *  authenticates the Kotlin-owned /events stream AND the background Rust thread-feed fetches
     *  (FGS / FCM / WorkManager). Supersedes the scoped 30-day notification token; revocation-only (no
     *  client-side expiry), mirroring Telegram's auth_key model. JS pushes it via SomsFcm.setSessionToken
     *  on login and clears it on logout. */
    fun setSessionToken(ctx: Context, token: String?, sessionUuid: String) {
        require(sessionUuid.isNotBlank()) { "sessionUuid must not be blank" }
        var releaseResources: (() -> Unit)? = null
        try {
            synchronized(this) {
                val previous = getSessionToken(ctx)
                val currentUuid = getLoginSessionId(ctx)
                if (token.isNullOrEmpty() && currentUuid != null && currentUuid != sessionUuid) {
                    return
                }
                val changed = token.isNullOrEmpty() || token != previous
                if (!previous.isNullOrEmpty() && previous != token) {
                    releaseResources = CallController.prepareSessionResourceRelease()
                }
                RustRuntimeBridge.setSessionToken(token, sessionUuid)
                val ed = prefs(ctx).edit()
                if (changed) {
                    ed.remove("session_id")
                    ed.remove(KEY_CURRENT_USER_ID)
                }
                if (token.isNullOrEmpty()) {
                    ed.remove(KEY_SESSION_TOKEN)
                    ed.remove(KEY_LOGIN_SESSION_ID)
                    ed.remove(KEY_CURRENT_USER_ID)
                } else {
                    ed.putString(KEY_SESSION_TOKEN, token)
                    ed.putString(KEY_LOGIN_SESSION_ID, sessionUuid)
                }
                ed.apply()
                if (changed) {
                    SomsMessagingService.clearSessionMessageNotifs(ctx)
                }
            }
        } finally {
            // SDK cancellation and media disposal must never run under the credential monitor.
            releaseResources?.invoke()
        }
    }

    /** Clear an unauthenticated/residual credential that failed Rust restoration on cold start. */
    fun discardResidualToken(ctx: Context) {
        var releaseResources: (() -> Unit)? = null
        try {
            synchronized(this) {
                if (getSessionToken(ctx) != null) {
                    releaseResources = CallController.prepareSessionResourceRelease()
                }
                RustRuntimeBridge.discardResidualToken()
                prefs(ctx).edit()
                    .remove(KEY_SESSION_TOKEN)
                    .remove(KEY_LOGIN_SESSION_ID)
                    .remove(KEY_CURRENT_USER_ID)
                    .remove("session_id")
                    .apply()
                SomsMessagingService.clearSessionMessageNotifs(ctx)
            }
        } finally {
            releaseResources?.invoke()
        }
    }

    @Synchronized fun getSessionToken(ctx: Context): String? = prefs(ctx).getString(KEY_SESSION_TOKEN, null)

    @Synchronized fun getLoginSessionId(ctx: Context): String? = prefs(ctx).getString(KEY_LOGIN_SESSION_ID, null)

    @Synchronized fun setHelloIdentity(ctx: Context, token: String?, sessionId: Int, userId: Int): Boolean {
        if (token.isNullOrEmpty() || token != getSessionToken(ctx) || sessionId <= 0 || userId <= 0) return false
        prefs(ctx).edit().putInt("session_id", sessionId).putInt(KEY_CURRENT_USER_ID, userId).apply()
        return true
    }

    fun getSessionId(ctx: Context): Int? = prefs(ctx).getInt("session_id", 0).takeIf { it > 0 }

    /** Numeric owner of the current device cache. This is storage partitioning only; peer identity remains
     * the canonical account+domain pair. Populated from the authenticated SSE HELLO. */
    fun setCurrentUserId(ctx: Context, userId: Int) {
        if (userId > 0) prefs(ctx).edit().putInt(KEY_CURRENT_USER_ID, userId).apply()
    }

    fun getCurrentUserId(ctx: Context): Int? =
        prefs(ctx).getInt(KEY_CURRENT_USER_ID, 0).takeIf { it > 0 }

    /** Whether the 6-hour background poller is enabled (default true). The WorkManager worker reads this
     *  on every fire to self-gate, so a toggle-off takes effect even for a process woken in the background
     *  before the WebView can cancel the schedule. JS flips it via SomsFcm.setPollingEnabled. */
    fun getPollingEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_POLLING_ENABLED, true)

    fun setPollingEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_POLLING_ENABLED, enabled).apply()
    }

    /** Whether the dataSync foreground service (RealtimeService) is enabled. Default TRUE so background
     *  realtime delivery works out of the box — at the cost of a persistent notification + held socket
     *  while backgrounded (the notification is dropped while foregrounded). The service starts on
     *  background only; this pref is the gate MainActivity.onStop checks. */
    fun getForegroundServiceEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_FGS_ENABLED, true)

    fun setForegroundServiceEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_FGS_ENABLED, enabled).apply()
    }

    /** Whether we have ever surfaced the system POST_NOTIFICATIONS prompt (Android 13+).
     *  `shouldShowRequestPermissionRationale` returns false BOTH when the permission was never asked AND
     *  when it's permanently denied — this flag is the discriminator the Settings panel uses to tell those
     *  apart (never-asked → "Allow" button still works; permanently-denied → "Open system settings").
     *  Set from MainActivity.onRequestPermissionsResult. Default false. */
    fun getNotifPermRequested(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_NOTIF_PERM_REQUESTED, false)

    fun setNotifPermRequested(ctx: Context, requested: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_NOTIF_PERM_REQUESTED, requested).apply()
    }

    /** Epoch ms of the last FCM availability check (token fetch). 0 = never. The Settings "FCM status"
     *  auto-checks at most once/day so a 国内 device (no GMS) doesn't hammer Google on every launch; a
     *  manual "check now" also writes this. */
    fun getFcmLastCheck(ctx: Context): Long = prefs(ctx).getLong(KEY_FCM_LAST_CHECK, 0L)

    fun setFcmLastCheck(ctx: Context, ms: Long) {
        prefs(ctx).edit().putLong(KEY_FCM_LAST_CHECK, ms).apply()
    }

    /** Mirror a committed Rust configuration as one preference edit. Never feed this mirror back
     * into the runtime: Rust has already installed the complete pair. */
    fun recordServerOrigins(ctx: Context, primary: String, secondary: String?, mode: String = "primary") {
        val ed = prefs(ctx).edit().putString(KEY_API_ORIGIN, primary)
            .putString(KEY_ORIGIN_MODE, mode)
        if (secondary == null) ed.remove(KEY_API_ORIGIN_SECONDARY)
        else ed.putString(KEY_API_ORIGIN_SECONDARY, secondary)
        check(ed.commit()) { "Could not persist server configuration mirror" }
        cachedOrigin = primary
        cachedSecondary = secondary
    }

    fun getApiOrigin(ctx: Context): String? {
        cachedOrigin?.let { return it }
        val v = prefs(ctx).getString(KEY_API_ORIGIN, null)?.trim()?.takeIf { it.isNotEmpty() }
        cachedOrigin = v
        return v
    }

    /** Kotlin SSE's active-origin choice — "primary" (default) or "secondary" (the primary failed and the
     *  stream switched to the LAN origin). Persisted so it survives START_STICKY restarts. INDEPENDENT of
     *  Rust's select_origin (which owns API traffic on Android) — both default to primary and fail over on
     *  failure, so they converge on the reachable origin. Reset to "primary" by the setters above on any
     *  reconfigure. */
    fun getOriginMode(ctx: Context): String =
        prefs(ctx).getString(KEY_ORIGIN_MODE, "primary") ?: "primary"

    /** Persist Rust's selected mode without feeding the same origin decision back into the runtime. */
    fun recordActiveOriginMode(ctx: Context, mode: String) {
        prefs(ctx).edit()
            .putString(KEY_ORIGIN_MODE, if (mode == "secondary") "secondary" else "primary")
            .apply()
    }

    /** Persisted mirror of Rust's ACTIVE endpoint. Platform avatar/icon requests and notification taps
     *  must use this rather than the configured primary, which may be unreachable on the current network.
     *  The adapter records Rust's selected mode; it does not independently probe or choose endpoints. */
    fun getActiveOrigin(ctx: Context): String? {
        val secondary = getApiOriginSecondary(ctx)
        return if (secondary != null && getOriginMode(ctx) == "secondary") secondary else getApiOrigin(ctx)
    }

    fun getApiOriginSecondary(ctx: Context): String? {
        cachedSecondary?.let { return it }
        val v = prefs(ctx).getString(KEY_API_ORIGIN_SECONDARY, null)?.trim()?.takeIf { it.isNotEmpty() }
        cachedSecondary = v
        return v
    }

    /** The server's Firebase client config (the 4 fields the APK needs to initialize FirebaseApp at runtime),
     *  as the JSON string the web layer handed via `SomsFcm.setFirebaseConfig`, or null when unset. The APK
     *  ships WITHOUT google-services.json (each operator runs their own Firebase project), so FirebaseApp is
     *  initialized at process start (SomsApplication.onCreate → SomsFirebase.ensureInitialized) from THIS
     *  persisted value — readable with no WebView alive, which is exactly the process-start requirement.
     *  In-memory cached like [cachedOrigin] so the cold process-start read avoids a second encrypted-file
     *  open on the FCM-wake critical path. */
    fun setFirebaseConfig(ctx: Context, json: String?) {
        cachedFirebaseConfig = json?.trim()?.takeIf { it.isNotEmpty() }
        val ed = prefs(ctx).edit()
        if (cachedFirebaseConfig == null) ed.remove(KEY_FIREBASE_CONFIG)
        else ed.putString(KEY_FIREBASE_CONFIG, cachedFirebaseConfig)
        ed.apply()
    }

    fun getFirebaseConfig(ctx: Context): String? {
        cachedFirebaseConfig?.let { return it }
        val v = prefs(ctx).getString(KEY_FIREBASE_CONFIG, null)
        cachedFirebaseConfig = v
        return v
    }
}
