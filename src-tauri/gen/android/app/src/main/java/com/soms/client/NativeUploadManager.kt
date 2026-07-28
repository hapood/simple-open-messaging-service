package com.soms.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Android's one-shot, privacy-scoped upload data plane.
 *
 * The system picker grants access to individual content:// URIs. Those bytes stay native:
 * ContentResolver streams them directly into OkHttp; the webview receives metadata, a small temporary
 * preview, progress, and the server response only.
 */
object NativeUploadManager {
    private const val PREVIEW_MAX_PX = 384
    private const val PREVIEW_QUALITY = 74

    private data class Selection(
        val uri: Uri,
        val name: String,
        val mime: String,
        val size: Long,
        val width: Int,
        val height: Int,
        val preview: String?,
        val duration: Double,
    )

    private val selections = ConcurrentHashMap<String, Selection>()
    private val calls = ConcurrentHashMap<String, Call>()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .build()

    fun accept(context: Context, uris: List<Uri>, requestedKind: String) {
        val items = JSONArray()
        for (uri in uris) {
            inspect(context, uri)?.let { selection ->
                val id = UUID.randomUUID().toString()
                selections[id] = selection
                items.put(JSONObject().apply {
                    put("uploadId", id)
                    put("kind", classify(selection.mime, requestedKind))
                    put("name", selection.name)
                    put("mimeType", selection.mime)
                    put("size", selection.size)
                    put("w", selection.width)
                    put("h", selection.height)
                    put("preview", selection.preview ?: JSONObject.NULL)
                    put("duration", selection.duration)
                })
            }
        }
        emit("__SOMS_UPLOAD_PICKED__", JSONObject().put("items", items))
    }

    fun discard(uploadId: String) {
        calls.remove(uploadId)?.cancel()
        selections.remove(uploadId)
    }

    fun cancel(uploadId: String) {
        calls.remove(uploadId)?.cancel()
    }

    fun upload(
        context: Context,
        uploadId: String,
        kind: String,
        clientMessageId: String?,
        fieldsJson: String?,
    ) {
        val selected = selections[uploadId] ?: return fail(uploadId, "selection expired")
        val origin = SomsSecureStore.getActiveOrigin(context) ?: return fail(uploadId, "origin missing")
        val token = SomsSecureStore.getSessionToken(context) ?: return fail(uploadId, "session missing")
        val endpoint = when (kind.lowercase()) {
            "image" -> "/upload"
            "video" -> "/upload/video"
            "file" -> "/upload/file"
            else -> return fail(uploadId, "unsupported upload kind")
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
        val fields = runCatching { JSONObject(fieldsJson ?: "{}") }.getOrElse { JSONObject() }
        for (key in fields.keys()) body.addFormDataPart(key, fields.optString(key))
        body.addFormDataPart(
            "file",
            selected.name,
            ContentUriBody(context, selected, uploadId),
        )
        val request = Request.Builder()
            .url("$origin${SomsSecureStore.API_PREFIX}$endpoint")
            .header("Authorization", "Bearer $token")
            .apply {
                if (!clientMessageId.isNullOrBlank()) {
                    header("x-client-message-id", clientMessageId)
                }
            }
            .post(body.build())
            .build()
        val call = http.newCall(request)
        calls[uploadId] = call
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: Call, e: java.io.IOException) {
                calls.remove(uploadId)
                if (!call.isCanceled()) fail(uploadId, e.message ?: "upload failed")
            }

            override fun onResponse(call: Call, response: Response) {
                calls.remove(uploadId)
                response.use {
                    val text = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        fail(uploadId, "HTTP ${it.code}: $text")
                    } else {
                        selections.remove(uploadId)
                        emit("__SOMS_UPLOAD_COMPLETED__", JSONObject().apply {
                            put("uploadId", uploadId)
                            put("response", runCatching { JSONObject(text) }.getOrElse { text })
                        })
                    }
                }
            }
        })
    }

    private class ContentUriBody(
        private val context: Context,
        private val selected: Selection,
        private val uploadId: String,
    ) : RequestBody() {
        override fun contentType() = selected.mime.toMediaTypeOrNull()
        override fun contentLength() = selected.size

        override fun writeTo(sink: BufferedSink) {
            context.contentResolver.openInputStream(selected.uri).use { input ->
                requireNotNull(input) { "selected content is unavailable" }
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var sent = 0L
                var read: Int
                while (input.read(buffer).also { read = it } != -1) {
                    sink.write(buffer, 0, read)
                    sent += read
                    emit("__SOMS_UPLOAD_PROGRESS__", JSONObject().apply {
                        put("uploadId", uploadId)
                        put("loaded", sent)
                        put("total", selected.size)
                    })
                }
            }
        }
    }

    private fun inspect(context: Context, uri: Uri): Selection? = runCatching {
        var name = "attachment"
        var size = -1L
        context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    .takeIf { it >= 0 }?.let { name = cursor.getString(it) ?: name }
                cursor.getColumnIndex(OpenableColumns.SIZE)
                    .takeIf { it >= 0 && !cursor.isNull(it) }?.let { size = cursor.getLong(it) }
            }
        }
        val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
        val media = when {
            mime.startsWith("image/") -> decodeImagePreview(context, uri)
            mime.startsWith("video/") -> decodeVideoPreview(context, uri)
            else -> null
        }
        val bitmap = media?.bitmap
        val width = media?.width ?: 0
        val height = media?.height ?: 0
        val duration = media?.duration ?: 0.0
        val preview = bitmap?.let {
            val bytes = ByteArrayOutputStream()
            val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Bitmap.CompressFormat.WEBP_LOSSY
            } else {
                @Suppress("DEPRECATION")
                Bitmap.CompressFormat.WEBP
            }
            it.compress(format, PREVIEW_QUALITY, bytes)
            it.recycle()
            "data:image/webp;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        }
        Selection(uri, name, mime, size, width, height, preview, duration)
    }.getOrNull()

    private data class Preview(val bitmap: Bitmap, val width: Int, val height: Int, val duration: Double = 0.0)

    private fun decodeImagePreview(context: Context, uri: Uri): Preview? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
        var width = 0
        var height = 0
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) {
                decoder, info, _ ->
            width = info.size.width
            height = info.size.height
            val longest = max(info.size.width, info.size.height)
            if (longest > PREVIEW_MAX_PX) {
                val scale = PREVIEW_MAX_PX.toFloat() / longest
                decoder.setTargetSize(
                    max(1, (info.size.width * scale).toInt()),
                    max(1, (info.size.height * scale).toInt()),
                )
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        return Preview(bitmap, width, height)
    }

    private fun decodeVideoPreview(context: Context, uri: Uri): Preview? = runCatching {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, uri)
            val encodedWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val encodedHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val width = if (rotation == 90 || rotation == 270) encodedHeight else encodedWidth
            val height = if (rotation == 90 || rotation == 270) encodedWidth else encodedHeight
            val duration = (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0
            val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: return@runCatching null
            val longest = max(frame.width, frame.height)
            val scaled = if (longest > PREVIEW_MAX_PX) {
                val scale = PREVIEW_MAX_PX.toFloat() / longest
                Bitmap.createScaledBitmap(
                    frame,
                    max(1, (frame.width * scale).toInt()),
                    max(1, (frame.height * scale).toInt()),
                    true,
                ).also { if (it !== frame) frame.recycle() }
            } else frame
            Preview(scaled, width, height, duration)
        } finally {
            retriever.release()
        }
    }.getOrNull()

    private fun classify(mime: String, requested: String): String = when {
        requested == "image" && mime.startsWith("image/") -> "image"
        mime.startsWith("video/") -> "video"
        else -> "file"
    }

    private fun fail(uploadId: String, message: String) {
        emit("__SOMS_UPLOAD_FAILED__", JSONObject().put("uploadId", uploadId).put("message", message))
    }

    private fun emit(callback: String, payload: JSONObject) {
        SomsBridge.eval("window.$callback && window.$callback(${payload});")
    }
}
