import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  createP2PConversation,
  type ConversationItem,
} from '../../services/model';
import { AvatarPresentationService } from '../user-avatar/avatar-presentation.service';
import type { AvatarView } from '../user-avatar/avatar-view';
import type { AvatarSource } from '../user-avatar/avatar-source';
import { UserAvatarType } from '../user-avatar/model';
import type { ChatMsgData } from './chat-item';
import { MessageSenderService } from './message-sender.service';
import { senderRowLayout } from './message-sender';

const message: ChatMsgData = {
  type: 'msg',
  msgId: 1,
  threadId: 42,
  creator: 'alice',
  isSelf: false,
  senderDisplayContext: 'direct',
  name: 'Captured',
  text: 'hello',
  time: '12:00',
  contentType: 'PURE_TEXT',
  images: null,
  file: null,
  createdAtMs: 1,
  sender: {
    kind: 'demand',
    fallbackName: 'Captured',
    account: 'alice',
    profile: {
      account: 'alice',
      publisherNamespaceId: 0,
      profileNamespaceId: 4,
      rev: 2,
      linked: true,
    },
  },
};

describe('MessageSenderService', () => {
  it('applies live P2P aliases to the one shared presentation, never group or snapshot authors', async () => {
    const conversation = createP2PConversation(
      42,
      { account: 'alice', namespaceId: 4, profileRev: 2 },
      { alias: 'Friend' },
    );
    const conversations = signal<ConversationItem[]>([conversation]);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
        {
          provide: AvatarPresentationService,
          useValue: {
            resolve: (source: AvatarSource) =>
              of({
                name: source.kind === 'demand' ? 'Pinned Alice' : source.name,
                imageUrl: 'blob:alice',
                type: UserAvatarType.OTHER,
              }),
          },
        },
      ],
    });
    const service = TestBed.inject(MessageSenderService);
    let view!: AvatarView;
    const subscription = service
      .resolve(message)
      .subscribe((value) => (view = value));
    TestBed.tick();
    expect(view.name).toBe('Friend');
    expect(view.imageUrl).toBe('blob:alice');
    conversations.set([{ ...conversation, alias: 'New Alias' }]);
    TestBed.tick();
    expect(view.name).toBe('New Alias');
    conversations.set([{ ...conversation, alias: null }]);
    TestBed.tick();
    expect(view.name).toBe('Pinned Alice');
    service
      .resolve({ ...message, senderDisplayContext: 'group' })
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view.name).toBe('Pinned Alice');
    conversations.set([conversation]);
    service
      .resolve({
        ...message,
        sender: { kind: 'snapshot', name: 'Frozen', imageUrl: null },
      })
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view.name).toBe('Frozen');
    subscription.unsubscribe();
  });

  it('rejects an alias belonging to a different account or namespace', () => {
    const conversations = signal<ConversationItem[]>([
      createP2PConversation(
        42,
        { account: 'alice', namespaceId: 9, profileRev: 2 },
        { alias: 'Wrong' },
      ),
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
        {
          provide: AvatarPresentationService,
          useValue: {
            resolve: () =>
              of({
                name: 'Pinned Alice',
                imageUrl: null,
                type: UserAvatarType.OTHER,
              }),
          },
        },
      ],
    });
    let view!: AvatarView;
    const subscription = TestBed.inject(MessageSenderService)
      .resolve(message)
      .subscribe((value) => (view = value));
    TestBed.tick();
    expect(view.name).toBe('Pinned Alice');
    subscription.unsubscribe();
  });
});

describe('senderRowLayout', () => {
  it.each(['direct', 'group', 'forward'] as const)(
    'keeps %s policy independent of content and identity resolution',
    (context) => {
      expect(senderRowLayout(context, false, true)).toEqual({
        side: 'other',
        showAvatar: true,
        showName: context !== 'direct',
      });
      expect(senderRowLayout(context, false, false)).toEqual({
        side: 'other',
        showAvatar: false,
        showName: false,
      });
      expect(senderRowLayout(context, true, true)).toEqual({
        side: 'self',
        showAvatar: true,
        showName: false,
      });
    },
  );
});
