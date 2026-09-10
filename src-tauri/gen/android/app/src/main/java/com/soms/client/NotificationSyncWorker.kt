package com.soms.client

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** Periodic fallback wake. Rust discovers the current thread-feed head and consumes
 * the same durable cursor used by FCM, SSE, and ordinary in-app synchronization. */
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

        // Failures wait for the next wake; no immediate WorkManager retry.
        try {
            SomsMessagingService.renderAwayNotification(ctx, allowAlert = true)
        } catch (e: Exception) {
            // Network failure / parse error — don't surface.
        }
        return Result.success()
    }
}
