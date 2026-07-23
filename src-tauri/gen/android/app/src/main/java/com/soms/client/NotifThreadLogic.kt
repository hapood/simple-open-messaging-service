package com.soms.client

/**
 * Pure (Android-free) decisions for the per-thread notification path — extracted from
 * [SomsMessagingService]'s companion so they're JUnit-testable WITHOUT loading the
 * `FirebaseMessagingService` subclass (which needs Android). The per-thread STATE (the dismiss-HWM map, the
 * last-alert-seq map) stays in [SomsMessagingService]; this object holds only the stateless decisions.
 *
 * What lives here:
 *  - [notifId] — the stable per-thread notification id.
 *  - [shouldAlert] / [anyShouldAlert] — the #4 "re-alert only on first-sight or latestSeq-advance" rule.
 */
object NotifThreadLogic {

    /** The stable notification id for a per-thread card: `base + threadId` (base is offset clear of the
     *  reserved away/FGS/admin/summary ids + the JS seq range). */
    fun notifId(base: Int, threadId: Int): Int = base + threadId

    /** #4: a card re-alerts when first seen (no last-alert entry for the thread) OR its latestSeq advanced
     *  past the last seq we alerted. Same latestSeq → no re-alert (a re-fetch that changed nothing stays quiet). */
    fun shouldAlert(lastAlertSeq: Int?, latestSeq: Int): Boolean =
        lastAlertSeq == null || latestSeq > lastAlertSeq

    /** #4 aggregate: whether the group summary should alert this round — true if ANY card is first-seen or
     *  advanced (the summary is the sole alerter under GROUP_ALERT_SUMMARY, so this one bit gates the sound). */
    fun anyShouldAlert(cards: List<Pair<Int, Int>>, lastAlertSeq: Map<Int, Int>): Boolean =
        cards.any { (tid, seq) -> shouldAlert(lastAlertSeq[tid], seq) }
}
