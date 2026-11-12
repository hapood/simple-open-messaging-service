import { effect, inject, Injectable } from '@angular/core';
import { ConversationListService } from './conversation-list.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { UserService } from './user.service';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';

/** Wake Rust after durable unread projections change; Rust owns the total and Dock publication. */
@Injectable({ providedIn: 'root' })
export class DesktopBadgeService {
  constructor() {
    if (!isTauri() || isAndroidNative()) return;
    const conversations = inject(ConversationListService);
    const user = inject(UserService);
    const lifecycle = inject(SessionLifecycleService);
    effect(() => {
      // Depend on projection changes, not on notification preferences or window focus.
      conversations.items();
      const userId = user.sessionUserId();
      const scope = lifecycle.capture();
      if (!userId || !scope.sessionId || !lifecycle.isCurrent(scope)) return;
      void tauriInvoke<void>('desktop_badge_refresh', {
        sessionUuid: scope.sessionId,
        userId,
      }).catch((error) => {
        if (lifecycle.isCurrent(scope))
          console.warn('[notification] Dock badge refresh failed', error);
      });
    });
  }
}
