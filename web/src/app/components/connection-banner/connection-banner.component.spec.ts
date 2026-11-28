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

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retargets a recovery fade from its current visual and rejects stale recovery timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timers = vi.spyOn(window, 'setTimeout');
    state.set('reconnecting');
    const fixture = TestBed.createComponent(ConnectionBannerComponent);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const chip = host.querySelector<HTMLButtonElement>('button')!;
    state.set('open');
    fixture.detectChanges();
    const staleTimer = timers.mock.calls.find((call) => call[1] === 980)?.[0];
    expect(typeof staleTimer).toBe('function');
    vi.advanceTimersByTime(980);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const fade = chip.getAnimations().find((animation) =>
      animation.effect instanceof KeyframeEffect &&
      animation.effect.getKeyframes().some((frame) => frame['opacity'] === '0'),
    );
    expect(fade).toBeDefined();
    fade!.pause();
    fade!.currentTime = 180;
    const opacity = getComputedStyle(chip).opacity;
    state.set('reconnecting');
    fixture.detectChanges();
    expect(host.querySelector('button')).toBe(chip);
    expect(chip.dataset['state']).toBe('reconnecting');
    expect(fixture.componentInstance.recovering()).toBe(false);
    expect(chip.classList.contains('expanded')).toBe(true);
    expect(fade!.playState).toBe('idle');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const enter = chip.getAnimations().find((animation) =>
      animation.effect instanceof KeyframeEffect &&
      animation.effect.getKeyframes().some((frame) => frame['opacity'] === '1'),
    );
    expect(enter?.effect).toBeInstanceOf(KeyframeEffect);
    if (enter?.effect instanceof KeyframeEffect) {
      expect(Number(enter.effect.getKeyframes()[0]['opacity'])).toBeCloseTo(Number(opacity), 4);
    }
    state.set('open');
    fixture.detectChanges();
    if (typeof staleTimer === 'function') staleTimer();
    expect(fixture.componentInstance.recovering()).toBe(true);
    state.set('reconnecting');
    fixture.detectChanges();
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    fixture.detectChanges();
    expect(chip.dataset['state']).toBe('reconnecting');
    expect(chip.style.opacity).toBe('1');
  });

  it('snaps reduced-motion recovery and never lets an interrupted hold hide a newer chip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    vi.spyOn(media, 'matches', 'get').mockReturnValue(true);
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    state.set('reconnecting');
    const fixture = TestBed.createComponent(ConnectionBannerComponent);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    state.set('open');
    fixture.detectChanges();
    vi.advanceTimersByTime(500);
    state.set('reconnecting');
    fixture.detectChanges();
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    const chip = host.querySelector<HTMLButtonElement>('button')!;
    expect(chip.dataset['state']).toBe('reconnecting');
    expect(chip.style.opacity).toBe('1');
    expect(chip.getAnimations()).toHaveLength(0);
    state.set('open');
    fixture.detectChanges();
    vi.advanceTimersByTime(980);
    fixture.detectChanges();
    expect(host.querySelector('button')).toBeNull();
  });

  it('cancels active recovery animations and invalidates held timers on destruction', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timers = vi.spyOn(window, 'setTimeout');
    state.set('reconnecting');
    const fixture = TestBed.createComponent(ConnectionBannerComponent);
    fixture.detectChanges();
    state.set('open');
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const chip = host.querySelector<HTMLButtonElement>('button')!;
    const staleTimer = timers.mock.calls.find((call) => call[1] === 980)?.[0];
    vi.advanceTimersByTime(980);
    fixture.destroy();
    if (typeof staleTimer === 'function') staleTimer();
    vi.advanceTimersByTime(2000);
    expect(chip.getAnimations()).toHaveLength(0);
    expect(fixture.componentInstance.recovering()).toBe(false);
  });

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
