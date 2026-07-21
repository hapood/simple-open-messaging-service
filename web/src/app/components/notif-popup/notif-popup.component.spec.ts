import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotifPopupComponent } from './notif-popup.component';
import { NotifPopupService } from '../../services/notif-popup.service';
import { NotificationActionHttp } from '../../services/notif-action.service';
import type { NotificationDescriptor } from '../../services/notification-descriptor.model';

describe('NotifPopupComponent', () => {
  let popupSvc: NotifPopupService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        NotifPopupService,
        NotificationActionHttp,
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
      actions: [{ id: 'mark-all-read', title: 'Mark all read' }],
      data: { threadIds: [1, 2] },
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
    expect(el.querySelector('.notif-btn')?.textContent?.trim()).toBe('Mark all read');
  });

  it('clicking the action button POSTs /notifications/action + dismisses the card', async () => {
    popupSvc.show([awayDescriptor()]);
    const fixture = TestBed.createComponent(NotifPopupComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    el.querySelector<HTMLButtonElement>('.notif-btn')!.click();

    const req = httpMock.expectOne('/api/v1/notifications/action');
    // The undefined threadId/seq are dropped by JSON serialization; threadIds carries.
    expect(req.request.body).toEqual({ tag: 'soms-away', actionId: 'mark-all-read', threadIds: [1, 2] });
    req.flush({ code: 0, message: 'ok', data: null });

    // Optimistic dismiss: the card is gone.
    await Promise.resolve();
    fixture.detectChanges();
    expect(el.querySelector('.notif-card')).toBeNull();
  });

  it('the dismiss button clears the card without a POST', () => {
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
