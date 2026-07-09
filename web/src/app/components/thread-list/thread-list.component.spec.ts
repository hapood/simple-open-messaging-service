import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { provideTranslocoMessageformat } from '@jsverse/transloco-messageformat';
import { ThreadListComponent } from './thread-list.component';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';

/**
 * thread-list state-machine regression guard: focuses on the original bug where
 * `throw new Error(res.message)` written inside an RxJS `next` callback was swallowed
 * (on a non-zero API code / network failure the list would stick on a blank screen forever).
 *
 * Strategy: manually trigger ngOnInit() + flush the list endpoint, asserting only signal state —
 * no detectChanges, to avoid pulling in child-component rendering (EmptyState/UserAvatar) and
 * Material animation dependencies.
 */
describe('ThreadListComponent state machine', () => {
  let fixture: ComponentFixture<ThreadListComponent>;
  let comp: ThreadListComponent;
  let httpMock: HttpTestingController;
  let popupSpy: jasmine.Spy;

  beforeEach(() => {
    popupSpy = jasmine.createSpy('popupDlg');
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
        provideTranslocoMessageformat(),
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        { provide: RouteService, useValue: { popupDlg: popupSpy } },
      ],
    });
    fixture = TestBed.createComponent(ThreadListComponent);
    comp = fixture.componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** Trigger ngOnInit (won't auto-run before the first CD) and flush the list endpoint response. */
  function flushList(res: { code: number; message?: string; data?: unknown[] }) {
    comp.ngOnInit();
    const req = httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid'));
    req.flush(res);
    return req;
  }

  it('code===0 empty list → load complete, list empty, no search-empty state when no search term', () => {
    flushList({ code: 0, data: [] });
    expect(comp.items()).toEqual([]);
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it('code!==0 → enter ERROR without throwing (fixes the swallowed-throw bug)', () => {
    expect(() => flushList({ code: 1, message: 'backend rejected' })).not.toThrow();
    expect(comp.errorMsg()).toBe('backend rejected');
  });

  it('HTTP failure → enter ERROR (original code never covered the network-error path)', () => {
    comp.ngOnInit();
    const req = httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid'));
    req.flush('network down', { status: 500, statusText: 'Server Error' });
    // Locale-independent: the error message is whatever the active language resolves for the network
    // error key (the convList translates it via the same TranslocoService the test reads here).
    expect(comp.errorMsg()).toBe(TestBed.inject(TranslocoService).translate('errors.networkError'));
  });

  it('search term with no match → isSearchEmpty is true (search-no-results state)', () => {
    flushList({ code: 0, data: [{ id: 1, type: 'P2P', peerUser: { account: 'alice' } }] });
    fixture.componentRef.setInput('searchText', 'nonexistent user');
    expect(comp.isSearchEmpty()).toBe(true);
  });

  it('retry: genThreadList after ERROR clears errorMsg before re-requesting', () => {
    flushList({ code: 1, message: 'x' });
    expect(comp.errorMsg()).toBe('x');
    comp.genThreadList();
    expect(comp.errorMsg()).toBe(''); // reset back to LOADING
    httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid')).flush({ code: 0, data: [] });
    expect(comp.items()).toEqual([]);
  });

  it('empty-state CTA: openFriendRequests → calls routeService.popupDlg', () => {
    comp.openFriendRequests();
    expect(popupSpy).toHaveBeenCalled();
  });
});
