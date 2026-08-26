import {
  ApplicationConfig,
  CSP_NONCE,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
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
import { of, Subject } from 'rxjs';
import { MemberProfileRepository } from '../app/services/member-profile-store.service';
import { UserService } from '../app/services/user.service';

/** Mock media is embedded as data/blob URLs, so this standalone entry never applies the production
 * remote-download size gate. The production app keeps its normal user-configurable service. */
const playgroundMediaThreshold = {
  policy: () => ({ mode: 'unlimited' as const }),
  shouldDefer: () => false,
  isLoaded: () => true,
  markLoaded: () => undefined,
};

const playgroundGroupService = {
  leaveGroup: () => of({ code: 0, message: 'ok' }),
  dissolveGroup: () => of({ code: 0, message: 'ok' }),
  updateGroup: () => of({ code: 0, message: 'ok' }),
  setRole: () => of({ code: 0, message: 'ok' }),
  kickMember: () => of({ code: 0, message: 'ok' }),
  transferOwnership: () => of({ code: 0, message: 'ok' }),
  inviteUsers: () =>
    of({ code: 0, message: 'ok', data: { invited: [], skipped: [] } }),
};

const playgroundMemberNames = new Map([
  [1, 'Me'],
  [2, 'Alice'],
  [3, 'Maya'],
  [4, 'Noah'],
  [5, 'Olivia'],
]);
const playgroundMemberProfiles = {
  changed$: new Subject<readonly number[]>(),
  resolve: async (
    _threadId: number,
    member: { userId: number; account: string },
  ) => ({
    ...member,
    name: playgroundMemberNames.get(member.userId) ?? member.account,
    avatar: '',
  }),
  resolveAll: async (
    threadId: number,
    members: Array<{ userId: number; account: string }>,
  ) =>
    Promise.all(
      members.map((member) =>
        playgroundMemberProfiles.resolve(threadId, member),
      ),
    ),
};

const playgroundUserService = {
  sessionUserId: signal<number | null>(1),
  sessionProfile: signal({
    id: 1,
    account: 'me',
    name: 'Me',
    avatar: '',
    domain: 'local',
  }),
  sendFriendInvite: () =>
    of({ code: 0, message: 'ok', data: { inviteId: 'playground-invite' } }),
  sendFederatedFriendInvite: () =>
    of({ code: 0, message: 'ok', data: { inviteId: 'playground-invite' } }),
  deleteFriend: () => of({ code: 0, message: 'ok' }),
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
    provideHttpClient(withFetch()),
    provideRouter([]),
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
    { provide: GroupService, useValue: playgroundGroupService },
    {
      provide: MemberProfileRepository,
      useValue: playgroundMemberProfiles,
    },
    { provide: UserService, useValue: playgroundUserService },
    provideTransloco({
      config: {
        availableLangs: [
          { id: 'en', label: 'English' },
          { id: 'zh-CN', label: '简体中文' },
        ],
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
