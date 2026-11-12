package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class CallSignalingTest {
    private val candidate = "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host"

    private fun sdp(ufrag: String, video: Boolean = false, direction: String = "sendrecv",
                    videoPort: Int = 9): String = buildString {
        append("v=0\r\na=group:BUNDLE audio video\r\na=ice-ufrag:$ufrag\r\n")
        append("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=sendrecv\r\n")
        if (video) append("m=video $videoPort UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=$direction\r\n")
    }

    @Test fun iceUsernameFragmentUsesRfcBoundsAndCharacters() {
        assertTrue(CallSignaling.validIceUfrag("aB0+"))
        assertTrue(CallSignaling.validIceUfrag("/".repeat(256)))
        for (invalid in listOf("", "abc", "abcd ", "a_b-", "éabc", "a".repeat(257))) {
            assertFalse(CallSignaling.validIceUfrag(invalid))
        }
    }

    @Test fun localCandidatesUseActualMediaSectionCredentials() {
        val ice = CallSignaling.LocalIce()
        ice.remember(sdp("audioGen", true).replace("a=mid:video", "a=ice-ufrag:videoGen\r\na=mid:video"))
        assertEquals("audioGen", ice.identify(candidate, "audio", 0))
        assertEquals("videoGen", ice.identify(candidate, "video", 1))
        assertNull(ice.identify(candidate, "video", 0))
        assertNull(ice.identify(candidate, "unknown", 0))
        assertNull(ice.identify(candidate, null, -1))
    }

    @Test fun delayedOldCallbackCannotBeRelabeledAfterRestart() {
        val ice = CallSignaling.LocalIce()
        ice.remember(sdp("old"))
        val capturedBeforeRestart = ice.identify(candidate, "audio", 0)
        ice.remember(sdp("new"))
        assertEquals("old", capturedBeforeRestart) // Executor delay preserves captured identity.
        assertNull(ice.identify(candidate, "audio", 0)) // Callback itself delayed: ambiguous.
        assertEquals("old", ice.identify("$candidate ufrag old", "audio", 0))
        assertEquals("new", ice.identify("$candidate ufrag new", "audio", 0))
        assertNull(ice.identify("$candidate ufrag unknown", "audio", 0))
    }

    @Test fun gatheredDescriptionDeliversFreshExtensionFreeCandidatesAfterRestart() {
        val ice = CallSignaling.LocalIce()
        val old = sdp("oldA") + "a=$candidate\r\n"
        val fresh = sdp("newB") + "a=$candidate\r\n"
        ice.remember(old)
        ice.remember(fresh)
        assertNull(ice.identify(candidate, "audio", 0)) // A callback alone is still ambiguous.
        val gathered = ice.gathered(fresh).single()
        assertEquals("newB", gathered.ufrag)
        assertEquals(candidate, gathered.candidate)
        assertEquals("audio", gathered.mid)
        assertEquals(0, gathered.index)
        assertTrue(ice.claim(gathered.candidate, gathered.mid, gathered.index, gathered.ufrag))
        assertFalse(ice.claim(gathered.candidate, gathered.mid, gathered.index, gathered.ufrag))
        val prior = ice.gathered(old).single()
        assertEquals("oldA", prior.ufrag) // Even a delayed snapshot is not relabeled.
        assertTrue(ice.claim(prior.candidate, prior.mid, prior.index, prior.ufrag))
        assertTrue(ice.gathered(fresh + "a=$candidate ufrag oldA\r\n")
            .none { it.candidate.endsWith("ufrag oldA") })
    }

    @Test fun sameGenerationVideoRenegotiationRemainsSafe() {
        val ice = CallSignaling.LocalIce()
        ice.remember(sdp("same"))
        ice.remember(sdp("same", true))
        assertEquals("same", ice.identify(candidate, "audio", 0))
        assertEquals("same", ice.identify(candidate, "video", 1))
    }

    @Test fun reusedCandidateAddressIsNotGenerationEvidence() {
        val ice = CallSignaling.LocalIce()
        ice.remember(sdp("old") + "a=$candidate\r\n")
        ice.remember(sdp("new") + "a=$candidate\r\n")
        assertNull(ice.identify(candidate, "audio", 0))
    }

    @Test fun localGenerationHistoryFailsClosedAtBound() {
        val ice = CallSignaling.LocalIce()
        repeat(33) { ice.remember(sdp("gen$it")) }
        assertNull(ice.identify("$candidate ufrag gen0", "audio", 0))
    }

    @Test fun remoteGenerationOrdering() {
        val old = CallSignaling.sections(sdp("old"))
        val fresh = CallSignaling.sections(sdp("new"))
        assertEquals(CallSignaling.IceDecision.BUFFER,
            CallSignaling.remoteIce(emptyList(), emptySet(), "old", "audio", 0))
        assertEquals(CallSignaling.IceDecision.APPLY,
            CallSignaling.remoteIce(old, emptySet(), "old", "audio", 0))
        assertEquals(CallSignaling.IceDecision.BUFFER,
            CallSignaling.remoteIce(old, emptySet(), "new", "audio", 0))
        assertEquals(CallSignaling.IceDecision.APPLY,
            CallSignaling.remoteIce(fresh, setOf("old"), "new", "audio", 0))
        assertEquals(CallSignaling.IceDecision.DROP,
            CallSignaling.remoteIce(fresh, setOf("old"), "old", "audio", 0))
        assertEquals(CallSignaling.IceDecision.DROP,
            CallSignaling.remoteIce(fresh, emptySet(), null, "audio", 0))
        assertEquals(CallSignaling.IceDecision.DROP,
            CallSignaling.remoteIce(fresh, emptySet(), "", "audio", 0))
    }

    @Test fun remoteCandidatesRequireMatchingMidAndIndex() {
        val sections = CallSignaling.sections(sdp("same", true))
        assertEquals(CallSignaling.IceDecision.APPLY,
            CallSignaling.remoteIce(sections, emptySet(), "same", "video", 1))
        assertEquals(CallSignaling.IceDecision.BUFFER,
            CallSignaling.remoteIce(sections, emptySet(), "same", "video", 0))
        assertEquals(CallSignaling.IceDecision.BUFFER,
            CallSignaling.remoteIce(sections, emptySet(), "same", "absent", 1))
    }

    @Test fun bundleTransportCredentialsAreInherited() {
        val bundled = "v=0\r\na=group:BUNDLE audio video\r\n" +
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=ice-ufrag:bundle\r\n" +
            "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\n"
        assertEquals("bundle", CallSignaling.sections(bundled)[1].ufrag)
    }

    @Test fun calleeFirstVideoDoesNotRequireCallerCamera() {
        assertTrue(CallSignaling.videoNegotiated(sdp("ours", true, "recvonly"),
            sdp("theirs", true, "sendonly"), sending = false, receiving = true))
        assertFalse(CallSignaling.videoNegotiated(sdp("ours", true, "recvonly"),
            sdp("theirs", true, "recvonly"), sending = false, receiving = true))
        assertFalse(CallSignaling.videoNegotiated(sdp("ours", true, "recvonly"),
            sdp("theirs", true, "sendonly"), sending = true, receiving = true))
    }

    @Test fun rejectedOrInactiveVideoCannotCommitUpgrade() {
        assertFalse(CallSignaling.videoNegotiated(sdp("ours", true), sdp("theirs"), true, true))
        assertFalse(CallSignaling.videoNegotiated(sdp("ours", true),
            sdp("theirs", true, videoPort = 0), true, true))
        assertFalse(CallSignaling.videoNegotiated(sdp("ours", true),
            sdp("theirs", true, "inactive"), false, false))
        assertTrue(CallSignaling.videoNegotiated(sdp("ours", true), sdp("theirs", true), true, true))
    }
}
