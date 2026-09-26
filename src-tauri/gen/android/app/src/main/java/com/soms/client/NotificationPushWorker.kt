package com.soms.client

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters

/** Run a high-priority FCM notification wake outside FirebaseMessagingService's short callback window.
 * This does not change the periodic fallback schedule or start a dataSync foreground service. */
class NotificationPushWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    // WorkManager can implement expedited work as a foreground service on pre-Android 12 devices.
    override suspend fun getForegroundInfo(): ForegroundInfo = ForegroundInfo(
        PUSH_WORK_NOTIF_ID,
        SomsMessagingService.buildForegroundNotification(applicationContext),
    )

    override suspend fun doWork(): Result {
        val target = inputData.getInt(KEY_TARGET, -1)
        if (target < 0) return Result.success()
        if (SomsMessagingService.appInForeground)
            SomsMessagingService.renderForegroundNotification(applicationContext, target)
        else
            SomsMessagingService.renderAwayNotification(applicationContext, allowAlert = true, threadFeedEndId = target)
        return Result.success()
    }

    companion object {
        private const val KEY_TARGET = "threadFeedEndId"
        private const val PUSH_WORK_NOTIF_ID = 0x9

        fun enqueue(ctx: Context, target: Int) {
            val request = OneTimeWorkRequestBuilder<NotificationPushWorker>()
                .setInputData(Data.Builder().putInt(KEY_TARGET, target).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(ctx).enqueue(request)
        }
    }
}
