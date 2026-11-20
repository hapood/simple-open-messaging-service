package com.soms.client

/**
 * Thin JNI boundary into the shell-wide Rust uploader. Kotlin owns Android-only source discovery
 * (`content://`, permissions and metadata); descriptor ownership transfers to Rust at [uploadFd].
 */
object RustUploadBridge {
    private var sourceContext: android.content.Context? = null

    fun initializeSourceAccess(context: android.content.Context) {
        sourceContext = context.applicationContext
        bindSourceAdapter()
    }

    private external fun bindSourceAdapter()

    /** Transfers one OS descriptor to Rust; does not start or manage an upload. */
    fun openSource(path: String): Int {
        val context = sourceContext ?: return -1
        return try {
            val uri = android.net.Uri.parse(path)
            if (uri.scheme != "content" && uri.scheme != "file") return -1
            context.contentResolver.openFileDescriptor(uri, "r")?.use { it.detachFd() } ?: -1
        } catch (_: Exception) { -1 }
    }

    /** Streams an authenticated media response into a destination descriptor. Empty result means success. */
    external fun streamMediaToFd(path: String, fd: Int, taskId: String): String

    external fun uploadVoicePath(
        path: String,
        contextId: Long,
        threadId: Long,
        clientMessageId: String,
        durationMs: Long,
        size: Long,
    )
}
