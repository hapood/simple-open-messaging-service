package com.soms.client

/**
 * No-op dev-tools surface — the stub twin compiled in every build EXCEPT the Makefile's `apk-dev` target.
 * `apk-dev` exports `SOMS_DEV_TOOLS=1`, which makes `build.gradle.kts` swap in the REAL twin at
 * `src/dev-real` instead of this file (both define `object DevTools`, so exactly one is compiled per
 * build — never both, never neither). MainActivity calls [attach]/[detach] unconditionally; here they do
 * nothing, so apk-debug and release ship ZERO dev-tools code: [DevToolsBubble] / [DevToolsDialog] and
 * their drawables live only in `src/dev-real` and are simply not compiled here. No runtime gate, no
 * BuildConfig flag, no R8 needed — the absence is at packaging time, not run time.
 *
 * This is the Android mirror of the web's `dev-tools.ts` ↔ `dev-tools.prod.ts` fileReplacements: a stable
 * call site in always-compiled code, with the definition swapped per build.
 */
object DevTools {
    fun attach(activity: MainActivity) {}
    fun detach(activity: MainActivity) {}
}
