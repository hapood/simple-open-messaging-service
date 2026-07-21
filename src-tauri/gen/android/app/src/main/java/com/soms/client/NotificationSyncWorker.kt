package com.soms.client

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * The 国内 fallback push path. FCM is blocked in mainland China, so on devices where the FCM token
 * fetch fails (no google-services.json / no GMS / network), this WorkManager job periodically polls
 * `/notifications/missed` and renders the server-authored away-notification descriptor itself — giving the
 * "within a day, you'll be reminded" UX without any OEM/厂商 channel.
 *
 * Auth: the no-expiry session token (POST /auth/login, app client) — a single native credential shared
 * with the RealtimeService /events stream. Absent token ⇒ logged out ⇒ skip.
 *
 * Schedule: ~6h periodic (the floor for reliable background work; giving several chances per day).
 * WorkManager survives reboot and process death; it can't be started from background, so the initial
 * enqueue happens in MainActivity.onCreate (a foreground context). The worker self-skips when the
 * app is foregrounded (the user already sees messages in-app) and when the network is down.
 *
 * Delegates to [SomsMessagingService.renderAwayNotification] — the single fetch+render entry point shared
 * with the FCM + RealtimeService paths. The away-notification replaces at a stable id, so the three paths
 * never double-notify.
 */
class NotificationSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Honor the user's Settings → Background toggle. Checked here (not at schedule time) so the worker
        // self-gates even when a killed process is woken in the background before the WebView can cancel.
        if (!SomsSecureStore.getPollingEnabled(ctx)) return Result.success()
        // Skip when the user is already in-app — the SSE/in-app UI has it covered; don't double-notify.
        if (SomsMessagingService.appInForeground) return Result.success()

        // Fetch the server-authored descriptors + render ONE coalesced away-notification (the single entry
        // point shared with the FCM + RealtimeService paths). fetchDescriptors checks token/origin/auth and
        // returns null on any failure → no-op (WorkManager retries on the next period).
        try {
            SomsMessagingService.renderAwayNotification(ctx)
        } catch (e: Exception) {
            // Network failure / parse error — don't surface.
        }
        return Result.success()
    }
}
