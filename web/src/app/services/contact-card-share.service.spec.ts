import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../i18n/transloco.loader';
import { createGroupConversation, createP2PConversation } from './model';
import { MsgService } from './message.service';
import { PopupType, RouteService } from './route.service';
import { ToastService } from './toast.service';
import { UserService } from './user.service';
import { ContactCardShareService } from './contact-card-share.service';
import { ProfileNamespaceRepository } from './profile-namespace-store.service';
import type { ForwardDialogResult } from '../components/forward-dialog/forward-dialog.component';
import type { ProfileNamespaceBinding } from './webdb-storage';

describe('ContactCardShareService', () => {
  let complete:
    | ((result: ForwardDialogResult) => void)
    | undefined;
  let popupDlg: ReturnType<typeof vi.fn>;
  let sendContactCard: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let binding$: Subject<ProfileNamespaceBinding>;

  function boot(binding: ProfileNamespaceBinding | { error: Error }): void {
    popupDlg = vi.fn((...args: unknown[]) => {
      complete = args[2] as (result: ForwardDialogResult) => void;
    });
    sendContactCard = vi.fn(() => of({ code: 0 }));
    info = vi.fn();
    warn = vi.fn();
    binding$ = new Subject<ProfileNamespaceBinding>();
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
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: 'error' in binding
              ? vi.fn(() => binding$.asObservable())
              : vi.fn(() => of(binding)),
          },
        },
        {
          provide: UserService,
          useValue: {
            sessionProfile: () => ({ id: 1, name: 'Me', account: 'me' }),
          },
        },
        { provide: ToastService, useValue: { info, warn } },
      ],
    });
  }

  const binding = (
    overrides: Partial<ProfileNamespaceBinding> = {},
  ): ProfileNamespaceBinding =>
    ({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      domain: 'alpha.test',
      status: 'ACTIVE',
      rootPublicKey: 'p'.repeat(43) + '=',
      updateFeedId: 1,
      changeSeq: 1,
      expired: false,
      refreshedAt: 0,
      ...overrides,
    }) as ProfileNamespaceBinding;

  it('builds the card from thread fields plus the namespace binding, then sends to each conversation', async () => {
    boot(binding());
    const service = TestBed.inject(ContactCardShareService);
    const chat = createP2PConversation(5, {
      account: 'alice',
      namespaceId: 0,
      profileRev: 1,
    });
    chat.peerUser.name = 'Alice Local';
    chat.peerUser.bio = 'Alice bio';

    service.open(chat);
    await vi.waitFor(() =>
      expect(popupDlg).toHaveBeenCalledWith(
        PopupType.FORWARD,
        expect.objectContaining({ kind: 'CHAT_CARD', recordKind: 'chat' }),
        expect.any(Function),
      ),
    );
    const forward = popupDlg.mock.calls[0][1] as {
      messages: Array<{ original: { text: string } }>;
    };
    expect(JSON.parse(forward.messages[0].original.text)).toEqual({
      account: 'alice',
      domain: 'alpha.test',
      publicKey: 'p'.repeat(43) + '=',
      displayName: 'Alice Local',
      bio: 'Alice bio',
    });

    complete?.({ threadIds: [7, 8], messages: [], mode: 'DIRECT' });
    await vi.waitFor(() => expect(sendContactCard).toHaveBeenCalledTimes(2));
    expect(sendContactCard).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 7,
        target: { account: 'alice', namespaceId: 0, profileRev: 1 },
      }),
    );
    await vi.waitFor(() => expect(info).toHaveBeenCalled());

    const group = createGroupConversation(11, {
      id: 11,
      account: '!group12',
      namespaceId: 4,
      profileRev: 6,
      name: 'Group',
    });
    service.open(group);
    await vi.waitFor(() => expect(popupDlg).toHaveBeenCalledTimes(2));
    complete?.({ threadIds: [9], messages: [], mode: 'DIRECT' });
    await vi.waitFor(() => expect(sendContactCard).toHaveBeenCalledTimes(3));
    expect(sendContactCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: 9,
        target: { account: '!group12', namespaceId: 4, profileRev: 6 },
      }),
    );
  });

  it.each([
    ['no domain', binding({ domain: null })],
    ['no root key', binding({ rootPublicKey: null })],
  ])('refuses to build a card when the binding has %s', async (_name, value) => {
    boot(value as ProfileNamespaceBinding);
    const service = TestBed.inject(ContactCardShareService);
    service.open(
      createP2PConversation(5, {
        account: 'alice',
        namespaceId: 0,
        profileRev: 1,
      }),
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('forward.sendFailed'));
    expect(popupDlg).not.toHaveBeenCalled();
  });
});
