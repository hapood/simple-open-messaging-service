import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { MessageHeaderComponent } from './message-header.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { LayoutService } from '../../services/layout.service';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { GroupService } from '../../services/group.service';
import { RouteService } from '../../services/route.service';
import { CallAdapterService } from '../../services/call-adapter';
import { CallEventService } from '../../services/call-event.service';
import { IDLE_CALL } from '../../services/call-adapter';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { ChatContextService } from '../message-thread/chat-context.service';
import {
  ConversationItem,
  createGroupConversation,
  createP2PConversation,
} from '../../services/model';

/**
 * Covers the header's local computed state and action dispatch. ConversationListService is stubbed with controllable
 * signals (mirrors thread-list.component.spec.ts); every other dep is an empty stub since no field
 * initializer the badge touches reads them. No detectChanges — only the component's computeds are read
 * (rendering the template would pull in transloco + child components + CDK overlay unnecessarily).
 */
describe('MessageHeaderComponent — back-button unread badge', () => {
  let comp: MessageHeaderComponent;
  let fixture: ComponentFixture<MessageHeaderComponent>;
  let items: ReturnType<typeof signal<ConversationItem[]>>;
  let openThreadId: ReturnType<typeof signal<number | undefined>>;
  let openAside: ReturnType<typeof vi.fn>;
  let canAdministerGroup: ReturnType<typeof signal<boolean>>;

  /** Minimal ConversationItem — only threadId + unreadCount are exercised by the badge sum. */
  function item(threadId: number, unreadCount: number): ConversationItem {
    return createP2PConversation(
      threadId,
      {
        id: threadId * 10,
        account: `u${threadId}`,
        name: `User ${threadId}`,
      },
      { unreadCount },
    );
  }

  beforeEach(() => {
    items = signal<ConversationItem[]>([]);
    openThreadId = signal<number | undefined>(undefined);
    openAside = vi.fn();
    canAdministerGroup = signal(false);

    TestBed.configureTestingModule({
      imports: [MessageHeaderComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: 'Simplified Chinese' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        { provide: ConversationListService, useValue: { items, openThreadId } },
        {
          provide: NavStateMachineService,
          useValue: { searchOpen: signal(false), openAside },
        },
        {
          provide: LayoutService,
          useValue: {
            mode: signal<'compact' | 'medium' | 'expanded'>('compact'),
          },
        },
        { provide: MsgService, useValue: {} },
        {
          provide: UserService,
          useValue: {
            sessionProfile: signal({ id: 1 }),
            groupJoinRequestHeads: signal(new Map()),
          },
        },
        { provide: ChatContextService, useValue: { canAdministerGroup } },
        { provide: GroupService, useValue: {} },
        { provide: RouteService, useValue: {} },
        { provide: CallAdapterService, useValue: {} },
        {
          provide: CallEventService,
          useValue: { callState: signal({ ...IDLE_CALL }) },
        },
        { provide: AvatarRepository, useValue: {} },
      ],
    });
    fixture = TestBed.createComponent(MessageHeaderComponent);
    comp = fixture.componentInstance;
  });

  it('sums unread across all threads except the open one', () => {
    items.set([item(1, 3), item(2, 0), item(3, 5)]);
    openThreadId.set(3);
    expect(comp.otherUnreadCount()).toBe(3); // 3 + 0, thread 3 excluded
  });

  it('excludes the open thread even when it carries unread (defensive — it is held at 0 while open)', () => {
    items.set([item(1, 4), item(2, 6)]);
    openThreadId.set(2);
    expect(comp.otherUnreadCount()).toBe(4); // only thread 1
  });

  it('with no open thread, sums every thread', () => {
    items.set([item(1, 2), item(2, 7)]);
    openThreadId.set(undefined);
    expect(comp.otherUnreadCount()).toBe(9);
  });

  it('is 0 when only the open thread has unread', () => {
    items.set([item(1, 0), item(2, 8)]);
    openThreadId.set(2);
    expect(comp.otherUnreadCount()).toBe(0);
  });

  it('otherUnreadLabel caps at 99+', () => {
    items.set(Array.from({ length: 100 }, (_, i) => item(i + 1, 1))); // 100 unread, none open
    openThreadId.set(undefined);
    expect(comp.otherUnreadCount()).toBe(100);
    expect(comp.otherUnreadLabel()).toBe('99+');
  });

  it('otherUnreadLabel renders the exact count under 99', () => {
    items.set([item(1, 42)]);
    expect(comp.otherUnreadLabel()).toBe('42');
  });

  it('treats a negative unreadCount as 0 (Math.max guard)', () => {
    items.set([item(1, -5), item(2, 3)]);
    openThreadId.set(undefined);
    expect(comp.otherUnreadCount()).toBe(3); // -5 → 0, plus 3
  });

  it('offers contact sharing in the More menu and emits the current chat', () => {
    const chat = item(7, 0);
    fixture.componentRef.setInput('userMsgTrd', chat);
    const shared: ConversationItem[] = [];
    comp.shareChatCard.subscribe((value) => shared.push(value));

    expect(comp.entries()).toContainEqual(
      expect.objectContaining({ kind: 'action', key: 'shareContact' }),
    );

    comp.onSelect('shareContact');
    expect(shared).toEqual([chat]);
  });

  it('offers join requests directly in an admin group More menu', () => {
    const chat = createGroupConversation(
      8,
      { id: 80, account: 'group-80', name: 'Group 80', ownerId: 1 },
      { role: 'ADMIN' },
    );
    canAdministerGroup.set(true);
    fixture.componentRef.setInput('userMsgTrd', chat);

    expect(comp.entries()).toContainEqual(
      expect.objectContaining({ kind: 'action', key: 'joinRequests' }),
    );

    comp.onSelect('joinRequests');
    expect(openAside).toHaveBeenCalledWith('group-join-requests');
  });
});
