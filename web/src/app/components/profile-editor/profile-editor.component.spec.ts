import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { UserService } from '../../services/user.service';
import { ProfileEditorComponent } from './profile-editor.component';

describe('ProfileEditorComponent', () => {
  function createComponent() {
    const sessionProfile = signal({
      id: 1,
      account: 'charlie',
      domain: 'local',
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
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return TestBed.createComponent(ProfileEditorComponent).componentInstance;
  }

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
});
