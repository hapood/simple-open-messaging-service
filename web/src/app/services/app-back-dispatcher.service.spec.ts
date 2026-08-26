import { TestBed } from '@angular/core/testing';
import { AppBackDispatcherService } from './app-back-dispatcher.service';

describe('AppBackDispatcherService', () => {
  let service: AppBackDispatcherService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AppBackDispatcherService);
  });

  afterEach(() => {
    window.__SOMS_BACK__ = undefined;
  });

  it('dispatches temporary handlers in last-registered-first order', () => {
    const calls: string[] = [];
    service.setFallback(() => calls.push('fallback'));
    const unregisterFirst = service.register(() => calls.push('first'));
    const unregisterSecond = service.register(() => calls.push('second'));

    window.__SOMS_BACK__?.();
    unregisterSecond();
    window.__SOMS_BACK__?.();
    unregisterFirst();
    window.__SOMS_BACK__?.();

    expect(calls).toEqual(['second', 'first', 'fallback']);
  });

  it('can safely unregister a non-top handler', () => {
    const calls: string[] = [];
    const unregisterFirst = service.register(() => calls.push('first'));
    service.register(() => calls.push('second'));

    unregisterFirst();
    window.__SOMS_BACK__?.();

    expect(calls).toEqual(['second']);
  });
});
