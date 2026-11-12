import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
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
  let asideTop: ReturnType<
    typeof signal<{ panel: 'profile' | 'group-info' } | undefined>
  >;

  /** Minimal ConversationItem — only threadId + unreadCount are exercised by the badge sum. */
  function item(threadId: number, unreadCount: number): ConversationItem {
    const thread = createP2PConversation({
      threadId,
      account: `u${threadId}`,
      publisherNamespaceId: 0,
      profileRev: 1,
      unreadCount,
    });
    return thread;
  }

  beforeEach(() => {
    items = signal<ConversationItem[]>([]);
    openThreadId = signal<number | undefined>(undefined);
    openAside = vi.fn();
    asideTop = signal<{ panel: 'profile' | 'group-info' } | undefined>(
      undefined,
    );

    TestBed.configureTestingModule({
      imports: [MessageHeaderComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: () => of({ domain: 'alpha.test', status: 'ACTIVE' }),
          },
        },
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
          useValue: { searchOpen: signal(false), openAside, asideTop },
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
          },
        },
        { provide: GroupService, useValue: {} },
        { provide: RouteService, useValue: {} },
        { provide: CallAdapterService, useValue: {} },
        {
          provide: CallEventService,
          useValue: { callState: signal({ ...IDLE_CALL }) },
        },
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

  it('opens friend info directly from More for a P2P conversation', () => {
    const chat = item(7, 0);
    fixture.componentRef.setInput('userMsgTrd', chat);

    comp.toggleMenu();

    expect(openAside).toHaveBeenCalledWith('profile');
  });

  it('opens group info directly from More for a group conversation', () => {
    const chat = createGroupConversation({
      threadId: 8,
      account: 'group-80',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Group 80', bio: '', avatarDigest: null },
    });
    fixture.componentRef.setInput('userMsgTrd', chat);

    comp.toggleMenu();

    expect(openAside).toHaveBeenCalledWith('group-info');
  });

  it('reports group More as expanded while the group panel is open', () => {
    const chat = createGroupConversation({
      threadId: 8,
      account: 'group-80',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Group 80', bio: '', avatarDigest: null },
      role: 'ADMIN',
    });
    fixture.componentRef.setInput('userMsgTrd', chat);
    asideTop.set({ panel: 'group-info' });

    expect(comp.moreExpanded()).toBe(true);
  });

  it('uses one as the member count and keeps More available after leaving a group', () => {
    const active = createGroupConversation({
      threadId: 8,
      account: 'group-80',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Group 80', bio: '', avatarDigest: null },
    });
    const chat = {
      ...active,
      conversationState: 'READ_ONLY' as const,
      meta: { ...active.meta, memberCount: 8 },
    };
    fixture.componentRef.setInput('userMsgTrd', chat);
    expect(comp.groupInactive()).toBe(true);
    expect(comp.groupMemberCount()).toBe(1);
    comp.toggleMenu();
    expect(openAside).toHaveBeenCalledWith('group-info');
    asideTop.set({ panel: 'group-info' });
    expect(comp.moreExpanded()).toBe(true);
  });
});
