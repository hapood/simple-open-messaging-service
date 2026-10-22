import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ConversationListService } from './conversation-list.service';
import { NavStateMachineService } from './nav-state.service';
import { UserService } from './user.service';
import { apiOrigin } from './runtime';
import { SessionLifecycleService } from './session-lifecycle.service';
import { ThreadNavigationIntentCoordinator, type ThreadNavigationIntent } from './thread-navigation-intent';

@Injectable({ providedIn: 'root' })
export class ThreadNavigationIntentService {
  private readonly conversations = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
  private readonly user = inject(UserService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly coordinator = new ThreadNavigationIntentCoordinator();
  private readonly revision = signal(0);
  private offeredNavigationRevision = 0;
  private offeredOrigin = apiOrigin();

  constructor() {
    this.lifecycle.invalidated$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.coordinator.invalidate();
      this.revision.update((value) => value + 1);
    });
    effect(() => {
      this.revision();
      const sessionId = this.user.sessionId();
      const ready = this.conversations.navigationReady();
      const items = this.conversations.items();
      const navigationRevision = this.nav.navigationRevision();
      const origin = apiOrigin();
      untracked(() => {
        if (navigationRevision !== this.offeredNavigationRevision || origin !== this.offeredOrigin) {
          this.coordinator.invalidate();
          this.offeredNavigationRevision = navigationRevision;
          this.offeredOrigin = origin;
          return;
        }
        this.coordinator.select(sessionId, ready, (threadId) => {
          // A tap can precede the feed that creates its thread row. Do not
          // acknowledge or expose a target until its projection exists.
          if (!items.some((item) => item.threadId === threadId)) return false;
          return this.nav.openExternalChat(threadId);
        });
      });
    });
    if (this.nav.bootstrapNotificationIntent)
      this.offer(this.nav.bootstrapNotificationIntent);
  }

  /** Async adapters capture the work scope BEFORE reading their pending slot. */
  offer(intent: ThreadNavigationIntent, scope = this.lifecycle.capture()): void {
    if (!this.lifecycle.isCurrent(scope)) return;
    const navigationRevision = this.nav.navigationRevision();
    const origin = apiOrigin();
    if (navigationRevision !== this.offeredNavigationRevision || origin !== this.offeredOrigin)
      this.coordinator.invalidate();
    this.offeredNavigationRevision = navigationRevision;
    this.offeredOrigin = origin;
    this.coordinator.offer(intent);
    this.revision.update((value) => value + 1);
  }
}
