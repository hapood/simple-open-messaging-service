import { TestBed } from '@angular/core/testing';
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
import { ConversationItem } from '../../services/model';

/**
 * Covers ONLY the back-button unread badge (`otherUnreadCount` / `otherUnreadLabel`) — the compact-mode
 * "other conversations" total shown beside Back. ConversationListService is stubbed with controllable
 * signals (mirrors thread-list.component.spec.ts); every other dep is an empty stub since no field
 * initializer the badge touches reads them. No detectChanges — only the component's computeds are read
 * (rendering the template would pull in transloco + child components + CDK overlay unnecessarily).
 */
describe('MessageHeaderComponent — back-button unread badge', () => {
  let comp: MessageHeaderComponent;
  let items: ReturnType<typeof signal<ConversationItem[]>>;
  let openThreadId: ReturnType<typeof signal<number | undefined>>;

  /** Minimal ConversationItem — only threadId + unreadCount are exercised by the badge sum. */
  function item(threadId: number, unreadCount: number): ConversationItem {
    return {
      threadId,
      id: threadId,
      type: 'P2P',
      unreadCount,
      muted: false,
      pinned: false,
      lastMessageAt: null,
      lastMessagePreview: null,
      peerUser: {
        id: threadId * 10,
        account: `u${threadId}`,
        name: `User ${threadId}`,
      } as ConversationItem['peerUser'],
    } as ConversationItem;
  }

  beforeEach(() => {
    items = signal<ConversationItem[]>([]);
    openThreadId = signal<number | undefined>(undefined);

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
          useValue: { searchOpen: signal(false) },
        },
        {
          provide: LayoutService,
          useValue: {
            mode: signal<'compact' | 'medium' | 'expanded'>('compact'),
          },
        },
        { provide: MsgService, useValue: {} },
        { provide: UserService, useValue: {} },
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
    comp = TestBed.createComponent(MessageHeaderComponent).componentInstance;
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
});
