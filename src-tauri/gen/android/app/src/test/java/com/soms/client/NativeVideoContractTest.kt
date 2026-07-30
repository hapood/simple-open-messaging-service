package com.soms.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeVideoContractTest {
    private val capability = "ab".repeat(32)

    @Test
    fun acceptsOnlyCapabilityScopedLocalhostRoutes() {
        assertTrue(
            NativeVideoContract.validLoopback(
                "http://localhost:43123/video/$capability",
                "video",
            ),
        )
        assertTrue(
            NativeVideoContract.validLoopback(
                "http://localhost:43123/thumbnail/$capability",
                "thumbnail",
            ),
        )
        assertFalse(
            NativeVideoContract.validLoopback(
                "http://127.0.0.1:43123/video/$capability",
                "video",
            ),
        )
        assertFalse(
            NativeVideoContract.validLoopback(
                "https://localhost:43123/video/$capability",
                "video",
            ),
        )
        assertFalse(
            NativeVideoContract.validLoopback(
                "http://localhost:43123/video/$capability?path=/uploads/secret",
                "video",
            ),
        )
    }

    @Test
    fun acceptsOnlyLowercaseSha256Digest() {
        assertTrue(NativeVideoContract.validDigest(capability))
        assertFalse(NativeVideoContract.validDigest(capability.uppercase()))
        assertFalse(NativeVideoContract.validDigest("abc"))
    }
}
