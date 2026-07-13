import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from '../services/layout.service';
import { FitDialogDirective } from './fit-dialog.directive';

// zoneless project has no zone.js → fakeAsync/tick unavailable; use real timers + async/await waits.
// Bindings always go through signals: under zoneless dev mode, plain properties + manual detectChanges trigger NG0100.

const DESKTOP_Q = '(min-width: 1280px)';
const WIDE_Q = '(min-width: 768px)';

/** Build a minimal usable MediaQueryList (CDK MediaMatcher only reads .matches), matching layout.service.spec. */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

/** Fake ResizeObserver: captures the callback for tests to fire manually (simulating content size changes). */
let roCallback: (() => void) | undefined;
class FakeRO {
  constructor(cb: () => void) { roCallback = cb; }
  observe() {} unobserve() {} disconnect() {}
}
const RealRO = (window as any).ResizeObserver;

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

@Component({
  template: `<div [appFitDialog]="optsVal()"><div [style.height.px]="contentH()"></div></div>`,
  imports: [FitDialogDirective],
})
class HostComp {
  readonly optsVal = signal<FitDialogDirective['opts']>('');
  readonly contentH = signal(50);
}

describe('FitDialogDirective', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    spyOn(window as any, 'matchMedia').and.callFake(
      (q: string) => fakeMql(q, matches[q] ?? false),
    );
    (window as any).ResizeObserver = FakeRO;
    roCallback = undefined;
  });
  afterEach(() => {
    (window as any).ResizeObserver = RealRO;
    TestBed.resetTestingModule();
  });

  function create() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), LayoutService] });
    const fixture = TestBed.createComponent(HostComp);
    fixture.detectChanges(); // triggers directive ngOnInit → new ResizeObserver + observe
    return fixture;
  }
  function hostEl(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement.querySelector('div') as HTMLElement;
  }
  /** Fire one RO callback (simulating a content change) and wait past the settle debounce window (default 180ms). */
  async function fireAndSettle(ms = 180) {
    roCallback?.();
    await wait(ms + 60);
  }

  it('desktop sets minHeight floor on open, locks after settle (>= 200)', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    expect(hostEl(f).style.height).toBe('200px');     // ngOnInit sets the minHeight floor immediately, no auto jump
    await fireAndSettle();
    const h = parseInt(hostEl(f).style.height, 10);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(200);            // content only 50px → raised to min 200
  });

  it('caps to maxHeight (0.8·innerHeight) when content is very tall', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    f.componentInstance.contentH.set(99999);
    f.detectChanges();
    await fireAndSettle();
    const h = parseInt(hostEl(f).style.height, 10);
    expect(h).toBeLessThanOrEqual(Math.round(0.8 * window.innerHeight));
  });

  it('after lock, content changes do not recompute (locked)', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    await fireAndSettle();
    const locked = hostEl(f).style.height;
    expect(locked).not.toBe('');
    f.componentInstance.contentH.set(99999);            // content changes drastically
    f.detectChanges();
    await fireAndSettle();
    expect(hostEl(f).style.height).toBe(locked);        // height unchanged
  });

  it('mobile/tablet (non-desktop) is entirely no-op, sets no height', async () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = false;
    const f = create();
    await fireAndSettle();
    expect(hostEl(f).style.height).toBe('');
  });

  it('custom opts override default min/max', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    f.componentInstance.optsVal.set({ minHeight: 300, maxHeight: 400 });
    f.componentInstance.contentH.set(50);
    f.detectChanges();
    await fireAndSettle();
    expect(parseInt(hostEl(f).style.height, 10)).toBe(300); // content 50 → raised to min 300
  });
});
