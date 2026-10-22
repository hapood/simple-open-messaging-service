import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from './layout.service';

const MEDIUM_Q = '(min-width: 720px)';
const EXPANDED_Q = '(min-width: 1100px)';

/** Build a minimal MediaQueryList — CDK MediaMatcher only reads .matches. */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  } as unknown as MediaQueryList;
}

describe('LayoutService mode (3-way, width-only)', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    // CDK BreakpointObserver's initialValue flows MediaMatcher → window.matchMedia; stub it here to return
    // the desired matches per query, driving mode's initial computed value.
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
      fakeMql(q, matches[q] ?? false),
    );
  });
  afterEach(() => TestBed.resetTestingModule());

  function svc(): LayoutService {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), LayoutService],
    });
    return TestBed.inject(LayoutService);
  }

  it('≥1100px → expanded', () => {
    matches[MEDIUM_Q] = true;
    matches[EXPANDED_Q] = true;
    expect(svc().mode()).toBe('expanded');
  });

  it('720–1099px → medium', () => {
    matches[MEDIUM_Q] = true;
    matches[EXPANDED_Q] = false;
    expect(svc().mode()).toBe('medium');
  });

  it('<720px → compact', () => {
    matches[MEDIUM_Q] = false;
    matches[EXPANDED_Q] = false;
    expect(svc().mode()).toBe('compact');
  });

  it('expanded wins when both min-width queries match', () => {
    matches[MEDIUM_Q] = true;
    matches[EXPANDED_Q] = true;
    expect(svc().mode()).toBe('expanded');
  });

  it('a wide touch device is classified by width, not input modality', () => {
    matches[MEDIUM_Q] = true;
    matches[EXPANDED_Q] = true;
    expect(svc().mode()).toBe('expanded');
  });
});
