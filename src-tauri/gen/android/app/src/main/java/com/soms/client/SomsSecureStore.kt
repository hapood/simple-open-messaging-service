package com.soms.client

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Encrypted-at-rest store for the three pieces of state the background poller (NotificationSyncWorker)
 * needs to survive across app process deaths — none of which the WebView/JS side can hand it at the
 * moment the worker fires (the WebView is suspended when the worker runs):
 *  - `sessionToken`: the no-expiry session credential from POST /auth/login (Bearer on /events + /missed).
 *  - `apiOrigin`: the backend base URL the user configured (mirrors the web `apiOrigin`).
 *  - `dedupCursor`: per-thread "last notified latestMessageId" — shared with SomsMessagingService so
 *    FCM (real-time, 海外) and WorkManager (periodic, 国内) never double-notify the same message.
 *  - `pollingEnabled`: the user's Settings → Background toggle (default true). The worker reads it on
 *    every fire to self-gate; JS flips it via SomsFcm.setPollingEnabled (which also cancels / re-enqueues
 *    the schedule). Stored here rather than JS localStorage precisely because the worker fires with no
 *    WebView alive to read localStorage.
 *
 * EncryptedSharedPreferences (AES256-GCM) is the documented Android best practice for credentials at
 * rest; for a scoped/short-lived token this is belt-and-braces but cheap. The JS side pushes these
 * values via the SomsFcm @JavascriptInterface (setSessionToken / setApiOrigin); the worker only
 * reads. SomsMessagingService reads+writes the dedup cursor when it posts an FCM notification.
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
    private const val KEY_API_ORIGIN = "api_origin"
    private const val KEY_DEDUP_CURSOR = "dedup_cursor"
    private const val KEY_POLLING_ENABLED = "polling_enabled"
    private const val KEY_FGS_ENABLED = "fgs_enabled"
    private const val KEY_FCM_LAST_CHECK = "fcm_last_check"
    private const val KEY_FIREBASE_CONFIG = "firebase_config"
    private const val KEY_NOTIF_PERM_REQUESTED = "notif_perm_requested"

    @Volatile
    private var cachedOrigin: String? = null

    @Volatile
    private var cachedFirebaseConfig: String? = null

    private fun prefs(ctx: Context) = EncryptedSharedPreferences.create(
        ctx,
        FILENAME,
        MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    /** The no-expiry session token (POST /auth/login, app client) — the single native credential that
     *  authenticates the Kotlin-owned /events stream AND the background `/notifications/missed` fetches
     *  (FGS / FCM / WorkManager). Supersedes the scoped 30-day notification token; revocation-only (no
     *  client-side expiry), mirroring Telegram's auth_key model. JS pushes it via SomsFcm.setSessionToken
     *  on login and clears it on logout. */
    fun setSessionToken(ctx: Context, token: String?) {
        val ed = prefs(ctx).edit()
        if (token.isNullOrEmpty()) ed.remove(KEY_SESSION_TOKEN) else ed.putString(KEY_SESSION_TOKEN, token)
        ed.apply()
    }

    fun getSessionToken(ctx: Context): String? = prefs(ctx).getString(KEY_SESSION_TOKEN, null)

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

    /** The web side hands us the same origin it resolved (from window.__SOMS_API_ORIGIN__). We also
     *  cache it in-memory so the worker's first read after process launch doesn't pay for a file hit. */
    fun setApiOrigin(ctx: Context, origin: String?) {
        cachedOrigin = origin?.trim()?.takeIf { it.isNotEmpty() }
        val ed = prefs(ctx).edit()
        if (cachedOrigin == null) ed.remove(KEY_API_ORIGIN) else ed.putString(KEY_API_ORIGIN, cachedOrigin)
        ed.apply()
    }

    fun getApiOrigin(ctx: Context): String? {
        cachedOrigin?.let { return it }
        val v = prefs(ctx).getString(KEY_API_ORIGIN, null)?.trim()?.takeIf { it.isNotEmpty() }
        cachedOrigin = v
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

    /** Read the per-thread dedup cursor (threadId → last-notified latestMessageId). Returns an empty
     *  map on first run / parse failure. The worker compares each thread's current latestMessageId
     *  against this and only notifies when it advances. */
    fun getDedupCursor(ctx: Context): Map<String, String> {
        val raw = prefs(ctx).getString(KEY_DEDUP_CURSOR, null) ?: return emptyMap()
        return try {
            val obj = JSONObject(raw)
            val out = HashMap<String, String>()
            for (key in obj.keys()) out[key] = obj.getString(key)
            out
        } catch (e: Exception) {
            emptyMap()
        }
    }

    fun setDedupCursor(ctx: Context, cursor: Map<String, String>) {
        val obj = JSONObject()
        for ((k, v) in cursor) obj.put(k, v)
        prefs(ctx).edit().putString(KEY_DEDUP_CURSOR, obj.toString()).apply()
    }

    /** Advance a single thread's cursor to `latestMessageId` only if it's newer (lexicographic on
     *  equal-length numeric strings — the BigInt ids are monotonic and same-length within a thread's
     *  active life, so string compare is correct here; full numeric compare would be overkill). */
    fun advanceCursor(ctx: Context, threadId: String, latestMessageId: String) {
        val cursor = HashMap(getDedupCursor(ctx))
        val prev = cursor[threadId]
        if (prev == null || prev.length < latestMessageId.length || (prev.length == latestMessageId.length && prev < latestMessageId)) {
            cursor[threadId] = latestMessageId
            setDedupCursor(ctx, cursor)
        }
    }
}
