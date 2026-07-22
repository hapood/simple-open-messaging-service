import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotifPopupComponent } from './notif-popup.component';
import { NotifPopupService } from '../../services/notif-popup.service';
import { NotificationActionHttp } from '../../services/notif-action.service';
import { ConversationListService } from '../../services/conversation-list.service';
import type { NotificationDescriptor } from '../../services/notification-descriptor.model';

describe('NotifPopupComponent', () => {
  let popupSvc: NotifPopupService;
  let httpMock: HttpTestingController;
  let advanceMissedCursor: jasmine.Spy;

  beforeEach(() => {
    advanceMissedCursor = jasmine.createSpy('advanceMissedCursor');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        NotifPopupService,
        NotificationActionHttp,
        { provide: ConversationListService, useValue: { advanceMissedCursor } },
      ],
    });
    popupSvc = TestBed.inject(NotifPopupService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  function awayDescriptor(): NotificationDescriptor {
    return {
      tag: 'soms-away',
      kind: 'message-summary',
      title: 'SOMS',
      body: 'Alice, Bob sent you 5 messages',
      lang: 'en',
      icon: null,
      renotify: false,
      actions: [{ id: 'dismiss', title: 'Dismiss' }],
      // The new away-HWM target the dismiss action advances to.
      data: { threadId: 7, seq: 3 },
    };
  }

  it('renders nothing when there are no popups', () => {
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notif-card')).toBeNull();
  });

  it('renders the popup body + action button from the service signal', () => {
    popupSvc.show([awayDescriptor()]);
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Alice, Bob sent you 5 messages');
    expect(el.querySelector('.notif-btn')?.textContent?.trim()).toBe('Dismiss');
  });

  it('clicking dismiss advances the away-HWM + clears the card WITHOUT a POST (pure frontend)', async () => {
    popupSvc.show([awayDescriptor()]);
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    el.querySelector<HTMLButtonElement>('.notif-btn')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    // `dismiss` is pure frontend: it advances the away-HWM to the descriptor's cursor + closes the card,
    // never POSTing + never touching the read watermark.
    expect(advanceMissedCursor).toHaveBeenCalledWith({ threadId: 7, seq: 3 });
    httpMock.expectNone('/api/v1/notifications/action');
    expect(el.querySelector('.notif-card')).toBeNull();
  });

  it('a reply action POSTs /notifications/action with the descriptor routing data + dismisses', async () => {
    popupSvc.show([
      {
        tag: 'soms-msg-7', kind: 'message-summary', title: 'SOMS', body: 'Alice sent you a message',
        lang: 'en', icon: null, renotify: false,
        actions: [{ id: 'reply', title: 'Reply' }],
        data: { threadId: 7, seq: 3 },
      },
    ]);
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    el.querySelector<HTMLButtonElement>('.notif-btn')!.click();

    const req = httpMock.expectOne('/api/v1/notifications/action');
    expect(req.request.body).toEqual({ tag: 'soms-msg-7', actionId: 'reply', threadId: 7, seq: 3 });
    req.flush({ code: 0, message: 'ok', data: null });

    await Promise.resolve();
    fixture.detectChanges();
    expect(el.querySelector('.notif-card')).toBeNull();
  });

  it('the dismiss (×) button clears the card without a POST', () => {
    popupSvc.show([awayDescriptor()]);
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    el.querySelector<HTMLButtonElement>('.notif-close')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.notif-card')).toBeNull();
    httpMock.expectNone('/api/v1/notifications/action');
  });
});
