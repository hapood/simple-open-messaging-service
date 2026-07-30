package com.soms.client

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Full-screen native player for chat videos.
 *
 * The web layer passes only a server-relative CAS path and its digest. Native reconstructs the URL from
 * the currently-active trusted origin and reads the bearer token from encrypted storage, so neither an
 * arbitrary URL nor credentials cross the JS bridge. The first successfully rendered frame is captured
 * once into the app cache; no thumbnail-only network request is ever made.
 */
class VideoPlayerActivity : AppCompatActivity(), Player.Listener {
    private lateinit var playerView: PlayerView
    private var player: ExoPlayer? = null
    private var digest: String = ""
    private var thumbnailStarted = false
    private var playbackPosition = 0L
    private var playWhenReady = true
    private var streamUrl = ""
    private var thumbnailUploadUrl = ""
    private var alreadyHasThumbnail = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_video_player)
        playerView = findViewById(R.id.video_player)
        digest = intent.getStringExtra(EXTRA_DIGEST).orEmpty()
        playbackPosition = savedInstanceState?.getLong(STATE_POSITION) ?: 0L
        playWhenReady = savedInstanceState?.getBoolean(STATE_PLAY_WHEN_READY) ?: true

        streamUrl = intent.getStringExtra(EXTRA_STREAM_URL).orEmpty()
        thumbnailUploadUrl = intent.getStringExtra(EXTRA_THUMBNAIL_UPLOAD_URL).orEmpty()
        alreadyHasThumbnail = intent.getBooleanExtra(EXTRA_HAS_THUMBNAIL, false)
        if (!NativeVideoContract.validLoopback(streamUrl, "video") ||
            !NativeVideoContract.validLoopback(thumbnailUploadUrl, "thumbnail") ||
            !NativeVideoContract.validDigest(digest)
        ) {
            Toast.makeText(this, R.string.video_playback_failed, Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        findViewById<View>(R.id.video_retry).setOnClickListener { retryPlayback() }
        findViewById<View>(R.id.video_back).setOnClickListener { finish() }
        val httpFactory = OkHttpDataSource.Factory(httpClient)
        val dataSourceFactory = DefaultDataSource.Factory(this, httpFactory)
        val exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build()
        player = exoPlayer
        playerView.player = exoPlayer
        exoPlayer.addListener(this)
        exoPlayer.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            true,
        )
        exoPlayer.setMediaItem(MediaItem.fromUri(streamUrl))
        exoPlayer.seekTo(playbackPosition)
        exoPlayer.playWhenReady = playWhenReady
        exoPlayer.prepare()
    }

    override fun onRenderedFirstFrame() {
        if (thumbnailStarted || alreadyHasThumbnail) return
        thumbnailStarted = true
        val surface = playerView.videoSurfaceView as? SurfaceView ?: return
        if (surface.width <= 0 || surface.height <= 0) return
        val bitmap = Bitmap.createBitmap(surface.width, surface.height, Bitmap.Config.ARGB_8888)
        PixelCopy.request(surface, bitmap, { result ->
            if (result != PixelCopy.SUCCESS) {
                bitmap.recycle()
                return@request
            }
            thumbnailExecutor.execute { uploadThumbnail(bitmap) }
        }, Handler(Looper.getMainLooper()))
    }

    private fun uploadThumbnail(source: Bitmap) {
        try {
            val longest = max(source.width, source.height)
            val scale = minOf(1f, THUMBNAIL_MAX_PX.toFloat() / longest)
            val output = if (scale < 1f) {
                Bitmap.createScaledBitmap(
                    source,
                    max(1, (source.width * scale).toInt()),
                    max(1, (source.height * scale).toInt()),
                    true,
                )
            } else {
                source
            }
            val bytes = ByteArrayOutputStream()
            bytes.use {
                val format = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                    Bitmap.CompressFormat.WEBP_LOSSY
                } else {
                    @Suppress("DEPRECATION")
                    Bitmap.CompressFormat.WEBP
                }
                output.compress(format, THUMBNAIL_QUALITY, it)
            }
            val request = Request.Builder()
                .url(thumbnailUploadUrl)
                .post(bytes.toByteArray().toRequestBody("image/webp".toMediaType()))
                .build()
            val saved = httpClient.newCall(request).execute().use { it.isSuccessful }
            if (output !== source) output.recycle()
            source.recycle()
            if (saved) {
                alreadyHasThumbnail = true
                SomsBridge.eval(
                    "window.__SOMS_VIDEO_THUMBNAIL__&&window.__SOMS_VIDEO_THUMBNAIL__(" +
                        SomsBridge.jsonStr(digest) + ");",
                )
            }
        } catch (error: Exception) {
            source.recycle()
            SomsLog.w("Video") { "thumbnail write failed: ${error.message}" }
        }
    }

    override fun onPlayerError(error: PlaybackException) {
        SomsLog.w("Video") { "playback failed code=${error.errorCode}: ${error.message}" }
        val message = when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                R.string.video_network_failed
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
                R.string.video_forbidden
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ->
                R.string.video_unsupported
            else -> R.string.video_playback_failed
        }
        findViewById<TextView>(R.id.video_error_message).setText(message)
        findViewById<View>(R.id.video_error).visibility = View.VISIBLE
    }

    private fun retryPlayback() {
        findViewById<View>(R.id.video_error).visibility = View.GONE
        player?.apply {
            prepare()
            play()
        }
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        player?.let {
            outState.putLong(STATE_POSITION, it.currentPosition)
            outState.putBoolean(STATE_PLAY_WHEN_READY, it.playWhenReady)
        }
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        playerView.player = null
        player?.release()
        player = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_STREAM_URL = "video_stream_url"
        const val EXTRA_THUMBNAIL_UPLOAD_URL = "video_thumbnail_upload_url"
        const val EXTRA_HAS_THUMBNAIL = "video_has_thumbnail"
        const val EXTRA_DIGEST = "video_digest"
        private const val STATE_POSITION = "position"
        private const val STATE_PLAY_WHEN_READY = "play_when_ready"
        private const val THUMBNAIL_MAX_PX = 384
        private const val THUMBNAIL_QUALITY = 74
        private val thumbnailExecutor = Executors.newSingleThreadExecutor()
        private val httpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
