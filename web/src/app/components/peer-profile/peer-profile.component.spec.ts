import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  NO_ERRORS_SCHEMA,
  provideZonelessChangeDetection,
  signal,
  WritableSignal,
} from '@angular/core';
import { provideTransloco, TranslocoPipe } from '@jsverse/transloco';
import { AsyncPipe } from '@angular/common';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import type { ProfileNamespaceBinding } from '../../services/webdb-storage';
import type { ComponentFixture } from '@angular/core/testing';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { PeerProfileComponent } from './peer-profile.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import {
  createP2PConversation,
  ConversationItem,
  User,
} from '../../services/model';
import { UserService } from '../../services/user.service';
import { MsgService } from '../../services/message.service';
import { RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';
import { BehaviorSubject, of } from 'rxjs';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { ContactCardShareService } from '../../services/contact-card-share.service';

/**
 * PeerProfileComponent unit tests — profile resolution and panel navigation.
 */
function makeItem(
  over: {
    threadId?: number;
    userId?: number;
  } = {},
): {
  item: ConversationItem;
  peer: User;
} {
  const peer = {
    id: over.userId ?? 42,
    account: 'alice',
    name: 'Alice',
    domain: 'local',
    namespaceId: 0,
    updatedAt: 1,
    profileRev: 7,
  } as unknown as User;
  const item = createP2PConversation({
    threadId: over.threadId ?? 5,
    account: peer.account,
    publisherNamespaceId: peer.namespaceId,
    profileRev: peer.profileRev,
    profile: { name: peer.name, bio: '', avatarDigest: null },
  });
  return { item, peer };
}

describe('PeerProfileComponent', () => {
  let comp: PeerProfileComponent;
  let fixture: ComponentFixture<PeerProfileComponent>;
  let binding: BehaviorSubject<ProfileNamespaceBinding>;
  let resolve: Mock;
  let items: WritableSignal<ConversationItem[]>;
  let openThreadId: WritableSignal<number | undefined>;
  let closeAside: Mock;
  let openSearch: Mock;
  let applyThreadMeta: Mock;
  let shareContact: Mock;
  let setMuted: Mock;
  let setPinned: Mock;
  let setBlocked: Mock;

  beforeEach(() => {
    TestBed.resetTestingModule();
    const { item } = makeItem();
    items = signal<ConversationItem[]>([item]);
    openThreadId = signal<number | undefined>(5);

    closeAside = vi.fn().mockName('closeAside');
    openSearch = vi.fn().mockName('openSearch');
    applyThreadMeta = vi.fn().mockName('applyThreadMeta');
    shareContact = vi.fn().mockName('shareContact');
    setMuted = vi.fn(() => of({ code: 0 })).mockName('setMuted');
    setPinned = vi.fn(() => of({ code: 0 })).mockName('setPinned');
    setBlocked = vi.fn(() => of({ code: 0 })).mockName('setBlocked');

    binding = new BehaviorSubject<ProfileNamespaceBinding>({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      domain: 'chat.example.test',
      rootPublicKey: null,
      updateFeedId: 1,
      changeSeq: 1,
      expired: false,
      status: 'ACTIVE',
      refreshedAt: Date.now(),
    });
    resolve = vi.fn(() => binding.asObservable());

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
        { provide: ProfileNamespaceRepository, useValue: { resolve } },
        { provide: UserService, useValue: {} },
        { provide: MsgService, useValue: {} },
        { provide: RouteService, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: ContactCardShareService, useValue: { open: shareContact } },
        {
          provide: MESSAGE_THREAD_ADAPTER,
          useValue: {
            setBlocked,
            setMuted,
            setPinned,
          },
        },
        {
          provide: ConversationListService,
          useValue: {
            openThreadId,
            items,
            applyThreadMeta,
          } as unknown as ConversationListService,
        },
        {
          provide: NavStateMachineService,
          useValue: {
            closeAside,
            openSearch,
          } as unknown as NavStateMachineService,
        },
      ],
    })
      // Render the real template while keeping child components and Material
      // controls outside this component's test boundary.
      .overrideComponent(PeerProfileComponent, {
        set: {
          imports: [AsyncPipe, NamespaceDomainPipe, TranslocoPipe],
          schemas: [NO_ERRORS_SCHEMA],
        },
      });
    fixture = TestBed.createComponent(PeerProfileComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('resolves the peer from the open thread', () => {
    expect(comp.peer()?.account).toBe('alice');
    expect(comp.peerDisplayName()).toBe('Alice');
  });

  it('renders the local address with the playground domain without whitespace', () => {
    const address = fixture.nativeElement.querySelector('.profile-meta');
    expect(address.textContent.trim()).toBe('alice@chat.example.test');
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
    });
  });

  it('reacts to domain rebinds and archived bindings', () => {
    binding.next({ ...binding.value, domain: 'rebound.test' });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.profile-meta').textContent.trim(),
    ).toBe('alice@rebound.test');

    binding.next({ ...binding.value, status: 'ARCHIVED' });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.profile-meta').textContent.trim(),
    ).toBe('alice@0.archive.rebound.test');
  });

  it('resolves the new namespace when switching to a remote peer', () => {
    items.update(([item]) => [{ ...item, publisherNamespaceId: 7 }]);
    binding.next({
      ...binding.value,
      profileNamespaceId: 7,
      domain: 'remote.test',
    });
    fixture.detectChanges();
    expect(resolve).toHaveBeenLastCalledWith({
      publisherNamespaceId: 0,
      profileNamespaceId: 7,
    });
    expect(
      fixture.nativeElement.querySelector('.profile-meta').textContent.trim(),
    ).toBe('alice@remote.test');
  });

  it('omits the separator when the binding has no domain', () => {
    binding.next({ ...binding.value, domain: null });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.profile-meta').textContent.trim(),
    ).toBe('alice');
  });

  it('closes the profile panel when navigating back', () => {
    comp.goBack();
    expect(closeAside).toHaveBeenCalled();
  });

  it('closes the panel and opens in-chat search', () => {
    comp.openSearch();

    expect(closeAside).toHaveBeenCalled();
    expect(openSearch).toHaveBeenCalled();
  });

  it('shares the open P2P contact', () => {
    comp.shareContact();

    expect(shareContact).toHaveBeenCalledWith(items()[0]);
  });

  it('optimistically mutes the conversation and persists it', () => {
    comp.setMuted(true);

    expect(applyThreadMeta).toHaveBeenCalledWith(5, { muted: true });
    expect(setMuted).toHaveBeenCalledWith({ threadId: 5, muted: true });
  });

  it('optimistically pins the conversation and persists it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    comp.setPinned(true);

    expect(applyThreadMeta).toHaveBeenCalledWith(5, {
      pinned: true,
      pinnedAt: 1234,
    });
    expect(setPinned).toHaveBeenCalledWith({ threadId: 5, pinned: true });
  });

  it('blocks immediately without opening a confirmation dialog', () => {
    comp.setBlocked(true);

    expect(setBlocked).toHaveBeenCalledWith({ threadId: 5, blocked: true });
    expect(applyThreadMeta).toHaveBeenCalledWith(5, { blocked: true });
  });

  it('keeps only conversation preferences after the friendship ends', () => {
    items.update(([item]) => [{ ...item, conversationState: 'READ_ONLY' }]);

    expect(comp.friendshipEnded()).toBe(true);
    comp.shareContact();
    comp.setBlocked(true);
    comp.removeFriend();

    expect(shareContact).not.toHaveBeenCalled();
    expect(setBlocked).not.toHaveBeenCalled();
  });
});
