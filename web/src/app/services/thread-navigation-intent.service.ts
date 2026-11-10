import {
  Injectable,
  Injector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ConversationListService } from './conversation-list.service';
import { NavStateMachineService } from './nav-state.service';
import { UserService } from './user.service';
import { apiOrigin } from './runtime';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  ThreadNavigationIntentCoordinator,
  type ThreadNavigationIntent,
} from './thread-navigation-intent';

@Injectable({ providedIn: 'root' })
export class ThreadNavigationIntentService {
  private readonly conversations = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
  private readonly user = inject(UserService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly injector = inject(Injector);
  // Resolve the dialog graph only on demand, outside service construction.
  private readonly friendPopup = signal<(() => void) | undefined>(undefined);
  private loadingFriendPopup = false;
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
      const friendPopup = this.friendPopup();
      untracked(() => {
        if (
          navigationRevision !== this.offeredNavigationRevision ||
          origin !== this.offeredOrigin
        ) {
          this.coordinator.invalidate();
          this.offeredNavigationRevision = navigationRevision;
          this.offeredOrigin = origin;
          return;
        }
        this.coordinator.select(sessionId, ready, (target) => {
          if (target.kind === 'friend-requests') {
            if (!friendPopup) {
              this.loadFriendPopup();
              return false;
            }
            if (!this.nav.returnToThreadList()) {
              return false;
            }
            friendPopup();
          } else {
            // A tap can precede its thread projection. Wait without exposing it.
            const thread = items.find(
              (item) => item.threadId === target.threadId,
            );
            if (!thread) return false;
            if (!this.nav.openExternalChat(target.threadId)) {
              return false;
            }
            if (target.kind === 'group-join-requests') {
              // A stale manager notification still opens its chat, but the
              // normal entry gate may decline the privileged child surface.
              this.nav.openGroupJoinRequests(thread, 'applications');
            }
          }
          // These revisions are our own Home → destination transaction, not
          // newer manual navigation. Mounting the aside needs no second pass.
          this.offeredNavigationRevision = this.nav.navigationRevision();
          return true;
        });
      });
    });
    if (this.nav.bootstrapNotificationIntent)
      this.offer(this.nav.bootstrapNotificationIntent);
  }

  private loadFriendPopup(): void {
    if (this.loadingFriendPopup) return;
    this.loadingFriendPopup = true;
    void import('./route.service')
      .then(({ RouteService }) => {
        this.friendPopup.set(() =>
          this.injector.get(RouteService).openFriendRequests('pending'),
        );
      })
      .catch((error) => {
        this.loadingFriendPopup = false;
        console.warn('[notification] dialog loading failed', error);
      });
  }

  /** Async adapters capture the work scope BEFORE reading their pending slot. */
  offer(
    intent: ThreadNavigationIntent,
    scope = this.lifecycle.capture(),
  ): void {
    if (!this.lifecycle.isCurrent(scope)) return;
    const navigationRevision = this.nav.navigationRevision();
    const origin = apiOrigin();
    if (
      navigationRevision !== this.offeredNavigationRevision ||
      origin !== this.offeredOrigin
    )
      this.coordinator.invalidate();
    this.offeredNavigationRevision = navigationRevision;
    this.offeredOrigin = origin;
    this.coordinator.offer(intent);
    this.revision.update((value) => value + 1);
  }
}
