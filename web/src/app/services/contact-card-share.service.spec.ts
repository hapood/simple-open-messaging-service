import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { InlineTranslocoLoader } from '../i18n/transloco.loader';
import { createP2PConversation } from './model';
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
      id: 42,
      account: 'alice',
      name: 'Alice',
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
      expect.objectContaining({ threadId: 7, targetUserId: 42 }),
    );
    await vi.waitFor(() => expect(info).toHaveBeenCalled());
  });
});
