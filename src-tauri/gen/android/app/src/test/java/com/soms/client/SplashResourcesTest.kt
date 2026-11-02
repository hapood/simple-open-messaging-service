package com.soms.client

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** Resource contract tests; first-frame timing and OEM splash behavior still need device testing. */
class SplashResourcesTest {
    private fun resource(path: String): Element = DocumentBuilderFactory.newInstance()
        .newDocumentBuilder()
        .parse(File("src/main/res/$path"))
        .documentElement

    private fun children(element: Element, tag: String): List<Element> =
        (0 until element.childNodes.length)
            .mapNotNull { element.childNodes.item(it) as? Element }
            .filter { it.tagName == tag }

    private fun launchTheme(path: String): Map<String, String> {
        val theme = children(resource(path), "style")
            .single { it.getAttribute("name") == "Theme.soms_desktop" }
        return children(theme, "item").associate {
            it.getAttribute("name") to it.textContent.trim()
        }
    }

    @Test
    fun legacyStartingWindowContainsTheSameCenteredVectorCanvasAsTheContinuation() {
        val theme = launchTheme("values/themes.xml")
        assertEquals("@drawable/splash_window", theme["android:windowBackground"])
        val layers = children(resource("drawable/splash_window.xml"), "item")
        assertEquals("@color/splash_background", layers.first().getAttribute("android:drawable"))
        val icon = layers.single { it.getAttribute("android:drawable") == "@drawable/splash_logo" }
        assertEquals("center", icon.getAttribute("android:gravity"))
        assertEquals("288dp", icon.getAttribute("android:width"))
        assertEquals("288dp", icon.getAttribute("android:height"))
        val vector = resource("drawable/splash_logo.xml")
        assertEquals("vector", vector.tagName)
        assertEquals(icon.getAttribute("android:width"), vector.getAttribute("android:width"))
        assertEquals(icon.getAttribute("android:height"), vector.getAttribute("android:height"))
    }

    @Test
    fun modernSystemSplashUsesTheVectorAndIsNotShadowedByANightTheme() {
        val theme = launchTheme("values-v31/themes.xml")
        assertEquals("@drawable/splash_logo", theme["android:windowSplashScreenAnimatedIcon"])
        assertEquals("@color/splash_background", theme["android:windowSplashScreenBackground"])
        assertEquals("@drawable/splash_window", theme["android:windowBackground"])
        // A night-qualified style would take precedence over the version-only style on dark devices.
        val nightThemes = File("src/main/res/values-night/themes.xml")
        if (nightThemes.exists()) {
            assertFalse(children(resource("values-night/themes.xml"), "style").any {
                it.getAttribute("name") == "Theme.soms_desktop"
            })
        }
    }

    @Test
    fun launchPaletteAndSystemBarsAdaptWithoutASeparateNightStyle() {
        listOf("values/themes.xml", "values-v31/themes.xml").forEach { path ->
            val theme = launchTheme(path)
            assertEquals("@bool/splash_light_system_bars", theme["android:windowLightStatusBar"])
            assertEquals("@bool/splash_light_system_bars", theme["android:windowLightNavigationBar"])
            assertEquals("false", theme["android:forceDarkAllowed"])
        }
        listOf("values" to "true", "values-night" to "false").forEach { (qualifier, lightBars) ->
            val bool = children(resource("$qualifier/bools.xml"), "bool")
                .single { it.getAttribute("name") == "splash_light_system_bars" }
            assertEquals(lightBars, bool.textContent)
            val colors = children(resource("$qualifier/colors.xml"), "color")
                .associate { it.getAttribute("name") to it.textContent }
            listOf("background", "text", "text_secondary", "text_status").forEach { name ->
                assertTrue("Missing $qualifier splash_$name", colors.containsKey("splash_$name"))
            }
            assertTrue(colors["splash_text"] != colors["splash_background"])
        }
        val vector = resource("drawable/splash_logo.xml")
        val paths = children(children(vector, "group").single(), "path")
        assertEquals("@color/splash_bubble", paths[0].getAttribute("android:fillColor"))
        assertEquals("@color/splash_outline", paths[0].getAttribute("android:strokeColor"))
        assertEquals("@color/splash_mark", paths[1].getAttribute("android:strokeColor"))
        assertEquals("@color/splash_accent", paths.last().getAttribute("android:fillColor"))
    }

    @Test
    fun logoKeepsItsBrandColorsInNightMode() {
        val defaults = children(resource("values/colors.xml"), "color")
            .associate { it.getAttribute("name") to it.textContent }
        val night = children(resource("values-night/colors.xml"), "color")
            .associate { it.getAttribute("name") to it.textContent }
        val brandColors = mapOf(
            "splash_bubble" to "#FFF8F4EC",
            "splash_outline" to "#FFBBAF9F",
            "splash_mark" to "#FF19212A",
            "splash_accent" to "#FFF04B3A",
        )
        brandColors.forEach { (name, color) ->
            assertEquals(color, defaults[name])
            assertFalse("Night mode must inherit $name instead of recoloring the logo", night.containsKey(name))
        }
        assertTrue(defaults["splash_background"] != night["splash_background"])
        assertTrue(defaults["splash_text"] != night["splash_text"])
    }

    @Test
    fun brandCopyUsesTheExistingLocalizedSloganRatherThanTheProductExpansion() {
        val expected = mapOf(
            "values" to "Open chat. Simple and instant.",
            "values-zh-rCN" to "开放聊天，简单即时。",
        )
        expected.forEach { (qualifier, slogan) ->
            val strings = children(resource("$qualifier/strings.xml"), "string")
            assertEquals(slogan, strings.single {
                it.getAttribute("name") == "splash_tagline"
            }.textContent)
            assertTrue(strings.any { it.getAttribute("name") == "app_name" })
        }
    }
}
