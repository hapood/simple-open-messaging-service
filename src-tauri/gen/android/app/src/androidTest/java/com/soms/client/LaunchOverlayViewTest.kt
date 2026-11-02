package com.soms.client

import android.content.res.Configuration
import android.graphics.Rect
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
class LaunchOverlayViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun localizedTextKeepsItsFullMeasuredHeightAtNormalAndLargeFontScales() {
        instrumentation.runOnMainSync {
            for (language in listOf("zh-CN", "en")) {
                for (scale in listOf(1f, 1.5f, 2f)) {
                    val context = instrumentation.targetContext.createConfigurationContext(
                        Configuration(instrumentation.targetContext.resources.configuration).apply {
                            setLocale(Locale.forLanguageTag(language))
                            fontScale = scale
                        },
                    )
                    val overlay = LaunchOverlayView(context, false)
                    val density = context.resources.displayMetrics.density
                    // Phone-width layout forces long localized text to wrap at large font scales.
                    layout(overlay, (320 * density).roundToInt(), (800 * density).roundToInt())
                    val tagline = overlay.tagline
                    assertTrue("$language / $scale font padding", tagline.includeFontPadding)
                    assertEquals(tagline.layout.height + tagline.compoundPaddingTop + tagline.compoundPaddingBottom,
                        tagline.height)
                    assertTrue("$language / $scale brand clips tagline", tagline.bottom <= overlay.brand.height)
                    assertTrue("$language / $scale overlay clips brand", overlay.brand.bottom < overlay.height)
                    assertEquals(0f, overlay.brand.alpha)
                    if (tagline.layout.lineCount == 1) {
                        val ink = Rect()
                        tagline.paint.getTextBounds(tagline.text.toString(), 0, tagline.text.length, ink)
                        val inkCenter = overlay.brand.left + tagline.left + tagline.translationX +
                            tagline.compoundPaddingLeft + tagline.layout.getLineLeft(0) + ink.exactCenterX()
                        assertEquals("$language / $scale visible tagline center",
                            (overlay.logo.left + overlay.logo.right) / 2f, inkCenter, 1f)
                    }
                }
            }
        }
    }

    @Test
    fun capturedSystemBoundsSurvivePaletteAndTextChangesWithoutMovingTheIcon() {
        instrumentation.runOnMainSync {
            val overlay = LaunchOverlayView(instrumentation.targetContext, false)
            val bounds = Rect(211, 407, 811, 1007)
            overlay.alignSystemIcon(bounds)
            layout(overlay, 1200, 1800)
            assertEquals(bounds, Rect(overlay.logo.left, overlay.logo.top, overlay.logo.right, overlay.logo.bottom))
            assertEquals(0f, overlay.logo.translationY)
            overlay.applyPalette(true)
            overlay.status.text = "Loading configuration"
            layout(overlay, 1200, 1800)
            assertEquals(bounds, Rect(overlay.logo.left, overlay.logo.top, overlay.logo.right, overlay.logo.bottom))
            assertEquals(0f, overlay.brand.alpha)
        }
    }

    @Test
    fun lateSystemHandoffResetsFallbackPresentationBeforeApplyingAuthoritativeBounds() {
        instrumentation.runOnMainSync {
            val overlay = LaunchOverlayView(instrumentation.targetContext, false)
            layout(overlay, 1200, 1800)
            overlay.logo.translationY = -60f
            overlay.brand.alpha = 1f
            overlay.prepareSystemHandoff()
            val bounds = Rect(360, 660, 840, 1140)
            overlay.alignSystemIcon(bounds)
            layout(overlay, 1200, 1800)
            assertEquals(0f, overlay.logo.translationY)
            assertEquals(0f, overlay.brand.alpha)
            assertEquals(bounds, Rect(overlay.logo.left, overlay.logo.top, overlay.logo.right, overlay.logo.bottom))
        }
    }

    @Test
    fun wrappedBrandLinesShareTheSystemIconCenter() {
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext.createConfigurationContext(
                Configuration(instrumentation.targetContext.resources.configuration).apply {
                    setLocale(Locale.forLanguageTag("zh-CN"))
                },
            )
            val overlay = LaunchOverlayView(context, false)
            // The brand lines must stay centered relative to the system icon regardless of any
            // ambient alignment: the TextViews pin explicit CENTER (inheriting a VIEW_START default
            // from the decor would left-align every line and break this invariant).
            assertEquals(View.TEXT_ALIGNMENT_CENTER, overlay.title.textAlignment)
            assertEquals(View.TEXT_ALIGNMENT_CENTER, overlay.tagline.textAlignment)
            overlay.tagline.text = "开放聊天，\n简单即时。"
            // The system icon need not be centered in the edge-to-edge decor's coordinate space.
            overlay.alignSystemIcon(Rect(211, 407, 811, 1007))
            layout(overlay, 1200, 1800)
            val iconCenter = (overlay.logo.left + overlay.logo.right) / 2f
            for (text in listOf(overlay.title, overlay.tagline)) {
                val textLayout = text.layout
                for (line in 0 until textLayout.lineCount) {
                    val lineCenter = overlay.brand.left + text.left + text.compoundPaddingLeft +
                        (textLayout.getLineLeft(line) + textLayout.getLineRight(line)) / 2f
                    assertEquals("${text.text}: line $line must align with icon", iconCenter, lineCenter, 1f)
                }
            }
        }
    }

    @Test
    fun legacyCanvasIsCenteredIndependentlyOfBrandText() {
        instrumentation.runOnMainSync {
            val overlay = LaunchOverlayView(instrumentation.targetContext, false)
            layout(overlay, 1200, 1800)
            val size = (288 * overlay.resources.displayMetrics.density).roundToInt()
            assertEquals(size, overlay.logo.width)
            assertEquals((1200 - size) / 2, overlay.logo.left)
            assertEquals((1800 - size) / 2, overlay.logo.top)
            overlay.tagline.text = "A longer localized tagline\nwith several lines\nand full descenders: gjpqy"
            layout(overlay, 1200, 1800)
            assertEquals((1800 - size) / 2, overlay.logo.top)
            assertTrue(overlay.tagline.bottom <= overlay.brand.height)
        }
    }

    @Test
    fun statusClearsTheNavigationBarInset() {
        instrumentation.runOnMainSync {
            val overlay = LaunchOverlayView(instrumentation.targetContext, false)
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 96))
                .build()
                .toWindowInsets()!!
            overlay.onApplyWindowInsets(insets)
            layout(overlay, 1200, 1800)
            val bottomPadding = (28 * overlay.resources.displayMetrics.density).roundToInt()
            assertEquals(1800 - bottomPadding - 96, overlay.status.bottom)
        }
    }

    private fun layout(view: View, width: Int, height: Int) {
        view.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, width, height)
    }
}
