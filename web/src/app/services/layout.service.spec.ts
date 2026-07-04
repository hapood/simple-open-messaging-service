import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from './layout.service';

const DESKTOP_Q = '(min-width: 1280px)';
const WIDE_Q = '(min-width: 768px)';

/** Build a minimal MediaQueryList — CDK MediaMatcher only reads .matches. */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

describe('LayoutService mode (width-only buckets)', () => {
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

  it('≥1280px → desktop (3-pane)', () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('desktop');
  });

  it('768–1279px → tablet (2-pane)', () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('tablet');
  });

  it('iPad Pro 1366px landscape is width-only now → desktop (NOT tablet)', () => {
    // DESKTOP_Q is pure width (≥1280px); a touch device at 1366px matches it. The pointer/hover clauses
    // were dropped when the input-modality axis moved to InputDeviceService.
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('desktop');
  });

  it('<768px phone → mobile (1-pane)', () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = false;
    expect(svc().mode()).toBe('mobile');
  });
});
