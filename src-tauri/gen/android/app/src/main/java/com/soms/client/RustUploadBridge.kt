package com.soms.client

/**
 * Thin JNI boundary into the shell-wide Rust uploader. Kotlin owns Android-only source discovery
 * (`content://`, permissions and metadata); descriptor ownership transfers to Rust at [uploadFd].
 */
object RustUploadBridge {
    external fun uploadFd(
        fd: Int,
        uploadId: String,
        attemptId: String,
        filename: String,
        mime: String,
        size: Long,
        fieldsJson: String,
        clientMessageId: String,
    )

    external fun cancelUpload(clientMessageId: String)

    external fun uploadVoicePath(
        path: String,
        contextId: Long,
        threadId: Long,
        clientMessageId: String,
        durationMs: Long,
        size: Long,
    )
}
