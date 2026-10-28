import {
  ApplicationConfig,
  CSP_NONCE,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import { playgroundHttp } from './playground-http.mock';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter, withHashLocation } from '@angular/router';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS } from '@angular/material/snack-bar';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../app/i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../app/i18n/transloco.loader';
import { MediaSizeThresholdService } from '../app/services/media-size-threshold.service';
import { MESSAGE_THREAD_ADAPTER } from '../app/components/message-thread/message-thread-adapter';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';
import { WebsocketService } from '../app/services/websocket.service';
import { PlaygroundRealtime } from './playground-realtime.mock';
import { LinkCardGenerationService } from '../app/services/link-card-generation.service';
import { PlaygroundLinkGeneration } from './playground-link-generation.mock';
import { CallAdapterService } from '../app/services/call-adapter';
import { CallEventService } from '../app/services/call-event.service';
import {
  PlaygroundCallAdapter,
  PlaygroundCallState,
} from './playground-call.mock';
import { ConversationListService } from '../app/services/conversation-list.service';
import { PlaygroundConversationList } from './playground-conversation-list.mock';
import { GroupService } from '../app/services/group.service';
import { of } from 'rxjs';
import { ProfileRepository } from '../app/services/profile-store.service';
import { PlaygroundGroupService } from './playground-group.mock';
import { PlaygroundUserService } from './playground-user.mock';
import {
  PlaygroundMemberProfiles,
  PlaygroundProfiles,
} from './playground-profile.mock';
import { MemberProfileRepository } from '../app/services/member-profile-store.service';
import { ProfileNamespaceRepository } from '../app/services/profile-namespace-store.service';
import { UserService } from '../app/services/user.service';
import { WebdbService, WebdbStorage } from '../app/services/webdb.service';
import { SessionLifecycleService } from '../app/services/session-lifecycle.service';

/** Mock media is embedded as data/blob URLs, so this standalone entry never applies the production
 * remote-download size gate. The production app keeps its normal user-configurable service. */
const playgroundMediaThreshold = {
  policy: () => ({ mode: 'unlimited' as const }),
  shouldDefer: () => false,
  isLoaded: () => true,
  markLoaded: () => undefined,
};

const playgroundNamespaceRepository = {
  resolve: (pair: {
    publisherNamespaceId: number;
    profileNamespaceId: number;
  }) =>
    of({
      ...pair,
      domain: 'chat.example.test',
      rootPublicKey: null,
      updateFeedId: 1,
      changeSeq: 1,
      expired: false,
      status: 'ACTIVE' as const,
      refreshedAt: Date.now(),
    }),
};

function readCspNonce(): string | null {
  if (typeof document === 'undefined') return null;
  const element = document.querySelector('style[nonce], script[nonce]') as
    | ({ nonce: string } & Element)
    | null;
  return element?.nonce || null;
}

/** Presentation-only providers required by the production chat components. Production boot tasks and
 * transports are intentionally absent: the playground owns an in-memory conversation data source. */
export const playgroundConfig: ApplicationConfig = {
  providers: [
    { provide: CSP_NONCE, useValue: readCspNonce() },
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([playgroundHttp])),
    {
      provide: WebdbService,
      useFactory: (lifecycle: SessionLifecycleService) =>
        new WebdbStorage(() => null, lifecycle),
      deps: [SessionLifecycleService],
    },
    provideRouter(
      [
        {
          path: '',
          pathMatch: 'full',
          loadComponent: () =>
            import('./playground-root.component').then(
              (m) => m.PlaygroundRootComponent,
            ),
        },
        {
          path: 'deploy',
          loadComponent: () =>
            import('./deployment/deployment-page.component').then(
              (m) => m.DeploymentPageComponent,
            ),
        },
        {
          path: 'effects',
          loadComponent: () =>
            import('./effects/effects-page.component').then(
              (m) => m.EffectsPageComponent,
            ),
        },
        {
          path: '404',
          loadComponent: () =>
            import('../app/pages/page-not-found/page-not-found.component').then(
              (m) => m.PageNotFoundComponent,
            ),
        },
        {
          path: '403',
          loadComponent: () =>
            import('../app/pages/forbidden-page/forbidden-page.component').then(
              (m) => m.ForbiddenPageComponent,
            ),
        },
        { path: '**', redirectTo: '' },
      ],
      withHashLocation(),
    ),
    provideAnimationsAsync(),
    {
      provide: MediaSizeThresholdService,
      useValue: playgroundMediaThreshold,
    },
    {
      provide: MESSAGE_THREAD_ADAPTER,
      useExisting: PlaygroundMessageThreadAdapter,
    },
    {
      provide: WebsocketService,
      useExisting: PlaygroundRealtime,
    },
    {
      provide: LinkCardGenerationService,
      useExisting: PlaygroundLinkGeneration,
    },
    {
      provide: CallEventService,
      useExisting: PlaygroundCallState,
    },
    {
      provide: CallAdapterService,
      useExisting: PlaygroundCallAdapter,
    },
    {
      provide: ConversationListService,
      useExisting: PlaygroundConversationList,
    },
    {
      provide: ProfileNamespaceRepository,
      useValue: playgroundNamespaceRepository,
    },
    { provide: GroupService, useExisting: PlaygroundGroupService },
    {
      provide: MemberProfileRepository,
      useExisting: PlaygroundMemberProfiles,
    },
    { provide: ProfileRepository, useExisting: PlaygroundProfiles },
    { provide: UserService, useExisting: PlaygroundUserService },
    provideTransloco({
      config: {
        availableLangs: [
          { id: 'en', label: 'English' },
          { id: 'zh-CN', label: '简体中文' },
        ],
        // Seed value only — the playground does NOT stay in English. Shared message-card
        // components (DateRow, SystemRow, …) inject the root LanguageService on first render,
        // whose constructor re-applies the browser language (then the preference persisted by
        // the main app on this origin) via setActiveLang, so the playground follows the
        // browser exactly like the main app.
        defaultLang: 'en',
        reRenderOnLangChange: true,
        prodMode: true,
      },
      loader: InlineTranslocoLoader,
    }),
    provideTranslocoTranspiler(CspSafeIcuTranspiler),
    {
      provide: MAT_SNACK_BAR_DEFAULT_OPTIONS,
      useValue: {
        horizontalPosition: 'center',
        verticalPosition: 'bottom',
        panelClass: 'soms-snack-bar',
        duration: 4000,
      },
    },
  ],
};
