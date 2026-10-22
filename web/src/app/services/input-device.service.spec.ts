import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { InputDeviceService } from './input-device.service';

const FINE_POINTER_Q = '(pointer: fine) and (hover: hover)';

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

describe('InputDeviceService — input classes and Enter convention', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
      fakeMql(q, matches[q] ?? false),
    );
  });

  afterEach(() => TestBed.resetTestingModule());

  function svc(): InputDeviceService {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), InputDeviceService],
    });
    return TestBed.inject(InputDeviceService);
  }

  it('fine pointer (mouse/trackpad) → physical; Enter sends', () => {
    matches[FINE_POINTER_Q] = true;
    const s = svc();
    expect(s.inputClass()).toBe('physical');
    expect(s.hasPhysicalKeyboard()).toBe(true);
    expect(s.enterToSend()).toBe(true);
  });

  it('touch pointer → soft keyboard; Enter inserts a newline', () => {
    matches[FINE_POINTER_Q] = false;
    const s = svc();
    expect(s.inputClass()).toBe('soft');
    expect(s.hasPhysicalKeyboard()).toBe(false);
    expect(s.enterToSend()).toBe(false);
  });
});
