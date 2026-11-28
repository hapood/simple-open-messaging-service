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
import { SendingTaskPresentation } from '../../services/sending-task-presentation.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { WebdbService } from '../../services/webdb.service';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';

describe('TailActivityRowComponent', () => {
  let fixture: ComponentFixture<TailActivityRowComponent>;
  const watchProfile = vi.fn();
  const connection = signal<ConnectionState>('open');

  beforeEach(async () => {
    connection.set('open');
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
        { provide: WebsocketService, useValue: { state: connection } },
        { provide: WebdbService, useValue: { enqueuePendingSend: vi.fn().mockResolvedValue(undefined) } },
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
    expect(peerOnlyHeight).toBe(43);

    fixture.componentRef.setInput('selfVisible', true);
    fixture.detectChanges();
    expect(host.offsetHeight).toBe(peerOnlyHeight);

    fixture.componentRef.setInput('peerVisible', false);
    fixture.detectChanges();
    expect(host.offsetHeight).toBe(peerOnlyHeight);
  });

  it('uses normal message avatar geometry, timeline inset, and incoming bubble tokens', () => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.setProperty('--chat-timeline-inset-inline', '16px');
    host.style.setProperty('--chat-bubble-incoming', 'rgb(220, 225, 230)');
    host.style.setProperty('--chat-text-incoming', 'rgb(30, 35, 40)');
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('peerVisible', true);
    fixture.detectChanges();

    const row = host.querySelector<HTMLElement>('.tail-activity-row')!;
    const avatar = host.querySelector<HTMLElement>('.tail-peer .msg-avatar')!;
    const bubble = host.querySelector<HTMLElement>('.tail-peer .tail-bubble')!;
    expect(avatar.offsetWidth).toBe(40);
    expect(avatar.offsetHeight).toBe(40);
    expect(getComputedStyle(avatar).alignSelf).toBe('flex-start');
    expect(getComputedStyle(row).paddingLeft).toBe('16px');
    expect(getComputedStyle(row).paddingRight).toBe('16px');
    expect(
      bubble.getBoundingClientRect().left - avatar.getBoundingClientRect().left,
    ).toBe(48);
    expect(getComputedStyle(bubble).backgroundColor).toBe('rgb(220, 225, 230)');
    expect(getComputedStyle(bubble).color).toBe('rgb(30, 35, 40)');

    const bubbleLeft = bubble.getBoundingClientRect().left;
    fixture.componentRef.setInput('peerContinuation', true);
    fixture.detectChanges();
    expect(bubble.getBoundingClientRect().left).toBe(bubbleLeft);
    expect(getComputedStyle(bubble).borderTopLeftRadius).toBe('6px');
    expect(host.offsetHeight).toBe(43);
  });

  it('reserves the self avatar column only when the normal message preference enables it', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('selfVisible', true);
    fixture.detectChanges();

    const avatar = host.querySelector<HTMLElement>('.tail-self .msg-avatar')!;
    const bubble = host.querySelector<HTMLElement>('.tail-self .tail-bubble')!;
    const withoutAvatarRight = bubble.getBoundingClientRect().right;
    expect(avatar.offsetWidth).toBe(0);

    host.setAttribute('data-show-self-avatar', 'true');
    expect(avatar.offsetWidth).toBe(40);
    expect(withoutAvatarRight - bubble.getBoundingClientRect().right).toBe(48);
    fixture.componentRef.setInput('selfContinuation', true);
    fixture.detectChanges();
    expect(avatar.querySelector('app-demand-avatar')).toBeNull();
    expect(avatar.offsetWidth).toBe(40);
    expect(host.offsetHeight).toBe(43);

    host.setAttribute('data-show-self-avatar', 'false');
    expect(bubble.getBoundingClientRect().right).toBe(withoutAvatarRight);
  });

  it('renders only clickable self dots for owner-projected activity, never an extra status icon', () => {
    const host: HTMLElement = fixture.nativeElement;
    const open = vi.fn();
    fixture.componentInstance.openPanel.subscribe(open);
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('selfVisible', true);
    fixture.detectChanges();
    const dots = host.querySelector<HTMLButtonElement>('.tail-self .dots')!;
    expect(dots.querySelectorAll('i')).toHaveLength(3);
    expect(host.querySelectorAll('.tail-self button')).toHaveLength(1);
    expect(host.querySelector('app-outbox-indicator, app-flip-count, .tail-self .tail-bubble svg, .cue-content')).toBeNull();
    dots.click();
    expect(open).toHaveBeenCalledOnce();
    expect(host.offsetHeight).toBe(43);
    fixture.componentRef.setInput('selfVisible', false);
    fixture.detectChanges();
    expect(host.querySelector('.tail-activity-row')).toBeNull();
  });

  it.each(['multiple', 'failed', 'unavailable'] as const)(
    'keeps self dots and details without extra icons for %s owner tasks', async (phase) => {
      const outbox = TestBed.inject(ThreadSendOutbox);
      const presentation = TestBed.inject(SendingTaskPresentation);
      for (const clientMessageId of ['first', 'second']) {
        await outbox.enqueue({ clientMessageId, threadId: 7, item: { type: 'PURE_TEXT', content: 'hello' } });
        if (phase === 'failed') outbox.setPhase(clientMessageId, 'failed');
      }
      if (phase === 'unavailable') connection.set('reconnecting');
      const summary = presentation.forThread(7);
      const open = vi.fn();
      fixture.componentInstance.openPanel.subscribe(open);
      fixture.componentRef.setInput('enabled', true);
      fixture.componentRef.setInput('selfVisible', summary.messageCount > 0 || summary.uploadCount > 0 || summary.failedCount > 0);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelectorAll('.tail-self .dots i')).toHaveLength(3);
      expect(host.querySelector('app-outbox-indicator, app-flip-count, .tail-self .tail-bubble svg')).toBeNull();
      host.querySelector<HTMLButtonElement>('.tail-self .dots')!.click();
      expect(open).toHaveBeenCalledOnce();
    },
  );

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
    expect(host.offsetHeight).toBe(43);
  });

  it('hides grouped avatars independently per side when continuation is true', () => {
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('enabled', true);
    fixture.componentRef.setInput('peerVisible', true);
    fixture.componentRef.setInput('selfVisible', true);
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
