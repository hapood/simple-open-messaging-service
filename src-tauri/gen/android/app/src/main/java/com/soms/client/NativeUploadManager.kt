package com.soms.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
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
    private val selectionExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "SomsUploadInspect").apply { isDaemon = true }
    }

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

    fun pickerReturned(requestId: String) {
        emit("__SOMS_UPLOAD_INSPECTING__", JSONObject().put("requestId", requestId))
    }

    fun accept(context: Context, uris: List<Uri>, requestedKind: String, requestId: String) {
        accept(context, uris, requestedKind) { items ->
            emit(
                "__SOMS_UPLOAD_PICKED__",
                JSONObject().put("requestId", requestId).put("items", items),
            )
        }
    }

    /** Inspect original URI references received by the native composer, using the same platform
     * metadata adapter as picker selections. Durable task ownership remains outside this adapter. */
    fun acceptForComposer(
        context: Context,
        uris: List<Uri>,
        requestedKind: String,
        deliver: (JSONArray) -> Unit,
    ) {
        accept(context, uris, requestedKind, deliver)
    }

    private fun accept(
        context: Context,
        uris: List<Uri>,
        requestedKind: String,
        deliver: (JSONArray) -> Unit,
    ) {
        // Activity-result callbacks run on the main thread. ImageDecoder, MediaMetadataRetriever,
        // first-frame extraction, WebP compression, and Base64 encoding can all block on a large or
        // provider-backed URI, so keep the entire inspection batch off the UI thread.
        val appContext = context.applicationContext
        selectionExecutor.execute {
            val items = JSONArray()
            for (uri in uris) {
                // Keep the provider reference, never copy selected bytes into an app staging file.
                // Some providers grant only temporary access; those selections remain usable now
                // but may require reselection after process restart.
                try {
                    appContext.contentResolver.takePersistableUriPermission(
                        uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                } catch (_: SecurityException) {
                    // The provider did not offer a persistable grant.
                } catch (_: UnsupportedOperationException) {
                    // This provider supports only the current picker grant.
                }
                inspect(appContext, uri)?.let { selection ->
                    val id = UUID.randomUUID().toString()
                    items.put(JSONObject().apply {
                        put("partId", id)
                        put("path", selection.uri.toString())
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
            deliver(items)
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
        (requested == "image" || requested == "auto") && mime.startsWith("image/") -> "image"
        mime.startsWith("video/") -> "video"
        else -> "file"
    }

    private fun emit(callback: String, payload: JSONObject) {
        SomsBridge.eval("window.$callback && window.$callback(${payload});")
    }
}
