import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTransloco } from '@jsverse/transloco';
import { TestBed } from '@angular/core/testing';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { SendingTaskIndicatorComponent } from './sending-task-indicator.component';

describe('SendingTaskIndicatorComponent', () => {
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

  it('retargets the same SVG between spinner and circle-X without numeric sending counters', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('messageCount', 8);
    fixture.componentRef.setInput('uploadCount', 4);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(
      host.querySelector('app-flip-count, app-task-count-group'),
    ).toBeNull();
    expect(svg?.classList.contains('unavailable')).toBe(false);
    fixture.componentRef.setInput('unavailable', true);
    fixture.detectChanges();
    expect(host.querySelector('svg')).toBe(svg);
    expect(svg?.classList.contains('unavailable')).toBe(true);
    fixture.componentRef.setInput('unavailable', false);
    fixture.componentRef.setInput('messageCount', 1);
    fixture.detectChanges();
    expect(host.querySelector('svg')).toBe(svg);
    expect(svg?.classList.contains('unavailable')).toBe(false);
    expect(host.querySelector('.tasks')?.textContent?.trim()).toBe('');
  });

  it('keeps the composer face active without counters', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('composerActive', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.visible()).toBe(true);
    expect(
      fixture.nativeElement.querySelectorAll('app-flip-count').length,
    ).toBe(0);
    fixture.componentRef.setInput('composerActive', false);
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('shows failures only after active sending stops, then restores preview', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('bio', 'Last message');
    fixture.componentRef.setInput('failedCount', 3);
    fixture.componentRef.setInput('messageCount', 1);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('svg')?.classList.contains('unavailable')).toBe(
      false,
    );
    fixture.componentRef.setInput('messageCount', 0);
    fixture.detectChanges();
    expect(host.querySelector('svg')?.classList.contains('unavailable')).toBe(
      true,
    );
    expect(fixture.componentInstance.visible()).toBe(true);
    fixture.componentRef.setInput('failedCount', 0);
    fixture.detectChanges();
    expect(fixture.componentInstance.visible()).toBe(false);
    expect(host.querySelector('.bio')?.textContent).toBe('Last message');
  });

  it('keeps details clickable only on the visible interactive face', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    const open = vi.fn();
    fixture.componentInstance.openPanel.subscribe(open);
    fixture.componentRef.setInput('uploadCount', 1);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    host.querySelector('button')?.click();
    expect(open).toHaveBeenCalledOnce();
    fixture.componentRef.setInput('suppressed', true);
    fixture.detectChanges();
    expect(host.querySelector('button')?.tabIndex).toBe(-1);
    host.querySelector('button')?.click();
    expect(open).toHaveBeenCalledOnce();
  });

  it('renders list presentation without a nested control', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.componentRef.setInput('interactive', false);
    fixture.componentRef.setInput('failedCount', 1);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        'button, [role="button"], [tabindex]',
      ),
    ).toBeNull();
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

  it('marks host empty and uses fade-only mode when bio is blank', () => {
    const fixture = TestBed.createComponent(SendingTaskIndicatorComponent);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement;
    const faces = host.querySelector('.faces');
    expect(host.classList.contains('empty')).toBe(true);
    expect(faces?.classList.contains('fade-only')).toBe(true);
    fixture.componentRef.setInput('messageCount', 1);
    fixture.detectChanges();
    expect(host.classList.contains('empty')).toBe(false);
    expect(faces?.classList.contains('fade-only')).toBe(true);
    fixture.componentRef.setInput('messageCount', 0);
    fixture.componentRef.setInput('bio', 'Hello');
    fixture.detectChanges();
    expect(host.classList.contains('empty')).toBe(false);
    expect(faces?.classList.contains('fade-only')).toBe(false);
  });
});
