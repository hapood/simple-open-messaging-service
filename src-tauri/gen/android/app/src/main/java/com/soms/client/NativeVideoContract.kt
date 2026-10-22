package com.soms.client

import java.net.URI

/** Pure validation shared by the Activity and JVM tests; arbitrary URLs never cross into Media3. */
object NativeVideoContract {
    private val DIGEST = Regex("^[0-9a-f]{64}$")

    fun validDigest(value: String): Boolean = DIGEST.matches(value)

    fun validLoopback(value: String, route: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme == "http" &&
            uri.host == "localhost" &&
            uri.port in 1..65535 &&
            Regex("^/$route/[0-9a-f]{64}$").matches(uri.path.orEmpty()) &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            uri.userInfo == null
    }.getOrDefault(false)
}
