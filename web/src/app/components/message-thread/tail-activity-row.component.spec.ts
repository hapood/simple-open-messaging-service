import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { ProfileWatchService } from '../../services/profile-watch.service';
import { UserService } from '../../services/user.service';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { TailActivityRowComponent } from './tail-activity-row.component';

describe('TailActivityRowComponent', () => {
  let fixture: ComponentFixture<TailActivityRowComponent>;
  const watchProfile = vi.fn();

  beforeEach(async () => {
    watchProfile.mockReset().mockReturnValue(of(null));
    await TestBed.configureTestingModule({
      imports: [
        TailActivityRowComponent,
        TranslocoTestingModule.forRoot({
          langs: { en: { transfer: { openDetails: 'Open details' } } },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ProfileWatchService,
          useValue: { watchProfile },
        },
        {
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: vi.fn(() =>
              of({
                publisherNamespaceId: 0,
                profileNamespaceId: 0,
                domain: null,
                status: 'ACTIVE',
              }),
            ),
          },
        },
        {
          provide: UserService,
          useValue: {
            sessionProfile: signal(undefined),
            selfAvatarProfile: signal(undefined),
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TailActivityRowComponent);
  });

  it('keeps the exact same integer row height when peer-only, self-only, or both sides are visible', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);

    fixture.componentRef.setInput('peerVisible', true);
    fixture.componentRef.setInput('selfVisible', false);
    fixture.detectChanges();
    const peerOnlyHeight = host.offsetHeight;
    expect(peerOnlyHeight).toBe(40);

    fixture.componentRef.setInput('selfVisible', true);
    fixture.componentRef.setInput('selfDotsVisible', true);
    fixture.detectChanges();
    expect(host.offsetHeight).toBe(peerOnlyHeight);

    fixture.componentRef.setInput('peerVisible', false);
    fixture.detectChanges();
    expect(host.offsetHeight).toBe(peerOnlyHeight);
  });

  it('updates POST counts independently from gap dots and retains the count animator', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('selfVisible', true);
    fixture.componentRef.setInput('selfDotsVisible', true);
    fixture.componentRef.setInput('summary', { messageCount: 2, uploadCount: 0, failedCount: 0 });
    fixture.detectChanges();
    const indicator = host.querySelector('app-outbox-indicator');
    fixture.componentRef.setInput('summary', { messageCount: 0, uploadCount: 0, failedCount: 0 });
    fixture.detectChanges();
    expect(host.querySelector('.tail-self .dots')).not.toBeNull();
    expect(host.querySelector('app-outbox-indicator')).toBe(indicator);
    fixture.componentRef.setInput('summary', { messageCount: 1, uploadCount: 0, failedCount: 0 });
    fixture.componentRef.setInput('selfDotsVisible', false);
    fixture.detectChanges();
    expect(host.querySelector('.tail-self .dots')).toBeNull();
    expect(host.querySelector('app-flip-count')).not.toBeNull();
    expect(host.offsetHeight).toBe(40);
  });

  it('renders up to 3 overlapping avatars and ellipsis overflow without +N', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('peerVisible', true);
    fixture.componentRef.setInput('primaryPeerAccount', 'alice');
    fixture.componentRef.setInput('primaryPeerNamespaceId', 0);
    fixture.componentRef.setInput('overlapPeers', [
      { key: '0\0bob', account: 'bob', namespaceId: 0 },
      { key: '0\0carol', account: 'carol', namespaceId: 0 },
      { key: '0\0dave', account: 'dave', namespaceId: 0 },
    ]);
    fixture.componentRef.setInput('hasOverflow', true);
    fixture.detectChanges();

    expect(host.querySelectorAll('.overlap-avatar').length).toBe(3);
    expect(host.querySelector('.overlap-more')?.textContent?.trim()).toBe('…');
    expect(host.offsetHeight).toBe(40);
  });

  it('hides grouped avatars independently per side when continuation is true', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('peerVisible', true);
    fixture.componentRef.setInput('selfVisible', true);
    fixture.componentRef.setInput('selfDotsVisible', true);
    fixture.componentRef.setInput('peerContinuation', true);
    fixture.componentRef.setInput('selfContinuation', false);
    fixture.detectChanges();

    expect(
      host.querySelector('.tail-peer .tail-avatar-slot app-demand-avatar'),
    ).toBeNull();
    expect(
      host.querySelector('.tail-self .tail-avatar-slot app-demand-avatar'),
    ).not.toBeNull();
  });

  it('routes peer avatars through profile demand and distinguishes same account across namespaces', () => {
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('peerVisible', true);
    fixture.componentRef.setInput('primaryPeerAccount', 'alice');
    fixture.componentRef.setInput('primaryPeerNamespaceId', 1);
    fixture.componentRef.setInput('primaryPeerProfile', {
      account: 'alice',
      publisherNamespaceId: 1,
      profileNamespaceId: 0,
      rev: 2,
      linked: true,
    });
    fixture.componentRef.setInput('overlapPeers', [
      { key: '2\0alice', account: 'alice', namespaceId: 2 },
    ]);
    fixture.detectChanges();

    expect(watchProfile).toHaveBeenCalledWith({
      publisherNamespaceId: 1,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 2 },
    });

    const avatars = fixture.debugElement
      .queryAll(By.directive(DemandAvatarComponent))
      .map((de) => de.componentInstance as DemandAvatarComponent);
    expect(avatars.length).toBe(2);
    expect(avatars[0].view().name).toBe('alice');
    expect(avatars[1].view().name).toBe('alice');
    expect(avatars[0].view().colorKey).not.toBe(avatars[1].view().colorKey);
  });
});
