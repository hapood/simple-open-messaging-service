import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { InlineTranslocoLoader } from '../i18n/transloco.loader';
import { createGroupConversation, createP2PConversation } from './model';
import { MsgService } from './message.service';
import { PopupType, RouteService } from './route.service';
import { ToastService } from './toast.service';
import { UserService } from './user.service';
import { ContactCardShareService } from './contact-card-share.service';

describe('ContactCardShareService', () => {
  it('opens the contact-card picker and sends to each selected conversation', async () => {
    let complete: ((result: { threadIds: number[] }) => void) | undefined;
    const popupDlg = vi.fn((...args: unknown[]) => {
      complete = args[2] as (result: { threadIds: number[] }) => void;
    });
    const sendContactCard = vi.fn(() => of({ code: 0 }));
    const info = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        ContactCardShareService,
        { provide: RouteService, useValue: { popupDlg } },
        { provide: MsgService, useValue: { sendContactCard } },
        {
          provide: UserService,
          useValue: { sessionProfile: () => ({ id: 1, name: 'Me' }) },
        },
        { provide: ToastService, useValue: { info, warn: vi.fn() } },
      ],
    });
    const service = TestBed.inject(ContactCardShareService);
    const chat = createP2PConversation(5, {
      account: 'alice',
      namespaceId: 0,
      profileRev: 1,
    });

    service.open(chat);
    expect(popupDlg).toHaveBeenCalledWith(
      PopupType.FORWARD,
      expect.objectContaining({ purpose: 'CHAT_CARD', recordKind: 'chat' }),
      expect.any(Function),
    );

    complete?.({ threadIds: [7, 8] });
    await vi.waitFor(() => expect(sendContactCard).toHaveBeenCalledTimes(2));
    expect(sendContactCard).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 7,
        target: {
          account: 'alice',
          namespaceId: 0,
          profileRev: 1,
        },
      }),
    );
    await vi.waitFor(() => expect(info).toHaveBeenCalled());

    const group = createGroupConversation(11, {
      id: 11,
      account: '!group12',
      domain: 'bravo.test',
      namespaceId: 4,
      profileRev: 6,
      name: 'Group',
    });
    service.open(group);
    complete?.({ threadIds: [9] });
    await vi.waitFor(() => expect(sendContactCard).toHaveBeenCalledTimes(3));
    expect(sendContactCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: 9,
        target: {
          account: '!group12',
          namespaceId: 4,
          profileRev: 6,
        },
      }),
    );
  });
});
