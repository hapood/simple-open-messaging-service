import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTransloco } from '@jsverse/transloco';
import { TestBed } from '@angular/core/testing';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { SendingTaskIndicatorComponent } from './sending-task-indicator.component';

describe('SendingTaskIndicatorComponent visibility', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
  });
  it('suppresses count flips until the latest face transition settles', () => {
    vi.useFakeTimers();
    try {
      const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
      fixture.detectChanges();
      fixture.componentRef.setInput('messageCount', 1);
      fixture.detectChanges();
      expect(fixture.componentInstance.countsAnimate()).toBe(false);
      vi.advanceTimersByTime(120);
      fixture.componentRef.setInput('messageCount', 0);
      fixture.detectChanges();
      fixture.componentRef.setInput('uploadCount', 1);
      fixture.detectChanges();
      vi.advanceTimersByTime(120);
      expect(fixture.componentInstance.countsAnimate()).toBe(false);
      vi.advanceTimersByTime(120);
      expect(fixture.componentInstance.countsAnimate()).toBe(true);
      fixture.componentRef.setInput('uploadCount', 2);
      fixture.detectChanges();
      expect(fixture.componentInstance.countsAnimate()).toBe(true);
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the composer face active without rendering zero counters', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('composerActive', true);
    expect(fixture.componentInstance.visible()).toBe(true);
    expect(fixture.componentInstance.messageCount()).toBe(0);
    expect(fixture.componentInstance.uploadCount()).toBe(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('app-flip-count').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('svg').length).toBe(0);
    fixture.componentRef.setInput('composerActive', false);
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('keeps failure-only state visible until explicitly cleared', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('failedCount', 2);
    expect(fixture.componentInstance.visible()).toBe(true);
    fixture.componentRef.setInput('failedCount', 0);
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('renders list presentation without a nested control and restores preview after failures clear', async () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('interactive', false);
    fixture.componentRef.setInput('bio', 'Last message');
    fixture.componentRef.setInput('failedCount', 1);
    fixture.detectChanges();
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    expect(el.querySelector('.failures')?.textContent?.trim()).toBe('1');
    expect(el.querySelector('.bio')?.getAttribute('aria-hidden')).toBe('true');
    fixture.componentRef.setInput('failedCount', 0);
    fixture.detectChanges();
    expect(
      el.querySelector('.faces')?.classList.contains('tasks-visible'),
    ).toBe(false);
    expect(el.querySelector('.bio')?.textContent?.trim()).toBe('Last message');
  });

  it('handles batched decrements and immediately removes zero-valued content', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('messageCount', 8);
    fixture.componentRef.setInput('uploadCount', 4);
    fixture.detectChanges();
    const groups = () => fixture.nativeElement.querySelectorAll('app-task-count-group');
    fixture.componentRef.setInput('messageCount', 3);
    fixture.detectChanges();
    expect(groups()[0].querySelector('app-flip-count .current').textContent).toBe('3');
    fixture.componentRef.setInput('messageCount', 0);
    fixture.detectChanges();
    expect(groups()[0].querySelector('svg, app-flip-count')).toBeNull();
    expect(groups()[1].querySelector('app-flip-count .current').textContent).toBe('4');
    fixture.destroy();
  });

  it('shows failures only after all sending work stops', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('failedCount', 3);
    fixture.componentRef.setInput('messageCount', 1);
    fixture.componentRef.setInput('uploadCount', 2);
    fixture.detectChanges();
    const failures = () => fixture.nativeElement.querySelector('.failures');
    expect(failures().querySelector('svg')).toBeNull();
    fixture.componentRef.setInput('messageCount', 0);
    fixture.detectChanges();
    expect(failures().querySelector('svg')).toBeNull();
    fixture.componentRef.setInput('uploadCount', 0);
    fixture.detectChanges();
    expect(failures().querySelector('app-flip-count .current').textContent).toBe('3');
    fixture.componentRef.setInput('messageCount', 2);
    fixture.detectChanges();
    expect(failures().querySelector('svg')).toBeNull();
    expect(fixture.componentInstance.failedCount()).toBe(3);
    fixture.destroy();
  });

  it('retains the indicator until both active counts reach zero', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('messageCount', 1);
    fixture.componentRef.setInput('uploadCount', 2);
    expect(fixture.componentInstance.visible()).toBe(true);
    fixture.componentRef.setInput('messageCount', 0);
    expect(fixture.componentInstance.visible()).toBe(true);
    fixture.componentRef.setInput('uploadCount', 0);
    expect(fixture.componentInstance.visible()).toBe(false);
  });
});
