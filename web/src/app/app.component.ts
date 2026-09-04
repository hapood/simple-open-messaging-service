import {
  afterNextRender,
  ApplicationRef,
  Component,
  HostListener,
  effect,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { LanguageService } from './services/language.service';
import { UpdateService } from './services/update.service';
import { PushService } from './services/push.service';
import { WebPushService } from './services/web-push.service';
import { SseLifecycleService } from './services/sse-lifecycle.service';
import { UnreadAttentionService } from './services/unread-attention.service';
import { BackgroundSyncService } from './services/background-sync.service';
import { NavStateMachineService } from './services/nav-state.service';
import { ShellUpdateService } from './services/shell-update.service';
import { RouteService, PopupType } from './services/route.service';
import { DebugLogFabComponent } from './components/debug-log/debug-log-fab.component';
import { emitTauriEvent, isTauri, isAndroid } from './services/runtime';
import { CallEventService } from './services/call-event.service';
import { CallOverlayService } from './services/call-overlay.service';
import { CallPresentationService } from './services/call-presentation.service';
import { ChatAppearanceService } from './services/chat-appearance.service';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { ComposerGeometryService } from './services/composer-geometry.service';
import { AuthService } from './services/auth.service';
import { ConfigService } from './services/config.service';
import { NativeShareService } from './services/native-share.service';
import { MsgService } from './services/message.service';
import { ToastService } from './services/toast.service';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { uuid } from './lib/uuid';
import { stringifyTextMessageContent } from '../../../shared/text-message-content';
import { MaterialDialogComponent } from './components/material-dialog/material-dialog.component';
import { ServerConfigPageComponent } from './pages/server-config-page/server-config-page.component';
import { ServerConfigDialogService } from './services/server-config-dialog.service';
import { AppBackDispatcherService } from './services/app-back-dispatcher.service';
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    DebugLogFabComponent,
    UpdateBannerComponent,
    MaterialDialogComponent,
    ServerConfigPageComponent,
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './app.component.scss',
})
export class AppComponent {
  protected readonly serverConfigDialog = inject(ServerConfigDialogService);
  // Eagerly instantiate so their effects + listeners are live for the whole session.
  private readonly composerGeometry = inject(ComposerGeometryService);
  // Register the Android ACTION_SEND pull hook before any recipient UI exists. Payloads remain native-owned
  // until the future forwarding flow explicitly acknowledges them.
  private readonly nativeShare = inject(NativeShareService);
  private readonly messages = inject(MsgService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly language = inject(LanguageService);
  // Reflect device-local chat display preferences for the virtual-scroll kernel's detached rows.
  private readonly chatAppearance = inject(ChatAppearanceService);
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
  // UnreadAttentionService prefixes the window/tab title with "(N)" + posts a system notification
  // when a durable content head advances while the window is unfocused. Covers PC desktop + browser. Eagerly
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
  // RouteService: opens the once-per-launch shell-incompatibility dialog when the probe finds the
  // backend is too new for this shell.
  private readonly route = inject(RouteService);
  private readonly applicationRef = inject(ApplicationRef);
  private readonly auth = inject(AuthService);
  private readonly config = inject(ConfigService);
  // CallEventService: routes CALL_EVENT SSE frames + the native __SOMS_CALL_EVENT__ snapshot push into the
  // callState signal. Eagerly constructed so an incoming ring (which can arrive at any time) is never
  // missed — it subscribes in its constructor + installs the native snapshot hook.
  private readonly callEvents = inject(CallEventService);
  // CallOverlayService mounts CallScreenComponent as a body-level CDK overlay (sibling of <app-root>) +
  // toggles the html.in-video-call transparency treatment on video calls, so the native remote video shows
  // through the transparent chrome. Eagerly constructed so its callState effect is live for the whole
  // session (an incoming ring can arrive at any time) — cf. the qr-scanning overlay architecture.
  private readonly callOverlay = inject(CallOverlayService);
  private readonly callPresentation = inject(CallPresentationService);
  private readonly appBack = inject(AppBackDispatcherService);
  // Guards the incompatibility prompt to once per app session (re-armed only by a fresh app launch).
  private incompatiblePromptShown = false;
  private nativeShareDialogId: string | null = null;
  constructor() {
    this.nav.initFromUrl();
    // App-shell fallback below temporary AppBackDispatcher handlers: minimize a foreground call, peel one
    // nav layer, then finish the Activity at the app root. Predictive commit reaches the same fixed entry.
    if (isTauri() && isAndroid()) {
      this.appBack.setFallback(() => {
        if (
          this.callEvents.callState().phase !== 'idle' &&
          !this.callPresentation.minimized()
        ) {
          this.callPresentation.minimize();
          return;
        }
        if (!this.nav.back()) window.SomsBack?.exit();
      });
    }
    this.push.init();
    effect(() => {
      const payload = this.nativeShare.pending();
      const claimedId = this.nativeShare.draft()?.id;
      if (
        !payload ||
        !this.auth.loggedIn() ||
        payload.id === claimedId ||
        this.nativeShareDialogId === payload.id
      )
        return;

      this.nativeShareDialogId = payload.id;
      this.route.popupDlg(
        PopupType.FORWARD,
        {
          purpose: 'NATIVE_SHARE',
          sharedText: payload.text,
          mode: 'DIRECT',
        },
        async (result) => {
          this.nativeShareDialogId = null;
          if (result?.threadIds.length && result.nativeShare) {
            this.nativeShare.claimRecipients(payload, result.threadIds);
            const sent = await this.sendNativeShare(
              result.threadIds,
              result.nativeShare,
            );
            if (sent > 0) this.nativeShare.acknowledge(payload.id);
            if (sent === result.threadIds.length) {
              this.toast.info(
                this.transloco.translate('forward.sent', { count: sent }),
              );
            } else {
              this.toast.warn(
                sent > 0
                  ? this.transloco.translate('forward.partiallySent', {
                      sent,
                      total: result.threadIds.length,
                    })
                  : this.transloco.translate('forward.sendFailed'),
              );
            }
          } else {
            this.nativeShare.acknowledge(payload.id);
          }
        },
      );
    });
    void this.webPush.init();
    // afterNextRender: the SPA has painted — probe for a background web-bundle update and surface an
    // incompatibility prompt if this shell is too old for the backend. The `spa-ready` emit is a
    // historical leftover from the old two-window shell (single-window now → no Rust listener); kept
    // harmless. Everything here no-ops outside the Tauri shell.
    afterNextRender(() => {
      emitTauriEvent('spa-ready');
      void this.shellUpdate.check().then(() => this.maybePromptIncompatible());
      void this.finishNativeSplashWhenReady();
    });
  }

  private async sendNativeShare(
    threadIds: readonly number[],
    delivery:
      | { readonly kind: 'link'; readonly generationId: string }
      | { readonly kind: 'text'; readonly text: string },
  ): Promise<number> {
    let sent = 0;
    for (const [index, threadId] of threadIds.entries()) {
      try {
        const response = await firstValueFrom(
          this.messages.sendMessage({
            threadId,
            content:
              delivery.kind === 'link'
                ? delivery.generationId
                : stringifyTextMessageContent({ text: delivery.text }),
            contentType: delivery.kind === 'link' ? 'LINK' : 'PURE_TEXT',
            clientMessageId: uuid(),
            ...(delivery.kind === 'link' && index < threadIds.length - 1
              ? { retainLinkGeneration: true }
              : {}),
          }),
        );
        if (response.code === 0) sent += 1;
      } catch {
        // Continue through the selected destinations and report the aggregate outcome once.
      }
    }
    if (sent === 0) this.nativeShare.releaseDraft();
    return sent;
  }

  /** The consumer clients provide their own contextual actions, except in editable controls where the
   *  native menu remains useful for selection, clipboard and spellcheck actions. */
  @HostListener('document:contextmenu', ['$event'])
  preventNativeContextMenu(event: MouseEvent): void {
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, [contenteditable="true"]')
    )
      return;
    event.preventDefault();
  }

  /**
   * Keep Android's native overlay above intermediate auth frames. Logged-out launches wait for the
   * public config (which may redirect password → OTP/QR); returning sessions can go straight to their
   * already-resolved shell. Two animation frames ensure the final DOM has actually reached the WebView.
   */
  private async finishNativeSplashWhenReady(): Promise<void> {
    const shell = window.SomsShell;
    if (!isTauri() || !isAndroid() || !shell?.finishSplash) return;
    if (!this.auth.isLoggedIn()) {
      shell.setSplashStage?.('config');
      await this.config.ensureLoaded();
    }
    shell.setSplashStage?.('interface');
    await this.applicationRef.whenStable();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    shell.finishSplash();
  }

  /** Surface a once-per-launch dialog when the probe found this shell is incompatible with the backend.
   *  Non-blocking: the user dismisses it and keeps using the cached bundle (the wizard hard-blocked this
   *  at server-setup; this is the soft reminder for an already-logged-in session). */
  private maybePromptIncompatible(): void {
    if (this.incompatiblePromptShown) return;
    const status = this.shellUpdate.updateStatus();
    if (!status?.incompatible) return;
    this.incompatiblePromptShown = true;
    this.route.popupDlg(PopupType.SHELL_INCOMPATIBLE, {
      serverVersion: status.serverVersion,
    });
  }
}
