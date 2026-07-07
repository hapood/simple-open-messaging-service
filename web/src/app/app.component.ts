import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { LanguageService } from './services/language.service';
import { UpdateService } from './services/update.service';
import { PushService } from './services/push.service';
import { WebPushService } from './services/web-push.service';
import { SseLifecycleService } from './services/sse-lifecycle.service';
import { UnreadAttentionService } from './services/unread-attention.service';
import { BackgroundSyncService } from './services/background-sync.service';
import { BackExitGuardService } from './services/back-exit-guard.service';
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
    // UnreadAttentionService flashes the window/tab title "(N) SOMS" + posts a system notification when
    // a NEW_MESSAGE arrives while the window is unfocused. Covers PC desktop + browser. Eagerly
    // constructed so the focus listener + SSE subscription are live for the whole session.
    private readonly attention = inject(UnreadAttentionService);
    // BackgroundSyncService owns the Android 6-hour keep-alive poller preference. Eagerly constructed
    // so the stored preference (read from Kotlin SomsSecureStore via the bridge) is reflected into the
    // signal + re-applied to the WorkManager schedule at every boot. A no-op off-Android.
    private readonly bgSync = inject(BackgroundSyncService);
    // BackExitGuardService implements the "press back again to exit" guard on the home conversation list
    // for the browser + desktop shell (Android handles hardware back natively; the service self-disables
    // there). Eagerly constructed so its popstate listener is live for the whole session.
    private readonly backExitGuard = inject(BackExitGuardService);
    constructor() {
        this.push.init();
        void this.webPush.init();
    }
}
