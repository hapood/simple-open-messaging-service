// @vitest-environment jsdom
import { ComponentRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { ConversationListService } from '../../services/conversation-list.service';
import { GroupService } from '../../services/group.service';
import { RouteService } from '../../services/route.service';
import { GroupAnnouncementComponent } from './group-announcement.component';

describe('GroupAnnouncementComponent', () => {
  let closeDlg: ReturnType<typeof vi.fn>;
  let markAnnouncementRead: ReturnType<typeof vi.fn>;
  let markAnnouncementReadLocally: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDlg = vi.fn();
    markAnnouncementRead = vi
      .fn()
      .mockReturnValue(
        of({ code: 0, message: 'ok', data: { announcementReadFeedId: 2 } }),
      );
    markAnnouncementReadLocally = vi.fn();

    TestBed.configureTestingModule({
      imports: [GroupAnnouncementComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en', 'zh-CN'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        { provide: RouteService, useValue: { closeDlg } },
        { provide: GroupService, useValue: { markAnnouncementRead } },
        {
          provide: ConversationListService,
          useValue: { markAnnouncementReadLocally },
        },
      ],
    });
  });

  function createComponent(
    text = 'Hello group!',
  ): ComponentRef<GroupAnnouncementComponent> {
    const fixture = TestBed.createComponent(GroupAnnouncementComponent);
    fixture.componentRef.setInput('threadId', 123);
    fixture.componentRef.setInput('feedId', '2');
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('createdAt', 1_000);
    fixture.componentRef.setInput('originCreatedAt', null);
    fixture.detectChanges();
    return fixture.componentRef;
  }

  it('renders standard page-header with back button and title, announcement body, and confirm button', () => {
    const ref = createComponent('Test notice content');
    const element: HTMLElement = ref.location.nativeElement;

    const backButton =
      element.querySelector<HTMLButtonElement>('.page-header__back');
    expect(backButton).not.toBeNull();

    const title = element.querySelector('.page-header__title');
    expect(title?.textContent).toContain('Group announcement');

    const times = element.querySelector('.announcement-times');
    expect(times?.textContent).toContain('Received:');
    expect(times?.textContent).not.toContain('Published:');

    const body = element.querySelector('.announcement-text');
    expect(body?.textContent).toContain('Test notice content');

    const confirmButton = element.querySelector<HTMLButtonElement>(
      '.announcement-actions button[mat-flat-button]',
    );
    expect(confirmButton).not.toBeNull();
    expect(confirmButton?.textContent).toContain('Confirm');
  });

  it('closes via route.closeDlg() when header back button is clicked', () => {
    const ref = createComponent();
    const element: HTMLElement = ref.location.nativeElement;

    const backButton =
      element.querySelector<HTMLButtonElement>('.page-header__back')!;
    backButton.click();

    expect(closeDlg).toHaveBeenCalledTimes(1);
  });

  it('closes via route.closeDlg() and marks read when confirm button is clicked', async () => {
    const ref = createComponent();
    const element: HTMLElement = ref.location.nativeElement;

    const confirmButton = element.querySelector<HTMLButtonElement>(
      '.announcement-actions button[mat-flat-button]',
    )!;
    confirmButton.click();

    expect(closeDlg).toHaveBeenCalledTimes(1);
  });

  it('displays retry button when acknowledgement fails', async () => {
    markAnnouncementRead.mockReturnValue(
      throwError(() => new Error('network error')),
    );
    const ref = createComponent();
    await ref.instance.acknowledge();

    const element: HTMLElement = ref.location.nativeElement;
    TestBed.tick?.();

    const retryButton = element.querySelector<HTMLButtonElement>(
      '.announcement-actions button[color="warn"]',
    );
    expect(retryButton).not.toBeNull();
    expect(retryButton?.textContent).toContain('Retry');
  });
});
