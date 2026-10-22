import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AvatarComponent } from './avatar.component';
import { avatarColorKey } from './avatar-source';
import type { AvatarView } from './avatar-view';
import { UserAvatarType } from './model';

describe('AvatarComponent: pure presentation', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }),
  );

  function mount(overrides: Partial<AvatarView> = {}) {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('view', {
      name: 'Alice',
      imageUrl: null,
      type: UserAvatarType.OTHER,
      ...overrides,
    });
    fixture.detectChanges();
    return fixture;
  }

  it.each([
    ['Alice', 'AL'],
    ['Alice Smith', 'AS'],
    ['张小明', '张小'],
    ['👩🏽\u200d💻Alice', '👩🏽\u200d💻A'],
    ['', '?'],
  ])(
    'renders grapheme-safe initials for %s without any business providers',
    (name, expected) => {
      expect(mount({ name }).componentInstance.initial()).toBe(expected);
    },
  );

  it('renders the exact supplied image and falls back after an image error', () => {
    const fixture = mount({ imageUrl: 'blob:preview' });
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe(
      'blob:preview',
    );
    fixture.nativeElement
      .querySelector('img')
      .dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('AL');
  });

  it('retries an image after presentation identity changes', () => {
    const fixture = mount({ imageUrl: 'blob:shared', colorKey: 'a' });
    fixture.componentInstance.imgFailed.set(true);
    fixture.detectChanges();
    fixture.componentRef.setInput('view', {
      name: 'Bob',
      imageUrl: 'blob:shared',
      colorKey: 'b',
      type: UserAvatarType.OTHER,
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.showImage()).toBe(true);
  });

  it('keeps fallback colors stable across display-name changes', () => {
    const fixture = mount({ colorKey: 'stable' });
    const color = fixture.componentInstance.bg();
    fixture.componentRef.setInput('view', {
      name: 'Renamed',
      colorKey: 'stable',
      imageUrl: null,
      type: UserAvatarType.OTHER,
    });
    expect(fixture.componentInstance.bg()).toBe(color);
  });

  it('uses an explicit self appearance and a distinct group fallback', () => {
    expect(mount({ type: UserAvatarType.SELF }).componentInstance.bg()).toBe(
      'var(--app-avatar-self-bg)',
    );
    const group = mount({ type: UserAvatarType.GROUP });
    expect(group.componentInstance.groupFill().from).toBe(
      'var(--app-action-primary)',
    );
    expect(
      group.nativeElement
        .querySelector('.group-avatar-badge path')
        .getAttribute('transform'),
    ).toBe('translate(71 76) scale(1.25)');
  });

  it('renders federation and loading indicators only when explicitly requested', () => {
    const fixture = mount({ federatedDomain: 'remote.test' });
    const marker = fixture.nativeElement.querySelector(
      '.avatar-federated-icon',
    );
    expect(marker.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(marker.getAttribute('data-domain')).toBe('remote.test');
    expect(marker.querySelector('.avatar-federated-disc')).not.toBeNull();
    expect(marker.querySelector('.avatar-federated-halo')).not.toBeNull();
    fixture.componentRef.setInput('view', {
      name: '',
      imageUrl: null,
      type: UserAvatarType.OTHER,
      loading: true,
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.avatar-placeholder'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[role="img"]')).toBeNull();
  });

  it('keeps identity color selection outside the renderer', () => {
    const user = avatarColorKey({
      account: 'same',
      type: UserAvatarType.OTHER,
    });
    expect(
      avatarColorKey({ account: 'same', type: UserAvatarType.GROUP }),
    ).not.toBe(user);
    expect(
      avatarColorKey({
        account: 'same',
        domainSource: { type: 'snapshot', domain: 'remote.test' },
      }),
    ).not.toBe(user);
    expect(avatarColorKey({})).toBeUndefined();
  });
});
