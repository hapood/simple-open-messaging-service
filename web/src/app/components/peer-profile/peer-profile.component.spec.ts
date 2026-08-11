import { TestBed } from '@angular/core/testing';
import {
  provideZonelessChangeDetection,
  signal,
  WritableSignal,
} from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { PeerProfileComponent } from './peer-profile.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ConversationItem, User } from '../../services/model';
import { UserService } from '../../services/user.service';
import { MsgService } from '../../services/message.service';
import { RouteService } from '../../services/route.service';
import { ThreadDeletionLockService } from '../../services/thread-deletion-lock.service';
import { ToastService } from '../../services/toast.service';

/**
 * PeerProfileComponent unit tests — profile resolution and panel navigation.
 */
function makeItem(over: { threadId?: number; userId?: number } = {}): {
  item: ConversationItem;
  peer: User;
} {
  const peer = {
    id: over.userId ?? 42,
    name: 'Alice',
    isForeigner: false,
    domain: null,
    updatedAt: 1,
    profileRev: 7,
  } as unknown as User;
  const item = {
    threadId: over.threadId ?? 5,
    peerUser: peer,
  } as unknown as ConversationItem;
  return { item, peer };
}

describe('PeerProfileComponent', () => {
  let comp: PeerProfileComponent;
  let items: WritableSignal<ConversationItem[]>;
  let openThreadId: WritableSignal<number | undefined>;
  let closeAside: jasmine.Spy;

  beforeEach(() => {
    TestBed.resetTestingModule();
    const { item } = makeItem();
    items = signal<ConversationItem[]>([item]);
    openThreadId = signal<number | undefined>(5);

    closeAside = jasmine.createSpy('closeAside');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: '简体中文' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        PeerProfileComponent,
        { provide: UserService, useValue: {} },
        { provide: MsgService, useValue: {} },
        { provide: RouteService, useValue: {} },
        { provide: ThreadDeletionLockService, useValue: {} },
        { provide: ToastService, useValue: {} },
        {
          provide: ConversationListService,
          useValue: {
            openThreadId,
            items,
          } as unknown as ConversationListService,
        },
        {
          provide: NavStateMachineService,
          useValue: {
            closeAside,
          } as unknown as NavStateMachineService,
        },
      ],
    })
      // These tests assert the component's class logic, not the DOM. Blank the
      // template so the view's transitive deps (<app-user-avatar> → AvatarRepository → HttpClient, IDB, …)
      // are never instantiated — the unit under test stays isolated from its view's rendering concerns.
      .overrideComponent(PeerProfileComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(PeerProfileComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('resolves the peer from the open thread', () => {
    expect(comp.peer()?.id).toBe(42);
    expect(comp.peerDisplayName()).toBe('Alice');
  });

  it('closes the profile panel when navigating back', () => {
    comp.goBack();
    expect(closeAside).toHaveBeenCalled();
  });
});
