import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { MessageWindowSkeletonComponent } from './message-window-skeleton.component';
import { describe, expect, it } from 'vitest';
import {
  skeletonRowCount,
  SKELETON_ROW_HEIGHT,
  SKELETON_ROW_GAP,
} from './message-window-skeleton.component';

describe('window skeleton coverage', () => {
  it('fills a tall viewport from the bottom and keeps overflow above the clip', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
    const fixture = TestBed.createComponent(MessageWindowSkeletonComponent);
    const host: HTMLElement = fixture.nativeElement;
    host.style.position = 'relative';
    host.style.width = '400px';
    host.style.height = '1000px';
    host.style.setProperty('--soms-content-bottom-reserve', '80px');
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(host.querySelectorAll('.row').length).toBeGreaterThan(5),
    );
    const area = host.querySelector<HTMLElement>('.area')!;
    const rows = host.querySelector<HTMLElement>('.rows')!;
    expect(area.clientHeight).toBe(920);
    expect(rows.offsetTop + rows.offsetHeight).toBe(area.clientHeight);
    expect(rows.offsetTop).toBeLessThanOrEqual(0);
    expect(getComputedStyle(area).overflow).toBe('hidden');
    fixture.destroy();
  });

  it.each([0, 1, 64, 65, 600, 800, 1440, 2160])(
    'covers a %s-pixel viewport with only top overflow',
    (height) => {
      const count = skeletonRowCount(height);
      const coverage =
        count * SKELETON_ROW_HEIGHT + (count - 1) * SKELETON_ROW_GAP;
      expect(coverage).toBeGreaterThanOrEqual(height);
      expect(coverage - height).toBeLessThan(
        SKELETON_ROW_HEIGHT + SKELETON_ROW_GAP,
      );
    },
  );
});
