import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { provideTransloco, provideTranslocoTranspiler } from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { ThreadListComponent } from './thread-list.component';
import { UserService } from '../../services/user.service';
import { RouteService, PopupType } from '../../services/route.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationLoadStatus } from '../../services/thread-store.service';
import { ConversationItem } from '../../services/model';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';

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
  let popupSpy: jasmine.Spy;
  let loadSpy: jasmine.Spy;
  let items: ReturnType<typeof signal<ConversationItem[]>>;
  let status: ReturnType<typeof signal<ConversationLoadStatus>>;

  beforeEach(() => {
    popupSpy = jasmine.createSpy('popupDlg');
    loadSpy = jasmine.createSpy('load');
    items = signal<ConversationItem[]>([]);
    status = signal<ConversationLoadStatus>(ConversationLoadStatus.LOADING);
    localStorage.removeItem('soms.lang');

    TestBed.configureTestingModule({
      imports: [ThreadListComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [{ id: 'en', label: 'English' }, { id: 'zh-CN', label: 'Simplified Chinese' }],
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
            items, status,
            error: signal(''),
            openThreadId: signal(undefined),
            topInserted: signal(null),
            load: loadSpy,
            clearTopInserted: () => { /* no-op — the FLIP effect calls this on a rAF; irrelevant here */ },
          },
        },
        { provide: UserService, useValue: { sessionProfile: () => undefined } },
        { provide: RouteService, useValue: { popupDlg: popupSpy } },
      ],
    });
    fixture = TestBed.createComponent(ThreadListComponent);
    comp = fixture.componentInstance;
  });

  /** Minimal P2P ConversationItem — only displayThreadName (→ peer nickname) is exercised by the filters. */
  function p2p(threadId: number, peerId: number, name = `User ${peerId}`): ConversationItem {
    return {
      threadId, id: threadId, type: 'P2P',
      peerUser: { id: peerId, account: `u${peerId}`, name } as ConversationItem['peerUser'],
    } as ConversationItem;
  }

  it('ngOnInit triggers load() on first mount (LOADING + empty list) — the initial-boot trigger', () => {
    comp.ngOnInit();
    expect(loadSpy).toHaveBeenCalledTimes(1);
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

  it('isSearchEmpty is false when a search term matches a thread', () => {
    items.set([p2p(1, 11)]);
    fixture.componentRef.setInput('searchText', 'user 11');
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it('isSearchEmpty is false with no search term, even on an empty list (no false "no results" state)', () => {
    items.set([]);
    fixture.componentRef.setInput('searchText', '');
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it('openFriendRequests opens the friend-requests popup', () => {
    comp.openFriendRequests();
    expect(popupSpy).toHaveBeenCalledWith(PopupType.FRIEND_REQUESTS);
  });
});
