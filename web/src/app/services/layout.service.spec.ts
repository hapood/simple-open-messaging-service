import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from './layout.service';

const DESKTOP_Q = '(min-width: 1280px) and (pointer: fine) and (hover: hover)';
const WIDE_Q = '(min-width: 768px)';

/** 构造一个最小可用的 MediaQueryList（CDK MediaMatcher 只读 .matches） */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

describe('LayoutService mode 三档判定', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    // CDK BreakpointObserver 的 initialValue 经 MediaMatcher → window.matchMedia，
    // 在此打桩按 query 返回期望的 matches，从而驱动 mode 的初始 computed 值。
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

  it('宽屏 + 精确指针 + 悬停 → desktop（三栏）', () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('desktop');
  });

  it('≥768px 但触屏（iPad / 横屏手机，非 desktop）→ tablet（双栏）', () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('tablet');
  });

  it('横屏 iPad Pro 1366px 但 pointer:coarse → 不误判 desktop，落 tablet', () => {
    // DESKTOP_Q 含 pointer:fine+hover，触屏不匹配 → false；宽度 ≥768 → tablet
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = true;
    expect(svc().mode()).toBe('tablet');
  });

  it('窄屏手机 <768px → mobile（单栏）', () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = false;
    expect(svc().mode()).toBe('mobile');
  });
});
