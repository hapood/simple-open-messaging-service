import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';
import { ThreadRepository } from '../../services/thread-store.service';
import { HomeShellComponent } from '../../components/home-shell/home-shell.component';
import { RootPopupComponent } from '../../components/root-popup/root-popup.component';

/**
 * Home route entry (`/`). Renders the unified responsive {@link HomeShellComponent} (which hosts the
 * chat + aside router-outlets), plus the root popup layer for transient editor dialogs.
 * The application root owns the connection indicator across route transitions.
 * Session restoration and realtime startup belong to application lifecycle
 * orchestration; this route instantiates the authenticated repository consumers.
 */
@Component({
  selector: 'app-home',
  imports: [
    HomeShellComponent,
    RootPopupComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-home-shell />
    <app-root-popup />
  `,
})
export class HomeComponent {
  private readonly userService = inject(UserService);
  private readonly authService = inject(AuthService);
  // Injected to instantiate the DB-layer root singletons that self-subscribe to the SSE stream in their
  // constructors: ThreadRepository routes State Feed / attention revisions and reconnect refresh.
  // Group roster invalidation is emitted locally only after
  // the corresponding durable state delta has been applied.
  // Injecting them here guarantees their subscriptions are alive for the whole home-route session
  // regardless of which child panes are mounted.
  private readonly threadRepo = inject(ThreadRepository);
}
