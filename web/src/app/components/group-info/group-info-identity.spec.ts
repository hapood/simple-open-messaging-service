import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslocoService } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { GroupInfoComponent } from './group-info.component';
import { NavStateMachineService } from '../../services/nav-state.service';
import { GroupService } from '../../services/group.service';
import { MemberProfileRepository } from '../../services/member-profile-store.service';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';
import { ContactCardShareService } from '../../services/contact-card-share.service';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import type { ProfileNamespaceBinding } from '../../services/webdb-storage';
import {
  createGroupConversation,
  type ConversationItem,
} from '../../services/model';

describe('GroupInfoComponent reactive display identity', () => {
  const group = (threadId: number, namespaceId: number) =>
    createGroupConversation(
      threadId,
      {
        id: threadId,
        account: '!room',
        name: 'Room',
        namespaceId,
      },
      { conversationState: 'READ_ONLY' },
    );
  let component: GroupInfoComponent;
  let items: ReturnType<typeof signal<ConversationItem[]>>;
  let openThreadId: ReturnType<typeof signal<number | undefined>>;
  let first: Subject<ProfileNamespaceBinding>;
  let second: Subject<ProfileNamespaceBinding>;
  let resolve: ReturnType<typeof vi.fn>;

  const binding = (
    domain: string | null,
    status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
  ) => ({
    publisherNamespaceId: 0,
    profileNamespaceId: 7,
    domain,
    status,
    rootPublicKey: null,
    updateFeedId: 1,
    changeSeq: 1,
    expired: false,
    refreshedAt: 1,
  });

  beforeEach(() => {
    items = signal([group(42, 7), group(43, 0)]);
    openThreadId = signal<number | undefined>(42);
    first = new Subject();
    second = new Subject();
    resolve = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    TestBed.configureTestingModule({
      providers: [
        ...[
          NavStateMachineService,
          GroupService,
          MemberProfileRepository,
          UserService,
          RouteService,
          HttpClient,
          TranslocoService,
          ToastService,
          MESSAGE_THREAD_ADAPTER,
          ContactCardShareService,
        ].map((provide) => ({ provide, useValue: {} })),
        { provide: ConversationListService, useValue: { items, openThreadId } },
        { provide: ProfileNamespaceRepository, useValue: { resolve } },
      ],
    });
    component = TestBed.runInInjectionContext(() => new GroupInfoComponent());
    TestBed.tick();
  });

  it('resolves the home-view pair and follows domain rebinds and archival', () => {
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      profileNamespaceId: 7,
    });
    expect(component.displayDomain()).toBe('');
    first.next(binding('remote.test'));
    expect(component.displayDomain()).toBe('remote.test');
    first.next(binding('rebound.test', 'ARCHIVED'));
    expect(component.displayDomain()).toBe('7.archive.rebound.test');
    first.next(binding(null));
    expect(component.displayDomain()).toBe('');
    expect(component.group()).not.toHaveProperty('domain');
  });

  it('clears a previous address on a thread switch and ignores its old stream', () => {
    first.next(binding('remote.test'));
    openThreadId.set(43);
    TestBed.tick();
    expect(resolve).toHaveBeenLastCalledWith({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
    });
    expect(component.displayDomain()).toBe('');
    first.next(binding('stale.test'));
    expect(component.displayDomain()).toBe('');
    second.next({ ...binding('home.test'), profileNamespaceId: 0 });
    expect(component.displayDomain()).toBe('home.test');
    openThreadId.set(undefined);
    TestBed.tick();
    expect(component.displayDomain()).toBe('');
  });

  it('degrades to account-only display when namespace resolution fails', () => {
    first.next(binding('remote.test'));
    first.error(new Error('unrecoverable'));
    expect(component.displayDomain()).toBe('');
    openThreadId.set(43);
    TestBed.tick();
    second.next({ ...binding('home.test'), profileNamespaceId: 0 });
    expect(component.displayDomain()).toBe('home.test');
  });
});
