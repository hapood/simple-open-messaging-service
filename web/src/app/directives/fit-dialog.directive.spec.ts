import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LayoutService } from '../services/layout.service';
import { FitDialogDirective } from './fit-dialog.directive';

// zoneless 项目无 zone.js → fakeAsync/tick 不可用，改用真实定时器 + async/await 等待。
// 绑定一律走 signal：zoneless dev mode 下普通属性 + 手动 detectChanges 会触发 NG0100。

const DESKTOP_Q = '(min-width: 1280px)';
const WIDE_Q = '(min-width: 768px)';

/** 构造最小可用 MediaQueryList（CDK MediaMatcher 只读 .matches），与 layout.service.spec 一致。 */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

/** fake ResizeObserver：捕获回调供测试手动触发（模拟内容尺寸变化）。 */
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
    fixture.detectChanges(); // 触发指令 ngOnInit → new ResizeObserver + observe
    return fixture;
  }
  function hostEl(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement.querySelector('div') as HTMLElement;
  }
  /** 触发一次 RO 回调（模拟内容变化）并等过 settle 防抖窗口（默认 180ms）。 */
  async function fireAndSettle(ms = 180) {
    roCallback?.();
    await wait(ms + 60);
  }

  it('desktop 打开即设 minHeight 下限，settle 后锁定（不低于 200）', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    expect(hostEl(f).style.height).toBe('200px');     // ngOnInit 即设 minHeight 下限，无 auto 跳变
    await fireAndSettle();
    const h = parseInt(hostEl(f).style.height, 10);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(200);            // 内容仅 50px → 被 min 抬到 200
  });

  it('内容超高时封顶到 maxHeight(0.8·innerHeight)', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    f.componentInstance.contentH.set(99999);
    f.detectChanges();
    await fireAndSettle();
    const h = parseInt(hostEl(f).style.height, 10);
    expect(h).toBeLessThanOrEqual(Math.round(0.8 * window.innerHeight));
  });

  it('锁定后内容再变化也不重算（locked）', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    await fireAndSettle();
    const locked = hostEl(f).style.height;
    expect(locked).not.toBe('');
    f.componentInstance.contentH.set(99999);            // 内容剧变
    f.detectChanges();
    await fireAndSettle();
    expect(hostEl(f).style.height).toBe(locked);        // 高度不变
  });

  it('mobile/tablet（非 desktop）整体 no-op，不设高度', async () => {
    matches[DESKTOP_Q] = false; matches[WIDE_Q] = false;
    const f = create();
    await fireAndSettle();
    expect(hostEl(f).style.height).toBe('');
  });

  it('自定义 opts 覆盖默认 min/max', async () => {
    matches[DESKTOP_Q] = true; matches[WIDE_Q] = true;
    const f = create();
    f.componentInstance.optsVal.set({ minHeight: 300, maxHeight: 400 });
    f.componentInstance.contentH.set(50);
    f.detectChanges();
    await fireAndSettle();
    expect(parseInt(hostEl(f).style.height, 10)).toBe(300); // 内容 50 → 抬到 min 300
  });
});
