import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from './layout.service';

const DESKTOP_Q = '(min-width: 1024px)';

/** Build a minimal MediaQueryList — CDK MediaMatcher only reads .matches. */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

describe('LayoutService mode (2-way, width-only)', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    // CDK BreakpointObserver's initialValue flows MediaMatcher → window.matchMedia; stub it here to return
    // the desired matches per query, driving mode's initial computed value.
    spyOn(window as any, 'matchMedia').and.callFake((q: string) =>
      fakeMql(q, matches[q] ?? false));
  });
  afterEach(() => TestBed.resetTestingModule());

  function svc(): LayoutService {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), LayoutService],
    });
    return TestBed.inject(LayoutService);
  }

  it('≥1024px → desktop', () => {
    matches[DESKTOP_Q] = true;
    expect(svc().mode()).toBe('desktop');
  });

  it('<1024px phone → mobile', () => {
    matches[DESKTOP_Q] = false;
    expect(svc().mode()).toBe('mobile');
  });

  it('iPad Pro 1366px landscape is width-only → desktop (NOT mobile)', () => {
    // DESKTOP_Q is pure width (≥1024px); a touch device at 1366px matches it. The pointer/hover clauses
    // were dropped when the input-modality axis moved to InputDeviceService.
    matches[DESKTOP_Q] = true;
    expect(svc().mode()).toBe('desktop');
  });
});
