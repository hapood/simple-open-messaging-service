import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { OutboxIndicatorComponent } from './outbox-indicator.component';

describe('outbox indicator browser geometry', () => {
  it('keeps an integer-height, counter-free SVG while rapidly retargeting status', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
    const fixture = TestBed.createComponent(OutboxIndicatorComponent);
    const host: HTMLElement = fixture.nativeElement;
    fixture.componentRef.setInput('messageCount', 8);
    fixture.componentRef.setInput('uploadCount', 12);
    fixture.detectChanges();
    await fixture.whenStable();
    const svg = host.querySelector('svg');
    expect(host.offsetHeight).toBe(20);
    fixture.componentRef.setInput('unavailable', true);
    fixture.detectChanges();
    fixture.componentRef.setInput('messageCount', 0);
    fixture.componentRef.setInput('uploadCount', 1);
    fixture.componentRef.setInput('unavailable', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('svg')).toBe(svg);
    expect(
      host.querySelector('app-task-count-group, app-flip-count'),
    ).toBeNull();
    expect(host.textContent?.trim()).toBe('');
    expect(host.offsetHeight).toBe(20);
    expect(svg?.classList.contains('unavailable')).toBe(false);
    expect(host.querySelector('.bio, .faces')).toBeNull();
  });
});
