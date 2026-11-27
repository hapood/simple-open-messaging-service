import java.io.File
import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BuildTaskTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `debug invocation preserves root and arguments and reuses configuration cache`() {
        val fixture = fixture(release = false)
        val result = fixture.runner().build()
        assertInvocation(fixture, listOf("tauri", "android", "android-studio-script", "--target", "aarch64"))
        assertFalse(result.output.contains("has been deprecated"))

        val reused = fixture.runner().build()
        assertTrue(reused.output.contains("Reusing configuration cache"))
        assertInvocation(fixture, listOf("tauri", "android", "android-studio-script", "--target", "aarch64"))
    }

    @Test
    fun `release invocation preserves info verbosity and target ordering`() {
        val fixture = fixture(release = true)
        fixture.runner("--info").build()
        assertInvocation(
            fixture,
            listOf("tauri", "android", "android-studio-script", "-v", "--release", "--target", "aarch64"),
        )
    }

    @Test
    fun `nonzero CLI exit fails the task`() {
        val fixture = fixture(release = false, exitCode = 17)
        val result = fixture.runner().buildAndFail()
        assertTrue(result.output, result.output.contains("non-zero exit value 17"))
        assertInvocation(fixture, listOf("tauri", "android", "android-studio-script", "--target", "aarch64"))
    }

    private fun assertInvocation(fixture: Fixture, arguments: List<String>) {
        assertEquals(fixture.root.canonicalPath, File(fixture.root, "working-directory.txt").readText().trim())
        assertEquals(arguments, File(fixture.root, "arguments.txt").readLines())
    }

    private fun fixture(release: Boolean, exitCode: Int = 0): Fixture {
        assumeFalse(System.getProperty("os.name").startsWith("Windows"))
        val root = temporaryFolder.newFolder("cli-root")
        val project = File(root, "android/app").apply { mkdirs() }
        val bin = temporaryFolder.newFolder("bin")
        File(bin, "node").apply {
            writeText(
                """
                #!/bin/sh
                pwd > "${root.absolutePath}/working-directory.txt"
                printf '%s\n' "$@" > "${root.absolutePath}/arguments.txt"
                exit $exitCode
                """.trimIndent() + "\n",
            )
            check(setExecutable(true))
        }
        val pluginClasspath = GradleRunner.create().withPluginClasspath().pluginClasspath
            .joinToString(", ") { "\"${it.absolutePath}\"" }
        File(project, "settings.gradle").writeText("rootProject.name = 'build-task-fixture'\n")
        File(project, "build.gradle").writeText(
            """
            buildscript {
                dependencies {
                    classpath files($pluginClasspath)
                }
            }
            tasks.register('invokeCli', com.soms.desktop.kotlin.BuildTask) {
                rootDirRel = '../..'
                target = 'aarch64'
                release = $release
                executable = '${bin.absolutePath}/node'
            }
            """.trimIndent(),
        )
        return Fixture(root, project, bin)
    }

    private data class Fixture(val root: File, val project: File, val bin: File) {
        fun runner(vararg arguments: String): GradleRunner = GradleRunner.create()
            .withProjectDir(project)
            .withPluginClasspath()
            .withArguments(
                listOf(
                    "--configuration-cache",
                    "--warning-mode",
                    "fail",
                    "--stacktrace",
                    "invokeCli",
                ) + arguments,
            )
    }
}
