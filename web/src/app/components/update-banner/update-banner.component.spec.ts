import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { UpdateBannerComponent } from './update-banner.component';
import { UpdateService } from '../../services/update.service';
import { LanguageService } from '../../services/language.service';
import { IndicatorSlotService } from '../../services/indicator-slot.service';

/** Minimal UpdateService stub: just the surface the banner reads (`available`) + dismiss flips it back
 *  off, mirroring the real service. applyUpdate is a no-op (the real one reloads the page). */
function makeUpdateStub(): UpdateService {
  const available = signal(false);
  return {
    available,
    bannerVisible: available,
    applyUpdate: () => Promise.resolve(),
    dismiss: () => available.set(false),
  } as unknown as UpdateService;
}

/** Drive the banner and wait for zoneless CD + afterRenderEffect to settle. */
async function stabilize<T>(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown>}): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  // let Motion's enter spring run so afterRenderEffect's async work doesn't leak across tests
  await new Promise((r) => setTimeout(r, 60));
}

describe('UpdateBannerComponent (indicator-slot priority + queueing)', () => {
  let update: UpdateService;
  let slot: IndicatorSlotService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    update = makeUpdateStub();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [{ id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        LanguageService,
        IndicatorSlotService,
        { provide: UpdateService, useValue: update },
      ],
    });
    slot = TestBed.inject(IndicatorSlotService);
  });
  afterEach(() => TestBed.resetTestingModule());

  function create(): { nativeElement: HTMLElement; detectChanges: () => void; whenStable: () => Promise<unknown> } {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    return {
      nativeElement: fixture.nativeElement as HTMLElement,
      detectChanges: () => fixture.detectChanges(),
      whenStable: () => fixture.whenStable(),
    };
  }

  it('stays hidden when no update is available', async () => {
    const f = create();
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner')).toBeNull();
  });

  it('shows when an update is available and the connection chip is not occupying the slot', async () => {
    const f = create();
    update.available.set(true);
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner')).not.toBeNull();
  });

  it('defers while the connection chip occupies the slot (priority)', async () => {
    const f = create();
    update.available.set(true);
    slot.priorityOccupied.set(true); // the connection chip is showing
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner')).toBeNull();
  });

  it('surfaces once the connection chip clears the slot (when one is gone, the second shows)', async () => {
    const f = create();
    update.available.set(true);
    slot.priorityOccupied.set(true);
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner')).toBeNull();
    slot.priorityOccupied.set(false); // chip clears
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner')).not.toBeNull();
  });

  it('shares the .tonal-chip shell with the connection chip', async () => {
    const f = create();
    update.available.set(true);
    await stabilize(f);
    expect(f.nativeElement.querySelector('.banner.tonal-chip')).not.toBeNull();
  });

  // --- Demo contract (playground override; production leaves demoAvailable unset) ---

  it('demoAvailable=true overrides the service (surfaces even when the service has no update)', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    expect(update.available()).toBe(false); // service is idle
    fixture.componentRef.setInput('demoAvailable', true); // playground preview forces it on
    await stabilize({ detectChanges: () => fixture.detectChanges(), whenStable: () => fixture.whenStable() });
    expect(fixture.nativeElement.querySelector('.banner')).not.toBeNull();
  });

  it('demoAvailable=true still defers to the connection chip (the shared slot priority is unchanged)', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('demoAvailable', true);
    slot.priorityOccupied.set(true);
    await stabilize({ detectChanges: () => fixture.detectChanges(), whenStable: () => fixture.whenStable() });
    expect(fixture.nativeElement.querySelector('.banner')).toBeNull();
  });

  it('Dismiss in demo mode emits demoDismiss (production would call the service instead)', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('demoAvailable', true);
    let dismissed = 0;
    fixture.componentInstance.demoDismiss.subscribe(() => { dismissed++; });
    await stabilize({ detectChanges: () => fixture.detectChanges(), whenStable: () => fixture.whenStable() });
    (fixture.nativeElement.querySelector('.btn.ghost') as HTMLButtonElement).click();
    expect(dismissed).toBe(1);
    // The real service stays untouched in demo mode.
    expect(update.available()).toBe(false);
  });
});
