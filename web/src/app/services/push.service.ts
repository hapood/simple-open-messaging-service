import { Injectable, inject, isDevMode } from '@angular/core';
import { isAndroidNative, isTauri } from './runtime';
import { NavStateMachineService } from './nav-state.service';
import { consumePendingThreadNavigation } from './pending-thread-navigation';
import {
  PushRegistrationService,
  type PushRegistration,
} from './push-registration.service';
import { uuid } from '../lib/uuid';

/** Android FCM adapter and notification navigation. The shared session coordinator owns registration. */
/** The Firebase client config payload (folded into /shell/compat). `{configured:false}` when the server has
 *  no google-services.json; otherwise the 4 client fields an Android app needs to init FirebaseApp. */
export type FirebaseClientConfigPayload = {
  configured: boolean;
  apiKey?: string;
  projectId?: string;
  appId?: string;
  gcmSenderId?: string;
};

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly nav = inject(NavStateMachineService);
  private readonly registration = inject(PushRegistrationService);

  /** One-shot guard so the POST_NOTIFICATIONS prompt is asked at most once. Seeded from the persisted
   *  native flag (set by MainActivity.onRequestPermissionsResult) so the auto-prompt fires only on the
   *  first login EVER — not the first login of every cold start (which would re-prompt users who merely
   *  dismissed/denied-without-"don't ask again" on each session). */
  private permissionPrompted =
    typeof window !== 'undefined'
      ? !!window.SomsFcm?.getNotifPermRequested?.()
      : false;

  /** Wire up at app boot (AppComponent). Self-guards to a no-op outside the Tauri shell. */
  init() {
    if (!isTauri()) return;
    // Kotlin → JS: token rotation (onNewToken / first fetch). Store + attempt registration.
    window.__SOMS_FCM_TOKEN__ = (t) => this.onToken(t);
    // Kotlin → JS: warm-start deep link (notification tap while the app is already running).
    window.__SOMS_DEEP_LINK__ = () => this.openPendingThread();
    // Recover anything emitted before Angular booted. getToken() is a synchronous @JavascriptInterface
    // read; if Kotlin already has a token, use it (the live hook may have been missed).
    const token = window.SomsFcm?.getToken() ?? null;
    if (token) this.onToken(token);
    else window.SomsFcm?.requestToken();
    // Read native pending navigation after registering the live wake handler.
    this.openPendingThread();
    if (isAndroidNative())
      this.registration.setAdapter({
        read: async () => {
          const token = window.SomsFcm?.getToken();
          return token ? { platform: 'ANDROID', token } : null;
        },
        create: (replace) => this.createRegistration(replace),
      });
    // The native Firebase client config is NOT synced here at boot — it is applied in the server-config
    // flow (server-config-page.finalize) from the config folded into /shell/compat, and the native
    // SomsApplication.onCreate cold-start reader covers boot from the persisted value. No separate fetch.
  }

  private createRegistration(
    replace: boolean,
  ): Promise<PushRegistration | null> {
    const bridge = window.SomsFcm;
    if (!bridge) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const requestId = uuid();
      const timer = setTimeout(() => {
        window.__SOMS_FCM_REGISTRATION__ = undefined;
        reject(new Error('FCM registration timed out'));
      }, 30000);
      window.__SOMS_FCM_REGISTRATION__ = (result) => {
        if (result.requestId !== requestId) return;
        clearTimeout(timer);
        window.__SOMS_FCM_REGISTRATION__ = undefined;
        if (result.token) resolve({ platform: 'ANDROID', token: result.token });
        else reject(new Error(result.error ?? 'FCM registration failed'));
      };
      try {
        bridge.preparePushRegistration(requestId, replace);
      } catch (error) {
        clearTimeout(timer);
        window.__SOMS_FCM_REGISTRATION__ = undefined;
        reject(error);
      }
    });
  }

  /** Apply a server-provided Firebase client config to native so the Android shell (re)initializes
   *  FirebaseApp. Called from the server-config flow with the config folded into /shell/compat (the APK
   *  ships without google-services.json; each server publishes its own — no separate /push/firebase-config
   *  fetch). Android-only (desktop has no Firebase). The 4 fields are only re-pushed when they actually
   *  change (avoids needless token churn on identical config); an explicit {configured:false} clears native
   *  Firebase. Sync + never throws. */
  applyFirebaseConfig(
    data: FirebaseClientConfigPayload | null | undefined,
  ): void {
    if (!isAndroidNative()) {
      if (isDevMode())
        console.info('firebase config: skipped (not Android native)');
      return;
    }
    if (isDevMode()) {
      console.info('firebase config: bridge read start', {
        configured: !!data?.configured,
      });
    }
    if (!data || !data.configured) {
      // Server explicitly has no FCM client config → clear native Firebase.
      const current = window.SomsFcm!.getFirebaseConfig();
      if (isDevMode()) {
        console.info('firebase config: bridge read complete', {
          hasCurrentConfig: current !== null,
        });
      }
      if (current !== null) {
        window.SomsFcm!.setFirebaseConfig(null);
        if (isDevMode())
          console.info('firebase config: native clear dispatched');
      } else if (isDevMode()) {
        console.info('firebase config: unchanged (already clear)');
      }
      return;
    }
    const next = JSON.stringify({
      apiKey: data.apiKey,
      projectId: data.projectId,
      appId: data.appId,
      gcmSenderId: data.gcmSenderId,
    });
    const current = window.SomsFcm!.getFirebaseConfig();
    if (isDevMode()) {
      console.info('firebase config: bridge read complete', {
        hasCurrentConfig: current !== null,
        changed: current !== next,
      });
    }
    if (current !== next) {
      window.SomsFcm!.setFirebaseConfig(next);
      if (isDevMode())
        console.info('firebase config: native reconfigure dispatched');
    } else if (isDevMode()) {
      console.info('firebase config: unchanged');
    }
  }

  /** Permission prompting remains user-session driven; HELLO supplies the registration revision. */
  onLogin() {
    if (!isTauri()) return;
    this.maybePromptPermission();
    this.registration.refresh();
  }

  /** Native token rotation is another event-driven registration trigger. */
  private onToken(_token: string) {
    this.registration.refresh();
  }

  /** Ask for POST_NOTIFICATIONS once, after the first login (Android 13+). The native side handles the
   *  actual system prompt; this is the contextual trigger point (not cold launch). */
  private maybePromptPermission() {
    if (this.permissionPrompted) return;
    this.permissionPrompted = true;
    window.SomsFcm?.requestNotificationPermission();
  }

  /** Open the tapped thread via the nav state machine (the URL mirror updates `/chat/:id`; ChatPane renders
   *  from ConversationListService.openThreadId which the home shell syncs from the state machine). */
  private openPendingThread() {
    consumePendingThreadNavigation(window.SomsFcm, (threadId) => {
      this.nav.setTopSection('chats');
      this.nav.openChat(threadId);
    });
  }
}
