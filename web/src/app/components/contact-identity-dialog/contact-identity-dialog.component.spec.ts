import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  ContactIdentityDialogComponent,
  type ContactIdentityDialogData,
} from './contact-identity-dialog.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { RouteService, PopupType } from '../../services/route.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { UserService } from '../../services/user.service';
import { LocalDomainService } from '../../services/local-domain.service';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';

@Component({ selector: 'app-demand-avatar', template: '' })
class DemandAvatarStub {
  readonly type = input<unknown>();
  readonly name = input<unknown>();
  readonly account = input<unknown>();
  readonly domainSource = input<unknown>();
  readonly profile = input<AvatarProfileRef>();
}

const ref: AvatarProfileRef = {
  account: 'alice',
  publisherNamespaceId: 7,
  profileNamespaceId: 2,
  rev: 3,
  linked: true,
  groupAccount: '!team',
};
const identity: ContactIdentityDialogData = {
  account: 'alice',
  name: 'Alice',
  bio: 'Bio',
  domain: 'remote.test',
  namespaceId: 2,
  profile: ref,
};

describe('ContactIdentityDialog rendering and existing navigation', () => {
  const popupDlg = vi.fn();
  const openChat = vi.fn();
  const localRelationship = vi.fn();
  const hasPendingGroupApplication = vi.fn();

  beforeEach(() => {
    popupDlg.mockClear();
    openChat.mockClear();
    localRelationship.mockReset().mockResolvedValue('NONE');
    hasPendingGroupApplication.mockReset().mockResolvedValue(false);
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        { provide: RouteService, useValue: { popupDlg, closeDlg: vi.fn() } },
        { provide: NavStateMachineService, useValue: { openChat } },
        {
          provide: LocalDomainService,
          useValue: { domain: () => 'local.test' },
        },
        {
          provide: UserService,
          useValue: { localRelationship, hasPendingGroupApplication },
        },
      ],
    }).overrideComponent(ContactIdentityDialogComponent, {
      remove: { imports: [DemandAvatarComponent] },
      add: { imports: [DemandAvatarStub] },
    });
  });

  function mount(overrides: Partial<ContactIdentityDialogData> = {}) {
    const fixture = TestBed.createComponent(ContactIdentityDialogComponent);
    fixture.componentRef.setInput('identity', { ...identity, ...overrides });
    fixture.detectChanges();
    return fixture;
  }

  it('renders the demand ref while retaining the initial-user navigation without a public-key prerequisite', () => {
    const fixture = mount();
    expect(
      fixture.debugElement
        .query(By.directive(DemandAvatarStub))
        .componentInstance.profile(),
    ).toBe(ref);
    expect(
      fixture.nativeElement.querySelector('app-snapshot-avatar'),
    ).toBeNull();
    expect(fixture.componentInstance.actionDisabled()).toBe(false);
    fixture.componentInstance.act();
    expect(popupDlg).toHaveBeenCalledWith(PopupType.FRIEND_REQUESTS, {
      initialUser: {
        id: 0,
        account: 'alice',
        name: 'Alice',
        bio: 'Bio',
        domain: 'remote.test',
        namespaceId: 2,
        isGroup: false,
        profile: ref,
      },
    });
    expect(popupDlg.mock.calls[0][1]).not.toHaveProperty('initialAddress');
    expect(popupDlg.mock.calls[0][1].initialUser).not.toHaveProperty('avatar');
    fixture.destroy();
  });

  it('does not skip the existing relationship lookup for a remote publisher', async () => {
    const fixture = mount();
    await fixture.whenStable();
    expect(localRelationship).toHaveBeenCalledWith({
      id: 0,
      account: 'alice',
      namespaceId: 2,
    });
    fixture.destroy();
  });

  it('opens the existing friend chat instead of redirecting a remote publisher into discovery', () => {
    const fixture = mount({ friendThreadId: 12, relationship: 'FRIEND' });
    fixture.componentInstance.act();
    expect(openChat).toHaveBeenCalledExactlyOnceWith(12);
    expect(popupDlg).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('retains the pending-request navigation for a remote publisher', async () => {
    localRelationship.mockResolvedValue('INCOMING_PENDING');
    const fixture = mount({ relationship: 'INCOMING_PENDING' });
    await fixture.whenStable();
    fixture.componentInstance.act();
    expect(popupDlg).toHaveBeenCalledExactlyOnceWith(
      PopupType.FRIEND_REQUESTS,
      { initialTab: 'pending' },
    );
    fixture.destroy();
  });

  it('opens an existing group chat instead of redirecting into discovery', () => {
    const fixture = mount({ account: '!team', groupThreadId: 77 });
    fixture.componentInstance.act();
    expect(openChat).toHaveBeenCalledExactlyOnceWith(77);
    expect(popupDlg).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('retains the group-application entry without introducing a public-key prerequisite', async () => {
    const fixture = mount({ account: '!team' });
    await fixture.whenStable();
    expect(hasPendingGroupApplication).toHaveBeenCalledWith({
      account: '!team',
      namespaceId: 2,
    });
    fixture.componentInstance.act();
    expect(popupDlg).toHaveBeenCalledWith(PopupType.FRIEND_INVITE, {
      standalone: true,
      user: expect.objectContaining({ account: '!team', profile: ref }),
    });
    fixture.destroy();
  });
});
