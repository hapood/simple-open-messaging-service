import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallScreenComponent } from '../app/components/call-screen/call-screen.component';
import { CallPresentationService } from '../app/services/call-presentation.service';
import { HomeShellComponent } from '../app/components/home-shell/home-shell.component';
import { RootPopupComponent } from '../app/components/root-popup/root-popup.component';
import {
  createGroupConversation,
  createP2PConversation,
} from '../app/services/model';
import { PlaygroundCallState } from './playground-call.mock';
import { PlaygroundControlsComponent } from './playground-controls.component';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

const DEMO_CONVERSATION = createP2PConversation(
  1,
  {
    account: 'alice',
    bio: 'Product designer · Shanghai',
    name: 'Alice',
    domain: 'chat.example.test',
    namespaceId: 0,
  },
  {
    lastMessageAt: Date.now() - 60_000,
    lastMessagePreview: 'See you in the playground!',
    lastMessageSeq: 100,
    unreadCount: 2,
  },
);

const DEMO_INVITABLE_FRIEND = createP2PConversation(6, {
  account: 'liam',
  bio: 'Android engineer · Hangzhou',
  name: 'Liam',
  domain: 'chat.example.test',
  namespaceId: 0,
});

const DEMO_GROUP_CONVERSATION = createGroupConversation(
  2,
  {
    id: 2,
    account: '!playground',
    name: 'Playground Team',
    description: 'Alice · Maya · Noah · You',
    memberCount: 5,
    domain: 'chat.example.test',
    namespaceId: 0,
  },
  {
    role: 'OWNER',
    lastMessageAt: Date.now() - 120_000,
    lastMessagePreview: 'Welcome to the team',
    lastMessageSeq: 100,
    unreadCount: 0,
  },
);

@Component({
  selector: 'app-root',
  imports: [
    CallScreenComponent,
    HomeShellComponent,
    PlaygroundControlsComponent,
    RootPopupComponent,
  ],
  template: `
    <app-home-shell />
    <app-playground-controls />
    <app-root-popup />
    @if (callState.callState().phase !== 'idle' && !presentation.minimized()) {
      <app-call-screen />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundRootComponent {
  readonly callState = inject(PlaygroundCallState);
  readonly presentation = inject(CallPresentationService);
  private readonly conversations = inject(PlaygroundConversationList);

  constructor() {
    this.conversations.setRelatedConversations([
      DEMO_CONVERSATION,
      DEMO_GROUP_CONVERSATION,
      DEMO_INVITABLE_FRIEND,
    ]);
    this.conversations.open(DEMO_GROUP_CONVERSATION.threadId);
  }
}
