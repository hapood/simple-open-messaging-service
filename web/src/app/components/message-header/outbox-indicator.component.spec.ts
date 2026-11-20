import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { OutboxIndicatorComponent } from './outbox-indicator.component';

describe('outbox indicator browser geometry', () => {
  it('settles rapid count changes without zero icons or leftover spacing', async () => {
    TestBed.configureTestingModule({ providers: [provideTransloco({
      config: { availableLangs: ['en'], defaultLang: 'en' }, loader: InlineTranslocoLoader,
    })] });
    const fixture = TestBed.createComponent(OutboxIndicatorComponent);
    const host: HTMLElement = fixture.nativeElement;
    fixture.componentRef.setInput('messageCount', 8);
    fixture.componentRef.setInput('uploadCount', 12);
    fixture.detectChanges();
    await fixture.whenStable();
    const groups = () => host.querySelectorAll<HTMLElement>('app-task-count-group');
    expect(groups()[0].offsetHeight).toBe(20);
    fixture.componentRef.setInput('messageCount', 3);
    fixture.detectChanges();
    fixture.componentRef.setInput('messageCount', 0);
    fixture.componentRef.setInput('uploadCount', 1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(groups()[0].querySelector('svg, app-flip-count')).toBeNull();
    await Promise.all(host.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
    expect(groups()[0].offsetWidth).toBe(0);
    expect(groups()[1].classList.contains('separated')).toBe(false);
    expect(groups()[1].querySelector('.current')?.textContent).toBe('1');
    expect(host.querySelector('.bio, .faces')).toBeNull();
    fixture.destroy();
  });
});
