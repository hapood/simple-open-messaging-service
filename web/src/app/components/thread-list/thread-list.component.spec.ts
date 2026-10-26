import { of, Subject } from 'rxjs';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import type { Mock } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import {
  provideTransloco,
  provideTranslocoTranspiler,
  TranslocoService,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { ThreadListComponent } from './thread-list.component';
import { UserService } from '../../services/user.service';
import { RouteService, PopupType } from '../../services/route.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationLoadStatus } from '../../services/thread-store.service';
import {
  ConversationItem,
  createGroupConversation,
  createP2PConversation,
  P2PConversationItem,
} from '../../services/model';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { WebdbService, WebdbStorage } from '../../services/webdb.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { By } from '@angular/platform-browser';
import { AppIconType, IconComponent } from '../icon/icon.component';

/**
 * ThreadListComponent is a thin view over the shared ConversationListService. This spec covers the
 * component's OWN logic only: the ngOnInit load-trigger guard, manual retry, local search filtering,
 * and the empty-state CTA. The list state machine itself (boot success / non-zero-code / network error
 * → status transitions, retry-clears-error) lives in ThreadRepository and is covered by
 * thread-store.service.spec.ts — driving it through the component would couple this spec to the repo's
 * boot choreography (IDB cache read + multiple HTTP requests).
 *
 * ConversationListService is stubbed with controllable signals so assertions stay at the component
 * boundary. This also avoids instantiating the real repo → WebdbService → WebsocketService chain: the
 * SSE worker is a `file://` cross-origin Worker that Karma cannot load from its `localhost:9876` origin.
 * No detectChanges — only component TS signals are read (pulling in child rendering + Material animations
 * is unnecessary and brittle).
 */
describe('ThreadListComponent', () => {
  let fixture: ComponentFixture<ThreadListComponent>;
  let comp: ThreadListComponent;
  let popupSpy: Mock;
  let loadSpy: Mock;
  let items: ReturnType<typeof signal<ConversationItem[]>>;
  let status: ReturnType<typeof signal<ConversationLoadStatus>>;

  beforeEach(() => {
    popupSpy = vi.fn().mockName('popupDlg');
    loadSpy = vi.fn().mockName('load');
    items = signal<ConversationItem[]>([]);
    status = signal<ConversationLoadStatus>(ConversationLoadStatus.LOADING);
    TestBed.configureTestingModule({
      imports: [ThreadListComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: () => of({ domain: 'remote.example', status: 'ACTIVE' }),
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
        // Stub the facade with the signals/methods the component reads. status starts at LOADING (the
        // fresh-store state) so the ngOnInit guard can be exercised.
        {
          provide: ConversationListService,
          useValue: {
            items,
            status,
            error: signal(''),
            openThreadId: signal(undefined),
            load: loadSpy,
          },
        },
        {
          provide: UserService,
          useValue: {
            sessionProfile: () => undefined,
            sessionUserId: signal(null),
          },
        },
        {
          provide: WebdbService,
          useFactory: () =>
            new WebdbStorage(
              () => null,
              new SessionLifecycleService(),
            ) as WebdbService,
        },
        { provide: RouteService, useValue: { popupDlg: popupSpy } },
      ],
    });
    fixture = TestBed.createComponent(ThreadListComponent);
    comp = fixture.componentInstance;
  });

  /** Empty profile projection; identity coordinates are available before profile hydration. */
  function p2p(threadId: number, peerId: number): P2PConversationItem {
    const item = createP2PConversation({
      threadId,
      account: `u${peerId}`,
      publisherNamespaceId: 0,
      profileRev: 1,
    });
    return item;
  }

  it('leaves the preview blank until a message body is available', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    const thread = p2p(1, 2);
    thread.messageEndSeq = 5;
    expect(comp.previewText(thread)).toBe('');
    thread.messageEndSeq = 0;
    expect(comp.previewText(thread)).toBe('');
    thread.lastMessagePreview = 'previous preview';
    thread.messageEndSeq = 6;
    expect(comp.previewText(thread)).toBe('previous preview');
  });

  it('ngOnInit triggers load() on first mount (LOADING + empty list) — the initial-boot trigger', () => {
    comp.ngOnInit();
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps initial loading visually quiet while exposing an accessible status', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.thread-list')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      TestBed.inject(TranslocoService).translate('common.loading'),
    );
    expect(host.querySelector('.tl-skeleton')).toBeNull();
  });

  it('ngOnInit skips load() when the list is already loaded (READY)', () => {
    status.set(ConversationLoadStatus.READY);
    items.set([p2p(1, 11)]);
    comp.ngOnInit();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('ngOnInit skips load() when items already exist even while still LOADING (shared store, mid-boot cache paint)', () => {
    items.set([p2p(1, 11)]);
    comp.ngOnInit();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('genThreadList always triggers load() (manual retry, regardless of state)', () => {
    status.set(ConversationLoadStatus.READY);
    comp.genThreadList();
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('isSearchEmpty is true when a search term matches no thread', () => {
    items.set([p2p(1, 11)]);
    fixture.componentRef.setInput('searchText', 'nonexistent');
    expect(comp.isSearchEmpty()).toBe(true);
  });

  it('isSearchEmpty is false when a search term matches a hydrated profile name', () => {
    const thread = p2p(1, 11);
    items.set([
      {
        ...thread,
        profile: { ...thread.profile, name: 'User 11' },
      },
    ]);
    fixture.componentRef.setInput('searchText', 'user 11');
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it('isSearchEmpty is false with no search term, even on an empty list (no false "no results" state)', () => {
    items.set([]);
    fixture.componentRef.setInput('searchText', '');
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it.each([
    ['[File set] · 4', '[文件集] · 4'],
    ['[System message]', '[系统消息]'],
    ['[Missed call]', '未接来电'],
    ['[Contact] Alice', '[名片] Alice'],
  ])('localizes the shared preview marker %s', (preview, expected) => {
    TestBed.inject(TranslocoService).setActiveLang('zh-CN');
    expect(
      comp.previewText({
        ...p2p(1, 11),
        lastMessagePreview: preview,
      }),
    ).toBe(expected);
  });

  it('openFriendRequests opens the friend-requests popup', () => {
    comp.openFriendRequests();
    expect(popupSpy).toHaveBeenCalledWith(PopupType.FRIEND_REQUESTS, {
      initialTab: 'add',
    });
  });

  it('renders each conversation as a native button with current and accessible state', async () => {
    const thread = {
      ...p2p(1, 11),
      unreadCount: 1000,
      muted: true,
      pinned: true,
      blocked: true,
      lastMessagePreview: 'Latest message',
      profile: {
        ...p2p(1, 11).profile,
        name: 'A very long conversation name',
      },
    };
    items.set([thread]);
    status.set(ConversationLoadStatus.READY);
    fixture.detectChanges();
    await fixture.whenStable();

    const row = fixture.nativeElement.querySelector(
      '.thread-item',
    ) as HTMLButtonElement;
    const blockedLabel =
      TestBed.inject(TranslocoService).translate('threadList.blocked');
    expect(row.tagName).toBe('BUTTON');
    expect(row.type).toBe('button');
    expect(row.getAttribute('aria-label')).toContain(
      'A very long conversation name',
    );
    expect(row.getAttribute('aria-label')).toContain('remote.example');
    expect(row.getAttribute('aria-label')).toContain(blockedLabel);
    expect(row.getAttribute('aria-label')).toContain('99+');
    expect(row.querySelector('.unread-badge')?.textContent?.trim()).toBe('99+');
    expect(row.querySelector('.thread-blocked')?.textContent?.trim()).toContain(
      blockedLabel,
    );
    expect(row.querySelector('.thread-msg')).toBeNull();
    const rows = row.querySelectorAll('.thread-row');
    expect(rows[0].querySelectorAll('.thread-status-icon')).toHaveLength(1);
    expect(rows[1].querySelectorAll('.thread-status-icon')).toHaveLength(0);
    expect(row.getAttribute('aria-label')).not.toContain(
      TestBed.inject(TranslocoService).translate('threadList.muted'),
    );
  });

  it('native row activation emits the selected conversation', async () => {
    const thread = p2p(1, 11);
    items.set([thread]);
    status.set(ConversationLoadStatus.READY);
    fixture.detectChanges();
    await fixture.whenStable();
    const selected: ConversationItem[] = [];
    comp.onSelect.subscribe((item) => selected.push(item));

    (
      fixture.nativeElement.querySelector('.thread-item') as HTMLButtonElement
    ).click();

    expect(selected).toEqual([thread]);
  });

  it('marks group avatars with a groups icon but leaves P2P avatars unbadged', async () => {
    items.set([
      createGroupConversation({
        threadId: 1,
        account: 'team',
        publisherNamespaceId: 0,
        profileRev: 0,
        profile: { name: 'Team', bio: '', avatarDigest: null },
      }),
      p2p(2, 12),
    ]);
    status.set(ConversationLoadStatus.READY);
    fixture.detectChanges();
    await fixture.whenStable();

    const rows = fixture.nativeElement.querySelectorAll(
      '.thread-item',
    ) as NodeListOf<HTMLElement>;
    expect(rows[0].querySelector('.group-avatar-badge')).not.toBeNull();
    expect(rows[1].querySelector('.group-avatar-badge')).toBeNull();
  });

  it('shows a separate @ badge only while the conversation has an unread mention', async () => {
    items.set([
      {
        ...p2p(1, 11),
        unreadCount: 2,
        mentionUnread: ['me'],
      },
    ]);
    status.set(ConversationLoadStatus.READY);
    fixture.detectChanges();
    await fixture.whenStable();

    const row = fixture.nativeElement.querySelector(
      '.thread-item',
    ) as HTMLElement;
    expect(
      row.querySelector('.mention-unread-badge')?.textContent?.trim(),
    ).toBe('@');
    expect(row.querySelector('.unread-badge')?.textContent?.trim()).toBe('2');
    expect(row.getAttribute('aria-label')).toContain(
      TestBed.inject(TranslocoService).translate('threadList.mentionedYou'),
    );
  });

  it('shows unread group join requests as a secondary member-add badge', async () => {
    const group = {
      ...createGroupConversation({
        threadId: 1,
        account: 'team',
        publisherNamespaceId: 0,
        profileRev: 0,
        profile: { name: 'Team', bio: '', avatarDigest: null },
      }),
      role: 'OWNER' as const,
    };
    items.set([
      {
        ...group,
        joinRequestReadFeedId: 4,
        joinRequestEndFeedId: 5,
      },
    ]);
    status.set(ConversationLoadStatus.READY);
    fixture.detectChanges();
    await fixture.whenStable();

    const badge = fixture.nativeElement.querySelector(
      '.join-request-badge',
    ) as HTMLElement;
    expect(badge).not.toBeNull();
    const icon = fixture.debugElement.query(
      By.css('.join-request-badge app-icon'),
    ).componentInstance as IconComponent;
    expect(icon.type()).toBe(AppIconType.GROUP_JOIN_REQUESTS);
    expect(badge.textContent?.trim()).toBe('');
  });
});
