import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ConnectionBannerComponent } from './connection-banner.component';
import { IndicatorSlotComponent } from '../indicator-slot/indicator-slot.component';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';
import { SessionStartupService } from '../../services/session-startup.service';

describe('connection indicator startup phase', () => {
  const state = signal<ConnectionState>('closed');
  const retryNow = vi.fn();
  let startup: SessionStartupService;

  beforeEach(() => {
    state.set('closed');
    retryNow.mockReset();
    TestBed.configureTestingModule({ providers: [
      { provide: WebsocketService, useValue: { state, reconnectIn: signal(null), retryNow } },
      { provide: LanguageService, useValue: { lang: signal('en') } },
      { provide: TranslocoService, useValue: { translate: (key: string) => key } },
      { provide: LiveAnnouncer, useValue: { announce: vi.fn() } },
    ] });
    startup = TestBed.inject(SessionStartupService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('reuses the chip across restoration and connection without a success flourish', () => {
    startup.restoring.set(true);
    const fixture = TestBed.createComponent(ConnectionBannerComponent);
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('button');
    expect(chip.dataset.state).toBe('restoring');
    expect(chip.classList.contains('expanded')).toBe(true);
    expect(fixture.componentInstance.label()).toBe('connection.restoring');
    state.set('connecting');
    startup.restoring.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBe(chip);
    expect(chip.dataset.state).toBe('connecting');
    expect(fixture.componentInstance.recovering()).toBe(false);
    state.set('open');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('routes restoration clicks only to backoff retry and hides on signed-out completion', () => {
    startup.restoring.set(true);
    const retry = vi.fn();
    const release = startup.offerRetry(5000, retry);
    const fixture = TestBed.createComponent(ConnectionBannerComponent);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button').click();
    expect(retry).toHaveBeenCalledOnce();
    expect(retryNow).not.toHaveBeenCalled();
    release();
    startup.restoring.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('retains the fixed viewport anchor and safe-area offset', () => {
    const fixture = TestBed.createComponent(IndicatorSlotComponent);
    fixture.nativeElement.style.setProperty('--soms-safe-top', '20px');
    fixture.detectChanges();
    const css = getComputedStyle(fixture.nativeElement);
    expect(css.position).toBe('fixed');
    expect(css.top).toBe('82px');
    expect(css.zIndex).toBe('52');
    expect(fixture.nativeElement.getBoundingClientRect().left + fixture.nativeElement.offsetWidth / 2)
      .toBeCloseTo(window.innerWidth / 2, 0);
  });
});
