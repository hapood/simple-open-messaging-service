package com.soms.client

import org.json.JSONObject

/** Android presentation model assembled from the native thread-feed result. */
data class NotifMessage(
    val seq: Int,
    val senderId: Int,
    val senderName: String,
    val text: String,
    val timestamp: Long,
    val senderKey: String = senderId.toString(),
    val avatar: ByteArray? = null,
)

data class NotifDescriptor(
    val tag: String,
    val kind: String,
    val title: String,
    val body: String,
    /** Unread count represented by this notification, independent of dismissal. */
    val count: Int,
    val lang: String,
    val renotify: Boolean,
    /** Optional reason for elevated visual treatment; copy remains server-authored. */
    val attention: String?,
    val silent: Boolean?,
    val messages: List<NotifMessage>,
    val previewMode: String,
    val data: JSONObject,
)
