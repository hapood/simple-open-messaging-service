import { afterNextRender, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { LanguageService } from './services/language.service';
import { UpdateService } from './services/update.service';
import { PushService } from './services/push.service';
import { WebPushService } from './services/web-push.service';
import { SseLifecycleService } from './services/sse-lifecycle.service';
import { MissedSyncService } from './services/missed-sync.service';
import { UnreadAttentionService } from './services/unread-attention.service';
import { BackgroundSyncService } from './services/background-sync.service';
import { NavStateMachineService } from './services/nav-state.service';
import { ShellUpdateService } from './services/shell-update.service';
import { emitTauriEvent, isTauri, isAndroid } from './services/runtime';
@Component({
    selector: 'app-root',
    imports: [RouterOutlet],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss'
})
export class AppComponent {
    // Eagerly instantiate so their effects + listeners are live for the whole session.
    private readonly theme = inject(ThemeService);
    private readonly language = inject(LanguageService);
    // UpdateService subscribes to SwUpdate.versionUpdates (a hot stream) — eagerly constructed so a
    // VERSION_READY emitted before the home shell mounts is not missed.
    private readonly updates = inject(UpdateService);
    // PushService.init() registers the FCM token-handoff hooks + recovers any cold-start deep link. Runs
    // once at boot; a no-op outside the Tauri shell (the hooks are never triggered by the browser).
    private readonly push = inject(PushService);
    // WebPushService.init() subscribes the browser/PWA to Web Push (VAPID). Self-guards to a no-op in
    // the Tauri shell and on unsupported browsers; surfaces a toast on permission/subscribe failures.
    private readonly webPush = inject(WebPushService);
    // SseLifecycleService listens to visibilitychange — disconnects SSE on Android background (graceful
    // close), reconnects on resume. PC/browser keep SSE alive. Eagerly constructed so the listener is
    // live for the whole session.
    private readonly sseLifecycle = inject(SseLifecycleService);
    // MissedSyncService pages POST /notifications/missed on app-open (DB-ready) + reconnect, hydrating the
    // message store for threads that grew while the app was closed (the SSE stream does not replay offline).
    // Eagerly constructed so its DB-ready effect + reconnect subscription are live for the whole session.
    private readonly missedSync = inject(MissedSyncService);
    // UnreadAttentionService prefixes the window/tab title with "(N)" + posts a system notification
    // when a NEW_MESSAGE arrives while the window is unfocused. Covers PC desktop + browser. Eagerly
    // constructed so the focus listener + SSE subscription are live for the whole session.
    private readonly attention = inject(UnreadAttentionService);
    // BackgroundSyncService owns the Android 6-hour keep-alive poller preference. Eagerly constructed
    // so the stored preference (read from Kotlin SomsSecureStore via the bridge) is reflected into the
    // signal + re-applied to the WorkManager schedule at every boot. A no-op off-Android.
    private readonly bgSync = inject(BackgroundSyncService);
    // NavStateMachineService: eagerly constructed so its URL-mirror effect is live, and so initFromUrl()
    // runs here (synchronously, before the effect's first async tick) to seed the chat from a cold URL
    // like `/chat/2` before the mirror's first replaceState.
    private readonly nav = inject(NavStateMachineService);
    // ShellUpdateService: the Tauri-shell dynamic web-update probe (background download + reload prompt).
    // Eagerly constructed; its check() is fired after the first paint below.
    private readonly shellUpdate = inject(ShellUpdateService);
    constructor() {
        this.nav.initFromUrl();
        // Android hardware-back: Kotlin's OnBackPressedCallback evals window.__SOMS_BACK__(); peel one
        // nav layer, and if nothing's left (at home) call SomsBack.exit() (a Kotlin @JavascriptInterface)
        // to finish the activity. Desktop/browser have no native back — history is flat, so browser-back
        // exits there. Dormant until the Kotlin side wires the callback (the Phase 3 Kotlin half).
        if (isTauri() && isAndroid()) {
            window.__SOMS_BACK__ = () => {
                if (!this.nav.back()) window.SomsBack?.exit();
            };
        }
        this.push.init();
        void this.webPush.init();
        // Two-window handoff: emit spa-ready AFTER the first paint so Rust can show the main window +
        // close the init window (no blank gap — the app-shell spinner covers the pre-paint frame), then
        // probe for a background web-bundle update. Both no-op outside the Tauri shell.
        afterNextRender(() => {
            emitTauriEvent('spa-ready');
            void this.shellUpdate.check();
        });
    }
}
