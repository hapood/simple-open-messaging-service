import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { of, throwError } from 'rxjs';
import { UserService } from '../../services/user.service';
import { LocalDomainService } from '../../services/local-domain.service';
import { ProfileEditorComponent } from './profile-editor.component';

describe('ProfileEditorComponent', () => {
  function createComponent() {
    const sessionProfile = signal({
      id: 1,
      account: 'charlie',
      domain: 'chat.example.test',
      name: 'Charlie',
      bio: '',
      avatar: '',
    });
    TestBed.configureTestingModule({
      imports: [ProfileEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: {
            sessionProfile,
            updateSessionProfile: vi.fn(),
            updateProfile: vi.fn(),
          },
        },
        {
          provide: LocalDomainService,
          useValue: { domain: signal('chat.example.test') },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return TestBed.createComponent(ProfileEditorComponent).componentInstance;
  }

  it('renders the account address from the namespace domain', () => {
    const component = createComponent();

    expect(component.accountAddress()).toBe('charlie@chat.example.test');
  });

  it('counts and limits nickname and bio by Unicode code points', () => {
    const component = createComponent();

    component.onNameInput('😀'.repeat(40));
    component.onBioInput('🧪'.repeat(140));

    expect(component.name()).toBe('😀'.repeat(31));
    expect(component.nameLength()).toBe(31);
    expect(component.bio()).toBe('🧪'.repeat(120));
    expect(component.bioLength()).toBe(120);
    expect(component.isNameValid()).toBe(true);
  });

  it('shows a localized rejection for an invalid avatar and keeps the draft for retry', async () => {
    const component = createComponent();
    const user = TestBed.inject(UserService);
    vi.mocked(user.updateProfile).mockReturnValue(
      of({ code: 10000, message: 'invalid avatar' }),
    );
    const avatar = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    component.pendingAvatar.set(avatar);

    await component.save();

    expect(component.saving()).toBe(false);
    expect(component.saveError()).toBe('profile.avatarInvalid');
    expect(component.pendingAvatar()).toBe(avatar);
    expect(user.updateSessionProfile).not.toHaveBeenCalled();
    component.onNameInput('New name');
    expect(component.saveError()).toBe('');
  });

  it('shows failures for other business responses and network errors, then clears on retry', async () => {
    const component = createComponent();
    const user = TestBed.inject(UserService);
    component.onBioInput('new bio');
    vi.mocked(user.updateProfile).mockReturnValueOnce(
      of({ code: 99999, message: 'server rejection' }),
    );
    await component.save();
    expect(component.saveError()).toBe('server rejection');

    vi.mocked(user.updateProfile).mockReturnValueOnce(
      throwError(() => new Error('offline')),
    );
    await component.save();
    expect(component.saveError()).toBe('profile.saveFailed');
    expect(component.saving()).toBe(false);
    expect(component.canSave()).toBe(true);
  });
});
