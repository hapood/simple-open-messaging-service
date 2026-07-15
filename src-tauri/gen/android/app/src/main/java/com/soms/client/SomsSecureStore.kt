package com.soms.client

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Encrypted-at-rest store for the three pieces of state the background poller (NotificationSyncWorker)
 * needs to survive across app process deaths — none of which the WebView/JS side can hand it at the
 * moment the worker fires (the WebView is suspended when the worker runs):
 *  - `notifToken`: the scoped 30-day credential from POST /auth/notification-token (Bearer on /missed).
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
 * values via the SomsFcm @JavascriptInterface (setNotificationToken / setApiOrigin); the worker only
 * reads. SomsMessagingService reads+writes the dedup cursor when it posts an FCM notification.
 */
object SomsSecureStore {
    private const val FILENAME = "soms_secure"

    /** The backend's global API version prefix, interpolated into every notification-path URL the
     *  background services build ([MessageSyncService], [NotificationSyncWorker], SomsMessagingService).
     *  Mirrors the web `apiPrefix` constant (`${apiOrigin()}/api/v1`) — Nest applies this prefix to every
     *  controller, so `/notifications/stream` is actually served at `/api/v1/notifications/stream`. A path
     *  without it 404s, which (being a non-401 failure) the FGS treats as transient and retries forever —
     *  the service stays up but never receives a frame. Keep this in sync with `constants.ts`. */
    const val API_PREFIX = "/api/v1"

    private const val KEY_NOTIF_TOKEN = "notif_token"
    private const val KEY_API_ORIGIN = "api_origin"
    private const val KEY_DEDUP_CURSOR = "dedup_cursor"
    private const val KEY_POLLING_ENABLED = "polling_enabled"
    private const val KEY_FGS_ENABLED = "fgs_enabled"
    private const val KEY_FCM_LAST_CHECK = "fcm_last_check"

    @Volatile
    private var cachedOrigin: String? = null

    private fun prefs(ctx: Context) = EncryptedSharedPreferences.create(
        ctx,
        FILENAME,
        MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun setNotificationToken(ctx: Context, token: String?) {
        val ed = prefs(ctx).edit()
        if (token.isNullOrEmpty()) ed.remove(KEY_NOTIF_TOKEN) else ed.putString(KEY_NOTIF_TOKEN, token)
        ed.apply()
    }

    fun getNotificationToken(ctx: Context): String? = prefs(ctx).getString(KEY_NOTIF_TOKEN, null)

    /** Whether the 6-hour background poller is enabled (default true). The WorkManager worker reads this
     *  on every fire to self-gate, so a toggle-off takes effect even for a process woken in the background
     *  before the WebView can cancel the schedule. JS flips it via SomsFcm.setPollingEnabled. */
    fun getPollingEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_POLLING_ENABLED, true)

    fun setPollingEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_POLLING_ENABLED, enabled).apply()
    }

    /** Whether the dataSync foreground service (MessageSyncService) is enabled. Default FALSE — opt-in,
     *  the more aggressive path (a persistent notification + held connection). The service starts on
     *  background only; this pref is the gate MainActivity.onStop checks. */
    fun getForegroundServiceEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_FGS_ENABLED, false)

    fun setForegroundServiceEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_FGS_ENABLED, enabled).apply()
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
