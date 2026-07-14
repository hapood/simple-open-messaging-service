package com.soms.client

import android.app.AlertDialog
import android.content.Intent
import android.os.Process
import android.text.InputType
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import java.io.File
import java.net.URI

/**
 * Native dev-tools dialog opened from [DevToolsBubble]. PURE NATIVE UI on purpose: it is reachable
 * even when the webview is stuck on a dead dev-server error page (the bubble floats above it), so the
 * user can always fix the URL or bail to the bundle. The dialog owns the persisted `dev_url` file
 * (the same file Rust reads at boot — see `src-tauri/src/lib.rs`) and drives the live webview via
 * [SomsBridge.eval] (location.replace / location.reload). No Rust commands, no JS bridge — the web
 * app has no part in this.
 *
 * Actions:
 *  - Connect: validate http(s) → write `dev_url` → `location.replace` the webview (immediate, and
 *    sticks for next launch because the file persists).
 *  - Reload: `location.reload()` (full refresh; the dialog stays open so it can be tapped repeatedly).
 *  - Revert: delete `dev_url` → kill the process so Rust re-resolves to the bundled frontend.
 *
 * Debug-only by construction: the bubble that opens it is debug-gated. See FCM_ANDROID_PATCH.md.
 */
class DevToolsDialog(private val activity: MainActivity) {

    /** The persisted dev-URL file Rust reads at boot (src-tauri/src/lib.rs reads `app_data_dir()/dev_url`).
     *  On Android Tauri's `app_data_dir()` is the app's data-dir ROOT (/data/data/<pkg>/) — the api_origin
     *  file Rust writes lands there too — NOT filesDir (/data/data/<pkg>/files/). So we resolve the same
     *  ROOT via `Context.dataDir` (API 24 == minSdk), NOT `filesDir` (the previous value wrote to a file
     *  Rust never read, so a Connect'd URL never persisted across launches). Filename must match Rust's
     *  DEV_URL_FILENAME. */
    private val devUrlFile: File = activity.dataDir.resolve(DEV_URL_FILENAME)

    fun show() {
        val urlInput = EditText(activity).apply {
            hint = "http://192.168.2.7:4200"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            // Pre-fill with the webview's current URL when it is already a remote dev server.
            val cur = SomsBridge.webView?.url
            if (cur != null && (cur.startsWith("http://") || cur.startsWith("https://"))) setText(cur)
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(12), dp(24), dp(4))
            addView(
                urlInput,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle("SOMS dev tools")
            .setMessage("Frontend dev server (your `ng serve --host 0.0.0.0` address).")
            .setView(container)
            .setPositiveButton("Connect") { _, _ -> connect(urlInput.text.toString().trim()) }
            .setNegativeButton("Revert") { _, _ -> revert() }
            .setNeutralButton("Reload", null) // overridden after show() so it does NOT auto-dismiss
            .create()
        dialog.show()
        // Reload keeps the dialog open (repeatable); Connect/Revert dismiss as usual.
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { reload() }
    }

    /** Validate + persist + navigate the webview to the typed dev server immediately. */
    private fun connect(raw: String) {
        if (raw.isEmpty()) {
            toast("Enter a URL")
            return
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            toast("URL must start with http:// or https://")
            return
        }
        try {
            val url = URI(raw).toURL()
            devUrlFile.writeText(url.toString())
            SomsBridge.eval("location.replace(${SomsBridge.jsonStr(url.toString())});")
            val port = if (url.port > 0) url.port else if (url.protocol == "https") 443 else 80
            toast("Connecting to ${url.host}:$port")
        } catch (e: Exception) {
            toast("Invalid URL: ${e.message}")
        }
    }

    private fun reload() {
        SomsBridge.eval("location.reload();")
    }

    /** Delete the persisted dev URL + kill the process so Rust re-resolves to the bundled frontend. */
    private fun revert() {
        devUrlFile.delete()
        toast("Reverting to bundled — restarting")
        val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
        if (intent != null) {
            intent.addFlags(
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK,
            )
            activity.startActivity(intent)
        }
        Process.killProcess(Process.myPid())
    }

    private fun toast(msg: String) = Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            activity.resources.displayMetrics,
        ).toInt()

    companion object {
        /** Must match Rust's `DEV_URL_FILENAME` in src-tauri/src/lib.rs ("dev_url"). */
        const val DEV_URL_FILENAME = "dev_url"
    }
}
