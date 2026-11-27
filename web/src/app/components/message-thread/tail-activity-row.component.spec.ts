import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { of } from 'rxjs';
import { ProfileWatchService } from '../../services/profile-watch.service';
import { UserService } from '../../services/user.service';
import { TailActivityRowComponent } from './tail-activity-row.component';

describe('TailActivityRowComponent', () => {
  let fixture: ComponentFixture<TailActivityRowComponent>;

  beforeEach(async () => {
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
          useValue: { watchProfile: () => of(null) },
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
    fixture.componentRef.setInput('overlapPeers', [
      { key: '0\0bob', account: 'bob' },
      { key: '0\0carol', account: 'carol' },
      { key: '0\0dave', account: 'dave' },
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
});
